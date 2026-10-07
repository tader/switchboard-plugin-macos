import Foundation
import EventKit
import CoreFoundation

struct Failure: Error {
    let status: Int
    let code: String
    let message: String
}
func fail(_ status: Int, _ code: String, _ message: String) throws -> Never { throw Failure(status: status, code: code, message: message) }
let store = EKEventStore()
let iso = ISO8601DateFormatter()
iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
func parseDate(_ value: Any?, _ name: String) throws -> Date {
    guard let text = value as? String else { try fail(400, "invalid_date", "\(name) is required") }
    if let value = iso.date(from: text) { return value }
    let fallback = ISO8601DateFormatter()
    guard let value = fallback.date(from: text) else { try fail(400, "invalid_date", "\(name) must be an ISO 8601 date-time") }
    return value
}
func text(_ input: [String: Any], _ key: String, required: Bool = false) throws -> String? {
    guard let supplied = input[key], !(supplied is NSNull) else {
        if required { try fail(400, "invalid_input", "\(key) is required") }
        return nil
    }
    guard let value = supplied as? String, !required || !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { try fail(400, "invalid_input", "\(key) must be text") }
    return value
}
func requireAccess(_ request: Bool) throws {
    if #available(macOS 14.0, *) {
        if request && EKEventStore.authorizationStatus(for: .event) == .notDetermined {
            let semaphore = DispatchSemaphore(value: 0)
            var granted = false
            store.requestFullAccessToEvents { allowed, _ in granted = allowed; semaphore.signal() }
            semaphore.wait()
            guard granted else { try fail(403, "permission_denied", "Calendar full access was not granted") }
        }
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else { try fail(403, "permission_denied", "Grant Switchboard Apple Calendar full access in System Settings → Privacy & Security → Calendars") }
    } else { try fail(503, "unsupported_macos", "Apple Calendar requires macOS 14 or later") }
}
func calendar(_ id: String?, writable: Bool = false) throws -> EKCalendar {
    let value: EKCalendar?
    if let id { value = store.calendars(for: .event).first { $0.calendarIdentifier == id } }
    else { value = store.defaultCalendarForNewEvents }
    guard let value else { try fail(404, "calendar_not_found", "Calendar not found or no default calendar configured") }
    if writable && !value.allowsContentModifications { try fail(403, "read_only", "This calendar is read-only") }
    return value
}
func encoded(_ value: [String: Any]) throws -> String {
    try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}
