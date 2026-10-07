import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('Native EventKit date handling covers DST, null clearing and recurrence rules and explicit mutation scopes', { skip: process.platform !== 'darwin' }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'calendar-native-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const source = await fs.readFile(new URL('../plugins/apple-calendar/helper.swift', import.meta.url), 'utf8');
  const prefix = source.slice(0, source.lastIndexOf('\ndo {\n'));
  const suite = `
func check(_ condition: @autoclosure () -> Bool, _ message: String) { if !condition() { fatalError(message) } }
do {
    let event = EKEvent(eventStore: store)
    let cal = EKCalendar(for: .event, eventStore: store)
    event.calendar = cal
    let dstStart = try parseDate("2026-03-29T00:00:00+01:00", "start")
    let dstEnd = try parseDate("2026-03-30T00:00:00+02:00", "end")
    check(dstEnd.timeIntervalSince(dstStart) == 23 * 3600, "ISO dates lost DST offsets")
    var local = Calendar(identifier: .gregorian); local.timeZone = .current
    let start = local.startOfDay(for: dstStart.addingTimeInterval(3600))
    let end = local.date(byAdding: .day, value: 1, to: start)!
    try apply(["title": "DST fixture", "startDate": iso.string(from: start), "endDate": iso.string(from: end), "allDay": true], event, creating: true)
    check(event.isAllDay && event.timeZone == nil, "All-day flag or floating zone was changed")
    check(exclusiveEnd(event) == end, "Exclusive all-day end date changed")
    event.notes = "Old notes"; event.location = "Old location"; event.url = URL(string: "https://example.test")
    try apply(["notes": NSNull(), "location": NSNull(), "url": NSNull()], event, creating: false)
    check(event.notes == nil && event.location == nil && event.url == nil, "Null fields were not cleared")
    do { try apply(["startDate": iso.string(from: start.addingTimeInterval(3600))], event, creating: false); fatalError("Accepted non-midnight all-day event") } catch let error as Failure { check(error.code == "invalid_all_day", "Unexpected all-day error") }
    event.isAllDay = false
    do { try apply(["endDate": "2026-03-28T00:00:00Z"], event, creating: false); fatalError("Accepted end before start") } catch let error as Failure { check(error.code == "invalid_dates", "Unexpected date-order error") }
    let weekly = try recurrenceRule(["frequency": "weekly", "interval": 2, "daysOfTheWeek": [["dayOfTheWeek": 2], ["dayOfTheWeek": 4]], "end": ["count": 8]], start: start)
    check(weekly.frequency == .weekly && weekly.interval == 2 && weekly.daysOfTheWeek!.count == 2 && weekly.recurrenceEnd!.occurrenceCount == 8, "Weekly rule lost its fields")
    let monthly = try recurrenceRule(["frequency": "monthly", "daysOfTheWeek": [["dayOfTheWeek": 6, "weekNumber": -1]], "end": ["date": "2027-01-01T00:00:00Z"]], start: start)
    check(monthly.daysOfTheWeek!.first!.weekNumber == -1 && monthly.recurrenceEnd!.endDate != nil, "Ordinal weekday/end date changed")
    let yearly = try recurrenceRule(["frequency": "yearly", "monthsOfTheYear": [3, 10], "daysOfTheWeek": [["dayOfTheWeek": 2]], "setPositions": [-1]], start: start)
    check(yearly.monthsOfTheYear!.count == 2 && yearly.setPositions!.first!.intValue == -1, "Yearly filters changed")
    event.recurrenceRules = [weekly]
    try apply(["title": "Preserved series"], event, creating: false)
    check(event.recurrenceRules!.first!.interval == 2, "Omitted recurrence was changed")
    try apply(["recurrence": NSNull()], event, creating: false)
    check(!event.hasRecurrenceRules, "Recurrence was not removed")
    try apply(["recurrence": ["frequency": "monthly", "daysOfTheMonth": [1, -1]]], event, creating: false)
    check(event.recurrenceRules!.first!.daysOfTheMonth!.count == 2, "Recurrence was not replaced")
    let output = recurrenceJSON(yearly)
    check((output["frequency"] as? String) == "yearly" && output["setPositions"] != nil, "Recurrence serialization lost fields")
    for invalid: [String: Any] in [
        ["frequency": "daily", "daysOfTheWeek": [["dayOfTheWeek": 2]]],
        ["frequency": "weekly", "daysOfTheWeek": [["dayOfTheWeek": 2, "weekNumber": 1]]],
        ["frequency": "monthly", "daysOfTheWeek": [["dayOfTheWeek": 2, "weekNumber": 6]]],
        ["frequency": "yearly", "monthsOfTheYear": [0]],
        ["frequency": "daily", "interval": true],
        ["frequency": "daily", "interval": 1.5],
        ["frequency": "monthly", "daysOfTheMonth": [1, 1]],
        ["frequency": "daily", "end": ["count": 0]],
        ["frequency": "daily", "end": ["count": 2, "date": "2027-01-01T00:00:00Z"]],
        ["frequency": "daily", "end": ["date": "2020-01-01T00:00:00Z"]]
    ] {
        do { _ = try recurrenceRule(invalid, start: start); fatalError("Accepted invalid recurrence") } catch let error as Failure { check(error.status == 400, "Unexpected recurrence validation error") }
    }
    let singleSpan = try mutationSpan(["span": "thisEvent"], recurring: true, detached: true)
    check(singleSpan == .thisEvent, "Detached single-occurrence scope failed")
    let futureSpan = try mutationSpan(["span": "futureEvents", "recurrence": NSNull()], recurring: true, detached: false)
    check(futureSpan == .futureEvents, "Future scope failed")
    for (input, recurring, detached, code): ([String: Any], Bool, Bool, String) in [
        ([:], true, false, "recurrence_scope_required"),
        (["span": "futureEvents"], true, true, "invalid_series_scope"),
        (["span": "futureEvents"], false, false, "invalid_series_scope"),
        (["span": "thisEvent", "recurrence": NSNull()], true, false, "recurrence_scope_conflict"),
        (["span": "allEvents"], true, false, "invalid_span")
    ] {
        do { _ = try mutationSpan(input, recurring: recurring, detached: detached); fatalError("Accepted unsafe mutation scope") } catch let error as Failure { check(error.code == code, "Unexpected scope error") }
    }
    do { try validateWritePolicy(writable: false, invited: false); fatalError("Accepted read-only policy") } catch let error as Failure { check(error.code == "read_only", "Read-only policy did not reject") }
    do { try validateWritePolicy(writable: true, invited: true); fatalError("Accepted invitation write") } catch let error as Failure { check(error.code == "invitation_read_only", "Invitation policy did not reject") }
    print("Native EventKit DST, nullable fields, date ordering, recurrence and mutation scopes passed. No data was saved.")
} catch { fatalError(String(describing: error)) }
`;
  const file = path.join(temporary, 'test.swift'); await fs.writeFile(file, prefix + suite);
  const result = await new Promise(resolve => {
    const child = spawn('/usr/bin/swift', ['-module-cache-path', path.join(temporary, 'module-cache'), file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; }); child.on('error', error => resolve({ code: -1, output: error.message })); child.on('exit', code => resolve({ code, output }));
  });
  assert.equal(result.code, 0, result.output); assert.match(result.output, /No data was saved/);
});
