---
title: Apple Calendar
services: [apple-calendar]
---

# Apple Calendar

Connect with **This Mac** to use calendars belonging to the logged-in macOS user running Switchboard. Install on a Mac satellite when the main server runs elsewhere. Requirements: macOS 14+, Node 24+ and Xcode Command Line Tools. The first connection requests **full** calendar access; write-only access cannot support event reads or deletion. If denied, grant full access to **Switchboard Apple Calendar** in **System Settings → Privacy & Security → Calendars**. Use a per-user session, not a system daemon.

## Read

- `listAppleCalendars` (`GET /calendars`) returns calendar IDs, names, sources, default status and `writable` flags.
- `listAppleCalendarEvents` (`GET /events`) requires `startDate` and `endDate` with explicit ISO 8601 time zones. The positive range must not exceed 366 days. Optional `calendarId` and `query` restrict results; query matches title, notes or location.
- `getAppleCalendarEvent` (`GET /events/{id}`) reads one exact occurrence using the opaque ID returned by listing.

Lists use `pageSize` (1–100, default 100) and an `items` array. Follow `nextToken` with the same parameters until absent. EventKit expands recurring occurrences within the requested range. Pagination is over current results, not a snapshot; changes can alter ordering. Event IDs bind native ID, calendar and exact start; moving or rescheduling an event can invalidate the old ID.

## Create, update and delete

`createAppleCalendarEvent` (`POST /events`) accepts:

```json
{
  "title": "Focus time",
  "calendarId": "<calendar ID>",
  "startDate": "2026-10-08T09:00:00+02:00",
  "endDate": "2026-10-08T10:00:00+02:00",
  "timeZone": "Europe/Amsterdam",
  "notes": "Review the proposal",
  "idempotencyKey": "focus-2026-10-08-0001"
}
```

Omit `calendarId` to use the default writable calendar. `title`, `startDate`, `endDate` and `idempotencyKey` are required. Optional fields are `allDay`, `timeZone`, `notes`, `location`, an HTTP/HTTPS `url` and `recurrence`. The end must follow the start. Event creation uses a durable idempotency ledger; reuse the same key and payload for retries. An uncertain create is not repeated automatically; inspect Calendar before trying another key.

`updateAppleCalendarEvent` (`PATCH /events/{id}`) accepts the same event fields without `idempotencyKey`; omitted fields remain unchanged. Set notes, location or URL to `null` to clear. The response contains the refreshed event ID. `deleteAppleCalendarEvent` (`DELETE /events/{id}`) deletes that exact event; recurring events require the scope described below.

All-day start and exclusive end must be midnight in the Mac's local time zone. An event spanning one day ends at the next day's midnight, including 23- or 25-hour DST days. EventKit all-day dates are floating; omit `timeZone` or use this Mac's zone. Timed events support other IANA zones. The adapter normalizes EventKit's inclusive end-of-day representation to an exclusive API end date.

## Recurring events

Add a `recurrence` object when creating a series. For example, every other Monday and Wednesday for ten occurrences:

```json
{
  "frequency": "weekly",
  "interval": 2,
  "daysOfTheWeek": [{ "dayOfTheWeek": 2 }, { "dayOfTheWeek": 4 }],
  "end": { "count": 10 }
}
```

`frequency` is `daily`, `weekly`, `monthly` or `yearly`; `interval` defaults to 1 (maximum 1000). Weekdays use Sunday=1 through Saturday=7. Monthly/yearly weekdays may include `weekNumber`, such as `{"dayOfTheWeek":6,"weekNumber":-1}` for the last Friday; 0 means every matching weekday. Monthly ordinals are limited to ±5 and yearly ordinals to ±53. Daily rules cannot filter weekdays; weekly weekdays require ordinal 0.

Monthly rules also accept `daysOfTheMonth` (±1…31). Yearly rules accept `monthsOfTheYear` (1…12), `weeksOfTheYear` (±1…53) and `daysOfTheYear` (±1…366). `setPositions` (±1…366) selects positions after applying another filter, for example the last matching weekday. Negative values count from the end of the period; zero and duplicate values are rejected. An optional `end` accepts exactly one of `count` (1…100000) or an inclusive ISO date-time `date` on or after the series start. Omit `end`, or set it to `null`, for no end. Impossible dates such as the 31st of a shorter month follow EventKit's expansion rules. Use an explicit IANA `timeZone` for timed series to keep local wall-clock times across DST.

Reads return `recurrenceRules` (an array, since existing events may contain multiple rules), `recurring` and `detached`. Rule metadata includes read-only `firstDayOfTheWeek` and `calendarIdentifier`; these are not accepted when authoring rules. Omit `recurrence` during updates to preserve existing rules. Supplying an object replaces them with one rule; `null` removes recurrence. A replacement rule uses EventKit's default first day of the week.

For a recurring event, **always specify the scope**:

- `PATCH /events/{id}` with `"span":"thisEvent"` edits only the selected occurrence, producing a detached exception when needed. It cannot replace/remove the recurrence rule.
- `PATCH /events/{id}` with `"span":"futureEvents"` edits the selected occurrence and following occurrences, preserving earlier ones. This scope also permits replacing/removing recurrence.
- `DELETE /events/{id}?span=thisEvent` deletes just the selected occurrence.
- `DELETE /events/{id}?span=futureEvents` deletes the selected occurrence and all following occurrences.

Use a freshly listed, non-detached occurrence for `futureEvents`. A detached exception can only use `thisEvent`. To affect an entire series, select its first occurrence and use `futureEvents`; the plugin does not search backwards or silently widen the scope. Omit scope for a non-recurring event, or use `thisEvent`. Refresh IDs after changes because EventKit can split a series or replace identities. A recurrence count on a replacement rule applies to the new series portion starting with the selected occurrence.

## Invitations remain read-only

Read-only calendars refuse writes. Events with attendees also refuse event updates/deletion, including recurring invitations. Reads expose each attendee's numeric `status`, readable `statusName` and `currentUser` flag. If a current-user attendee is available, the event also includes `participationStatus` and `participationStatusName` (for example `pending`, `accepted`, `declined` or `tentative`). Missing current-user data does not imply acceptance.

Event-level `writable` reflects this policy; `calendarWritable` reports the underlying calendar's permission. RSVP remains read-only by request. [EventKit cannot change participant information](https://developer.apple.com/documentation/eventkit/ekparticipant); the installed Calendar scripting dictionary also declares participation status read-only. Accept, decline or tentatively accept invitations in Calendar itself. The plugin does not send invitation responses or add attendees.

## Validate

`npm test` checks date validation, native EventKit all-day/DST behavior, nullable fields, recurrence construction/serialization, explicit occurrence scopes and invitation/write guards and fixture transport behavior without saving native data. `npm run live` reads local stores and creates/reads/updates/deletes one clearly labeled temporary event without attendees. Use `APPLE_CALENDAR_ID` to choose its writable calendar. Live access, actual recurring-series writes and invitation status reads were blocked by the implementation sandbox and remain to be verified from a normal Terminal. See the repository's validation report.