func exclusiveEnd(_ event: EKEvent) -> Date {
    let end = event.endDate!
    guard event.isAllDay else { return end }
    var local = Calendar(identifier: .gregorian); local.timeZone = event.timeZone ?? .current
    let midnight = local.startOfDay(for: end)
    // EventKit can expose either an exclusive midnight or an inclusive 23:59:59.
    if abs(midnight.timeIntervalSince(end)) < 0.001 { return end }
    return local.date(byAdding: .day, value: 1, to: midnight)!
}
func eventJSON(_ event: EKEvent) throws -> [String: Any] {
    guard let nativeID = event.eventIdentifier, let start = event.startDate, event.endDate != nil else { try fail(502, "invalid_event", "EventKit returned an event without its identity or dates") }
    let end = exclusiveEnd(event)
    let target: [String: Any] = ["eventId": nativeID, "calendarId": event.calendar.calendarIdentifier, "startDate": iso.string(from: start)]
    var result: [String: Any] = ["id": try encoded(target), "calendarId": event.calendar.calendarIdentifier, "calendar": event.calendar.title, "title": event.title ?? "", "startDate": iso.string(from: start), "endDate": iso.string(from: end), "allDay": event.isAllDay, "timeZone": (event.timeZone ?? .current).identifier, "recurring": event.hasRecurrenceRules || event.isDetached || event.occurrenceDate != nil, "writable": event.calendar.allowsContentModifications]
    if let value = event.notes { result["notes"] = value }
    if let value = event.location { result["location"] = value }
    if let value = event.url { result["url"] = value.absoluteString }
    if let value = event.occurrenceDate { result["occurrenceDate"] = iso.string(from: value) }
    if let attendees = event.attendees { result["attendees"] = attendees.map { ["name": $0.name ?? "", "url": $0.url.absoluteString, "status": $0.participantStatus.rawValue] as [String: Any] } }
    return result
}
func exactEvent(_ input: [String: Any]) throws -> EKEvent {
    guard let target = input["target"] as? [String: Any] else { try fail(400, "invalid_id", "An exact event target is required") }
    let id = try text(target, "eventId", required: true)!
    let cal = try calendar(try text(target, "calendarId", required: true))
    let start = try parseDate(target["startDate"], "startDate")
    let matches = store.events(matching: store.predicateForEvents(withStart: start.addingTimeInterval(-1), end: start.addingTimeInterval(1), calendars: [cal])).filter { $0.eventIdentifier == id && abs($0.startDate.timeIntervalSince(start)) < 0.001 }
    guard matches.count == 1 else { try fail(404, "event_not_found", "Event identity is stale or ambiguous; list events again") }
    return matches[0]
}
func validateWritePolicy(writable: Bool, recurring: Bool, invited: Bool) throws {
    guard writable else { try fail(403, "read_only", "This calendar is read-only") }
    guard !recurring else { try fail(409, "recurring_read_only", "Recurring events and detached occurrences are read-only in this version") }
    guard !invited else { try fail(409, "invitation_read_only", "Events with attendees are read-only in this version") }
}
func requireMutable(_ event: EKEvent) throws {
    try validateWritePolicy(writable: event.calendar.allowsContentModifications, recurring: event.hasRecurrenceRules || event.isDetached || event.occurrenceDate != nil, invited: event.hasAttendees)
}
func apply(_ input: [String: Any], _ event: EKEvent, creating: Bool) throws {
    if let title = try text(input, "title", required: creating) { event.title = title }
    if let calID = try text(input, "calendarId") { event.calendar = try calendar(calID, writable: true) }
    for key in ["notes", "location"] where input.keys.contains(key) {
        let value = try text(input, key)
        if key == "notes" { event.notes = value } else { event.location = value }
    }
    if input.keys.contains("url") {
        if let value = try text(input, "url"), !value.isEmpty {
            guard let url = URL(string: value), ["http", "https"].contains(url.scheme ?? "") else { try fail(400, "invalid_url", "url must be HTTP or HTTPS") }
            event.url = url
        } else { event.url = nil }
    }
    var zone = event.timeZone ?? .current
    if let supplied = try text(input, "timeZone") {
        guard let resolved = TimeZone(identifier: supplied) else { try fail(400, "invalid_timezone", "Unknown IANA time zone") }
        zone = resolved
    }
    var allDay = event.isAllDay
    if let flag = input["allDay"] {
        guard let number = flag as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { try fail(400, "invalid_input", "allDay must be boolean") }
        allDay = number.boolValue
    }
    let start = creating || input.keys.contains("startDate") ? try parseDate(input["startDate"], "startDate") : event.startDate!
    let end = creating || input.keys.contains("endDate") ? try parseDate(input["endDate"], "endDate") : exclusiveEnd(event)
    guard end > start else { try fail(400, "invalid_dates", "endDate must be after startDate") }
    if allDay {
        guard zone.identifier == TimeZone.current.identifier else { try fail(400, "floating_all_day", "EventKit all-day events are floating in this Mac's local time zone. Omit timeZone or use \(TimeZone.current.identifier)") }
        var local = Calendar(identifier: .gregorian); local.timeZone = .current
        guard abs(local.startOfDay(for: start).timeIntervalSince(start)) < 0.001, abs(local.startOfDay(for: end).timeIntervalSince(end)) < 0.001 else { try fail(400, "invalid_all_day", "All-day start and exclusive end must be midnight in the event time zone") }
    }
    // All-day events must have a nil (floating) native zone. Assigning a zone
    // after allDay silently changes EventKit's all-day flag back to false.
    event.timeZone = zone; event.isAllDay = allDay; event.startDate = start
    event.endDate = allDay ? end.addingTimeInterval(-1) : end
}
func page(_ items: [[String: Any]], _ input: [String: Any]) -> [String: Any] {
    let offset = max(0, min(input["offset"] as? Int ?? 0, items.count))
    let end = min(offset + max(1, min(input["limit"] as? Int ?? 100, 100)), items.count)
    var result: [String: Any] = ["items": Array(items[offset..<end])]
    if end < items.count { result["nextOffset"] = end }
    return result
}
func run(_ input: [String: Any]) throws -> (Int, [String: Any]) {
    let operation = try text(input, "operation", required: true)!
    try requireAccess(operation == "authorize")
    switch operation {
    case "authorize": return (200, ["authorized": true])
    case "calendars":
        let values = store.calendars(for: .event).map { ["id": $0.calendarIdentifier, "title": $0.title, "source": $0.source.title, "writable": $0.allowsContentModifications, "default": $0.calendarIdentifier == store.defaultCalendarForNewEvents?.calendarIdentifier] as [String: Any] }.sorted { ($0["title"] as! String, $0["id"] as! String) < ($1["title"] as! String, $1["id"] as! String) }
        return (200, page(values, input))
    case "events":
        let start = try parseDate(input["startDate"], "startDate"), end = try parseDate(input["endDate"], "endDate")
        guard end > start && end.timeIntervalSince(start) <= 366 * 86400 else { try fail(400, "invalid_range", "Event range must be positive and at most 366 days") }
        let calendars: [EKCalendar]?
        if let id = try text(input, "calendarId") { calendars = [try calendar(id)] } else { calendars = nil }
        let search = try text(input, "query")
        let values = try store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: calendars)).filter { event in
            search == nil || [event.title, event.notes, event.location].compactMap { $0 }.contains { $0.localizedCaseInsensitiveContains(search!) }
        }.sorted { ($0.startDate!, $0.eventIdentifier ?? "") < ($1.startDate!, $1.eventIdentifier ?? "") }.map(eventJSON)
        return (200, page(values, input))
    case "get": return (200, try eventJSON(exactEvent(input)))
    case "create":
        let event = EKEvent(eventStore: store); event.calendar = try calendar(try text(input, "calendarId"), writable: true)
        try apply(input, event, creating: true); try store.save(event, span: .thisEvent, commit: true)
        return (201, try eventJSON(event))
    case "update":
        let event = try exactEvent(input); try requireMutable(event); try apply(input, event, creating: false)
        try store.save(event, span: .thisEvent, commit: true); return (200, try eventJSON(event))
    case "delete":
        let event = try exactEvent(input); try requireMutable(event); try store.remove(event, span: .thisEvent, commit: true)
        return (200, ["deleted": true])
    default: try fail(400, "unknown_operation", "Unknown Calendar operation")
    }
}
do {
    guard let input = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as? [String: Any] else { try fail(400, "invalid_input", "Expected a JSON object") }
    let (status, body) = try run(input)
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: ["status": status, "body": body], options: [.sortedKeys]))
} catch {
    let value = error as? Failure
    let result: [String: Any] = ["status": value?.status ?? 500, "body": ["error": ["code": value?.code ?? "eventkit_error", "message": value?.message ?? String(describing: error)]]]
    if let data = try? JSONSerialization.data(withJSONObject: result) { FileHandle.standardOutput.write(data) }
}
