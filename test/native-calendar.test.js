import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('Native EventKit date handling covers DST, null clearing and recurring-write rejection', { skip: process.platform !== 'darwin' }, async t => {
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
    event.recurrenceRules = [EKRecurrenceRule(recurrenceWith: .daily, interval: 1, end: nil)]
    do { try requireMutable(event); fatalError("Accepted recurring write") } catch let error as Failure { check(error.code == "recurring_read_only" || error.code == "read_only", "Unexpected recurring-write error") }
    do { try validateWritePolicy(writable: true, recurring: true, invited: false); fatalError("Accepted recurring policy") } catch let error as Failure { check(error.code == "recurring_read_only", "Recurring policy did not reject") }
    do { try validateWritePolicy(writable: false, recurring: false, invited: false); fatalError("Accepted read-only policy") } catch let error as Failure { check(error.code == "read_only", "Read-only policy did not reject") }
    do { try validateWritePolicy(writable: true, recurring: false, invited: true); fatalError("Accepted invitation write") } catch let error as Failure { check(error.code == "invitation_read_only", "Invitation policy did not reject") }
    print("Native EventKit DST, nullable fields, date ordering and recurring write guard passed. No data was saved.")
} catch { fatalError(String(describing: error)) }
`;
  const file = path.join(temporary, 'test.swift'); await fs.writeFile(file, prefix + suite);
  const result = await new Promise(resolve => {
    const child = spawn('/usr/bin/swift', ['-module-cache-path', path.join(temporary, 'module-cache'), file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; }); child.on('error', error => resolve({ code: -1, output: error.message })); child.on('exit', code => resolve({ code, output }));
  });
  assert.equal(result.code, 0, result.output); assert.match(result.output, /No data was saved/);
});
