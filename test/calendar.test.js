import test from 'node:test';
import assert from 'node:assert/strict';
import { eventInput, eventTarget, route } from '../plugins/apple-calendar/index.js';
import { opaque } from '../shared/runtime.js';
const scope = { local: true };
test('Calendar validates event fields and accepts a DST all-day window', () => {
  const input = eventInput({ title: 'DST day', startDate: '2026-03-29T00:00:00+01:00', endDate: '2026-03-30T00:00:00+02:00', allDay: true, timeZone: 'Europe/Amsterdam', idempotencyKey: 'fixture-calendar-1' }, true);
  assert.equal(Date.parse(input.endDate) - Date.parse(input.startDate), 23 * 3600000);
  assert.deepEqual(eventInput({ notes: null, location: null, url: null }), { notes: null, location: null, url: null });
  assert.throws(() => eventInput({ startDate: '2026-10-07T12:00:00Z', endDate: '2026-10-07T11:00:00Z' }), /after startDate/);
  assert.throws(() => eventInput({ startDate: '2026-02-30T12:00:00Z' }), /invalid calendar date/);
  assert.throws(() => eventInput({ startDate: '2026-10-07T12:00:00' }), /explicit time zone/);
  assert.throws(() => eventInput({ timeZone: 'Imaginary/Nowhere' }), /valid IANA/);
  assert.throws(() => eventInput({ allDay: 'true' }), /true or false/);
  assert.throws(() => eventInput({ attendees: ['a@example.test'] }), /Accepted fields/);
  assert.throws(() => eventInput({ recurrence: {} }), /frequency/);
});
test('Calendar listings require a positive bounded date range', () => {
  assert.throws(() => route('GET', new URL('http://local/events'), undefined, scope), /startDate/);
  assert.throws(() => route('GET', new URL('http://local/events?startDate=2026-01-01T00:00:00Z&endDate=2028-01-01T00:00:00Z'), undefined, scope), /366 days/);
  const value = route('GET', new URL('http://local/events?startDate=2026-10-07T00:00:00Z&endDate=2026-10-08T00:00:00Z&calendarId=local&query=review&pageSize=3'), undefined, scope);
  assert.equal(value.input.limit, 3); assert.equal(value.input.calendarId, 'local'); assert.equal(value.input.query, 'review');
});
test('Calendar exact occurrence IDs include calendar identity and original start', () => {
  const target = { eventId: 'native', calendarId: 'calendar-a', startDate: '2026-10-07T12:00:00Z' }, id = opaque(target);
  assert.deepEqual(eventTarget(id), target);
  const value = route('PATCH', new URL(`http://local/events/${id}`), { title: 'Changed' }, scope);
  assert.deepEqual(value.input.target, target); assert.equal(value.input.operation, 'update');
  assert.throws(() => eventTarget(opaque({ eventId: 'native' })), /calendarId/);
  assert.throws(() => eventTarget(opaque({ ...target, span: 'futureEvents' })), /Accepted fields/);
});

test('Calendar recurrence authoring validates frequency, ordinals, filters and end conditions', () => {
  assert.deepEqual(eventInput({ recurrence: { frequency: 'weekly', daysOfTheWeek: [{ dayOfTheWeek: 2 }, { dayOfTheWeek: 4 }], end: { count: 10 } } }).recurrence, { frequency: 'weekly', interval: 1, daysOfTheWeek: [{ dayOfTheWeek: 2, weekNumber: 0 }, { dayOfTheWeek: 4, weekNumber: 0 }], end: { count: 10 } });
  assert.equal(eventInput({ recurrence: null }).recurrence, null);
  for (const recurrence of [
    { frequency: 'hourly' }, { frequency: 'daily', interval: 0 }, { frequency: 'daily', interval: true },
    { frequency: 'daily', daysOfTheWeek: [{ dayOfTheWeek: 2 }] },
    { frequency: 'weekly', daysOfTheWeek: [{ dayOfTheWeek: 2, weekNumber: 1 }] },
    { frequency: 'monthly', daysOfTheWeek: [{ dayOfTheWeek: 2, weekNumber: 6 }] },
    { frequency: 'monthly', daysOfTheMonth: [0] }, { frequency: 'monthly', daysOfTheMonth: [1, 1] },
    { frequency: 'weekly', monthsOfTheYear: [3] }, { frequency: 'yearly', monthsOfTheYear: [13] },
    { frequency: 'monthly', setPositions: [-1] }, { frequency: 'daily', end: {} },
    { frequency: 'daily', end: { count: 0 } }, { frequency: 'daily', end: { count: 2, date: '2027-01-01T00:00:00Z' } },
  ]) assert.throws(() => eventInput({ recurrence }), undefined, JSON.stringify(recurrence));
  assert.throws(() => eventInput({ startDate: '2026-10-07T00:00:00Z', recurrence: { frequency: 'daily', end: { date: '2026-10-06T00:00:00Z' } } }), /precede/);
  assert.equal(eventInput({ recurrence: { frequency: 'monthly', daysOfTheWeek: [{ dayOfTheWeek: 6, weekNumber: -1 }] } }).recurrence.daysOfTheWeek[0].weekNumber, -1);
});
test('Calendar recurring update/delete scopes reach the native helper with the exact occurrence', () => {
  const id = opaque({ eventId: 'series', calendarId: 'calendar-a', startDate: '2026-10-07T12:00:00Z' });
  const update = route('PATCH', new URL(`http://local/events/${id}`), { title: 'Future title', span: 'futureEvents' }, scope);
  assert.equal(update.input.span, 'futureEvents');
  const deletion = route('DELETE', new URL(`http://local/events/${id}?span=thisEvent`), undefined, scope);
  assert.equal(deletion.input.span, 'thisEvent');
  assert.equal(deletion.input.target.eventId, 'series');
  assert.throws(() => route('DELETE', new URL(`http://local/events/${id}?span=allEvents`), undefined, scope), /span/);
  assert.throws(() => eventInput({ title: 'Test', span: 'allEvents' }), /span/);
  assert.throws(() => eventInput({ span: 'thisEvent' }), /at least one event field/);
  assert.throws(() => eventInput({ title: 'Test', startDate: '2026-10-07T12:00:00Z', endDate: '2026-10-07T13:00:00Z', span: 'futureEvents' }, true), /Accepted fields/);
});
