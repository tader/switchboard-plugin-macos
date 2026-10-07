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
let recurrenceFrequencies: [String: EKRecurrenceFrequency] = ["daily": .daily, "weekly": .weekly, "monthly": .monthly, "yearly": .yearly]
func integer(_ value: Any?, _ name: String, min: Int, max: Int, nonzero: Bool = false) throws -> Int {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
          number.doubleValue >= Double(min), number.doubleValue <= Double(max), number.doubleValue.rounded() == number.doubleValue,
          !nonzero || number.intValue != 0 else { try fail(400, "invalid_recurrence", "\(name) must be an integer from \(min) to \(max)\(nonzero ? ", excluding zero" : "")") }
    return number.intValue
}
func recurrenceRule(_ value: Any, start: Date) throws -> EKRecurrenceRule {
    guard let input = value as? [String: Any], Set(input.keys).isSubset(of: ["frequency", "interval", "daysOfTheWeek", "daysOfTheMonth", "monthsOfTheYear", "weeksOfTheYear", "daysOfTheYear", "setPositions", "end"]),
          let name = input["frequency"] as? String, let frequency = recurrenceFrequencies[name] else { try fail(400, "invalid_recurrence", "Expected a supported recurrence rule") }
    let interval = try integer(input["interval"] ?? 1, "interval", min: 1, max: 1000)
    var days: [EKRecurrenceDayOfWeek]?
    if let supplied = input["daysOfTheWeek"] {
        guard name != "daily", let list = supplied as? [[String: Any]], !list.isEmpty, list.count <= 366 else { try fail(400, "invalid_recurrence", "daysOfTheWeek requires a non-daily frequency and a nonempty bounded array") }
        var seen = Set<String>()
        days = try list.map { day in
            guard Set(day.keys).isSubset(of: ["dayOfTheWeek", "weekNumber"]) else { try fail(400, "invalid_recurrence", "Unknown weekday field") }
            let weekday = try integer(day["dayOfTheWeek"], "dayOfTheWeek", min: 1, max: 7)
            let bound = name == "weekly" ? 0 : name == "monthly" ? 5 : 53
            let week = try integer(day["weekNumber"] ?? 0, "weekNumber", min: -bound, max: bound)
            guard seen.insert("\(weekday):\(week)").inserted else { try fail(400, "invalid_recurrence", "Duplicate weekday") }
            return EKRecurrenceDayOfWeek(dayOfTheWeek: EKWeekday(rawValue: weekday)!, weekNumber: week)
        }
    }
    func numbers(_ key: String, _ bound: Int, frequency required: String? = nil) throws -> [NSNumber]? {
        guard let supplied = input[key] else { return nil }
        guard required == nil || name == required else { try fail(400, "invalid_recurrence", "\(key) requires \(required!) recurrence") }
        guard let list = supplied as? [Any], !list.isEmpty, list.count <= bound * 2 else { try fail(400, "invalid_recurrence", "\(key) must be a nonempty bounded array") }
        let values = try list.map { try integer($0, key, min: key == "monthsOfTheYear" ? 1 : -bound, max: bound, nonzero: true) }
        guard Set(values).count == values.count else { try fail(400, "invalid_recurrence", "Duplicate \(key) value") }
        return values.map { NSNumber(value: $0) }
    }
    let monthDays = try numbers("daysOfTheMonth", 31, frequency: "monthly")
    let months = try numbers("monthsOfTheYear", 12, frequency: "yearly")
    let weeks = try numbers("weeksOfTheYear", 53, frequency: "yearly")
    let yearDays = try numbers("daysOfTheYear", 366, frequency: "yearly")
    let positions = try numbers("setPositions", 366)
    guard positions == nil || days != nil || monthDays != nil || months != nil || weeks != nil || yearDays != nil else { try fail(400, "invalid_recurrence", "setPositions requires another recurrence filter") }
    var end: EKRecurrenceEnd?
    if let supplied = input["end"], !(supplied is NSNull) {
        guard let limit = supplied as? [String: Any], limit.count == 1 else { try fail(400, "invalid_recurrence", "end requires exactly one of date or count") }
        if let date = limit["date"] {
            let until = try parseDate(date, "recurrence.end.date")
            guard until >= start else { try fail(400, "invalid_recurrence", "Recurrence end must not precede event start") }
            end = EKRecurrenceEnd(end: until)
        } else if let count = limit["count"] { end = EKRecurrenceEnd(occurrenceCount: try integer(count, "count", min: 1, max: 100000)) }
        else { try fail(400, "invalid_recurrence", "end requires date or count") }
    }
    return EKRecurrenceRule(recurrenceWith: frequency, interval: interval, daysOfTheWeek: days, daysOfTheMonth: monthDays, monthsOfTheYear: months, weeksOfTheYear: weeks, daysOfTheYear: yearDays, setPositions: positions, end: end)
}
func recurrenceJSON(_ rule: EKRecurrenceRule) -> [String: Any] {
    var result: [String: Any] = ["frequency": recurrenceFrequencies.first { $0.value == rule.frequency }?.key ?? "unknown", "interval": rule.interval, "firstDayOfTheWeek": rule.firstDayOfTheWeek, "calendarIdentifier": rule.calendarIdentifier]
    if let days = rule.daysOfTheWeek { result["daysOfTheWeek"] = days.map { ["dayOfTheWeek": $0.dayOfTheWeek.rawValue, "weekNumber": $0.weekNumber] } }
    for (key, values) in [("daysOfTheMonth", rule.daysOfTheMonth), ("monthsOfTheYear", rule.monthsOfTheYear), ("weeksOfTheYear", rule.weeksOfTheYear), ("daysOfTheYear", rule.daysOfTheYear), ("setPositions", rule.setPositions)] { if let values { result[key] = values } }
    if let end = rule.recurrenceEnd {
        if let date = end.endDate { result["end"] = ["date": iso.string(from: date)] }
        else { result["end"] = ["count": end.occurrenceCount] }
    }
    return result
}
func isRecurring(_ event: EKEvent) -> Bool { event.hasRecurrenceRules || event.isDetached || event.occurrenceDate != nil }
func mutationSpan(_ input: [String: Any], recurring: Bool, detached: Bool) throws -> EKSpan {
    let supplied = try text(input, "span")
    guard !recurring || supplied != nil else { try fail(409, "recurrence_scope_required", "Specify span=thisEvent or futureEvents for a recurring occurrence") }
    guard supplied == nil || supplied == "thisEvent" || supplied == "futureEvents" else { try fail(400, "invalid_span", "span must be thisEvent or futureEvents") }
    if supplied == "futureEvents" {
        guard recurring && !detached else { try fail(409, "invalid_series_scope", "futureEvents requires a non-detached recurring occurrence; list the series again") }
        return .futureEvents
    }
    if recurring && input.keys.contains("recurrence") { try fail(409, "recurrence_scope_conflict", "Changing recurrence requires futureEvents; use a non-detached series occurrence") }
    return .thisEvent
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
func participantStatusName(_ status: EKParticipantStatus) -> String {
    switch status {
    case .unknown: return "unknown"
    case .pending: return "pending"
    case .accepted: return "accepted"
    case .declined: return "declined"
    case .tentative: return "tentative"
    case .delegated: return "delegated"
    case .completed: return "completed"
    case .inProcess: return "inProcess"
    @unknown default: return "unknown"
    }
}
func eventJSON(_ event: EKEvent) throws -> [String: Any] {
    guard let nativeID = event.eventIdentifier, let start = event.startDate, event.endDate != nil else { try fail(502, "invalid_event", "EventKit returned an event without its identity or dates") }
    let end = exclusiveEnd(event)
    let target: [String: Any] = ["eventId": nativeID, "calendarId": event.calendar.calendarIdentifier, "startDate": iso.string(from: start)]
    var result: [String: Any] = ["id": try encoded(target), "calendarId": event.calendar.calendarIdentifier, "calendar": event.calendar.title, "title": event.title ?? "", "startDate": iso.string(from: start), "endDate": iso.string(from: end), "allDay": event.isAllDay, "timeZone": (event.timeZone ?? .current).identifier, "recurring": isRecurring(event), "detached": event.isDetached, "recurrenceRules": (event.recurrenceRules ?? []).map(recurrenceJSON), "writable": event.calendar.allowsContentModifications && !event.hasAttendees, "calendarWritable": event.calendar.allowsContentModifications]
    if let value = event.notes { result["notes"] = value }
    if let value = event.location { result["location"] = value }
    if let value = event.url { result["url"] = value.absoluteString }
    if let value = event.occurrenceDate { result["occurrenceDate"] = iso.string(from: value) }
    if let attendees = event.attendees { result["attendees"] = attendees.map { ["name": $0.name ?? "", "url": $0.url.absoluteString, "status": $0.participantStatus.rawValue, "statusName": participantStatusName($0.participantStatus), "currentUser": $0.isCurrentUser] as [String: Any] } }
    if let current = event.attendees?.first(where: { $0.isCurrentUser }) { result["participationStatus"] = current.participantStatus.rawValue; result["participationStatusName"] = participantStatusName(current.participantStatus) }
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
func validateWritePolicy(writable: Bool, invited: Bool) throws {
    guard writable else { try fail(403, "read_only", "This calendar is read-only") }
    guard !invited else { try fail(409, "invitation_read_only", "Events with attendees require Calendar for changes or invitation responses") }
}
func requireMutable(_ event: EKEvent) throws {
    try validateWritePolicy(writable: event.calendar.allowsContentModifications, invited: event.hasAttendees)
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
    if let supplied = input["recurrence"] { event.recurrenceRules = supplied is NSNull ? nil : [try recurrenceRule(supplied, start: start)] }
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
        let event = try exactEvent(input); try requireMutable(event)
        let span = try mutationSpan(input, recurring: isRecurring(event), detached: event.isDetached)
        try apply(input, event, creating: false)
        try store.save(event, span: span, commit: true); return (200, try eventJSON(event))
    case "delete":
        let event = try exactEvent(input); try requireMutable(event)
        let span = try mutationSpan(input, recurring: isRecurring(event), detached: event.isDetached)
        try store.remove(event, span: span, commit: true)
        return (200, ["deleted": true, "span": span == .futureEvents ? "futureEvents" : "thisEvent"])
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
