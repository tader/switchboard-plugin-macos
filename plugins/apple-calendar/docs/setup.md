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

Omit `calendarId` to use the default writable calendar. `title`, `startDate`, `endDate` and `idempotencyKey` are required. Optional fields are `allDay`, `timeZone`, `notes`, `location` and an HTTP/HTTPS `url`. The end must follow the start. Event creation uses a durable idempotency ledger; reuse the same key and payload for retries. An uncertain create is not repeated automatically; inspect Calendar before trying another key.

`updateAppleCalendarEvent` (`PATCH /events/{id}`) accepts the same event fields without `idempotencyKey`; omitted fields remain unchanged. Set notes, location or URL to `null` to clear. The response contains the refreshed event ID. `deleteAppleCalendarEvent` (`DELETE /events/{id}`) deletes that exact non-recurring event.

All-day start and exclusive end must be midnight in the Mac's local time zone. An event spanning one day ends at the next day's midnight, including 23- or 25-hour DST days. EventKit all-day dates are floating; omit `timeZone` or use this Mac's zone. Timed events support other IANA zones. The adapter normalizes EventKit's inclusive end-of-day representation to an exclusive API end date.

Read-only calendars refuse writes. Recurring series and detached recurring occurrences remain read-only; recurrence authoring and series edits are deferred. Events with attendees are also read-only in this version, so updates/deletion cannot send invitation changes. EventKit exposes attendee information for reading but cannot add attendees.

## Validate

`npm test` checks date validation, native EventKit all-day/DST behavior, nullable fields, write guards and fixture transport behavior without saving native data. `npm run live` reads local stores and creates/reads/updates/deletes one clearly labeled temporary event without attendees. Use `APPLE_CALENDAR_ID` to choose its writable calendar. Live access and actual writes were blocked by the implementation sandbox and remain to be verified from a normal Terminal. See the repository's validation report.
