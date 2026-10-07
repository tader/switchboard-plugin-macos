# macOS plugins for Switchboard

## Summary

Create and publish **`tader/switchboard-plugin-macos`** as a public repository containing three independently installable plugins: Apple Reminders, Apple Mail and Apple Calendar.

Deliver Reminders’ removal from Switchboard through a companion draft PR against `feature/websocket-satellites`, preserving the existing checkout.

## Implementation

- **Repository:** Put plugins under `plugins/`, matching Switchboard’s existing multi-plugin installer. Each plugin contains its own manifest, icon, entry module, native helper and setup guide. Add dependency-free Node tests, macOS CI, installation instructions and validation notes.
- **Reminders:** Move the existing implementation, documentation and tests. Preserve its service ID, `eventkit` authentication method, API, helper identity and persistent data location so existing connections remain usable. Replace the type-only import into Switchboard with plugin-local types.
- **Mail:** Use a Swift helper running fixed JavaScript for Automation through OSAKit. Pass request JSON as handler arguments, never interpolated script source. MailKit provides extension capabilities rather than the general mailbox interface needed here. [Apple MailKit documentation](https://developer.apple.com/documentation/mailkit)
- **Calendar:** Use a Swift EventKit helper with full calendar access. Provide a “This Mac” connection covering the local user’s calendars. [Apple EventKit access guidance](https://developer.apple.com/documentation/technotes/tn3153-adopting-api-changes-for-eventkit-in-ios-macos-and-watchos)
- **New adapters:** Follow Teams’ authenticated loopback pattern, including single-use request capabilities, serialized native operations, bounded requests and helper timeouts. Compile helpers on first connection and cache them in each plugin’s persistent data directory. Publish OpenAPI descriptions for Switchboard’s API reference and MCP tools.

### Apple Mail interface

Connect using an email address already configured in Mail. Resolve it to exactly one native account and persist that account ID and sender address. Every operation remains scoped to that account.

Expose:

- Account details and mailbox discovery, including nested mailboxes.
- Paginated message listing and search by subject, sender, recipient, date, unread state and flag state.
- Individual message reads with plain-text content and headers.
- Plain-text draft creation, sending, sender-only replies and explicit reply-all.
- Explicit read/flag updates and moves between mailboxes within the connected account.

Use opaque account-scoped mailbox and message identifiers; reject ambiguous or stale targets. Require durable idempotency keys for draft creation, sending and replies. Repeated successful requests return the original result; uncertain sends require inspection and are never automatically resent.

### Apple Calendar interface

Expose calendar listing and event listing, retrieval, creation, update and deletion. Event listings require a bounded date range, with optional calendar and text filters.

Support title, calendar, start/end, all-day state, time zone, notes, location and URL. Handle daylight-saving transitions and exclusive all-day end dates. Report calendar write permissions and reject writes to read-only calendars.

Recurring events remain readable; recurring-event edits, recurrence authoring and invitation management are deferred. EventKit’s attendee property is read-only. [Apple attendee documentation](https://developer.apple.com/documentation/eventkit/ekcalendaritem/attendees)

## Validation and migration

- Preserve the existing Reminders pagination and filtering tests.
- Test Mail account isolation, nested mailbox identity, search/pagination, script argument escaping, sender selection, replies, state updates, moves and duplicate-send protection using fixtures.
- Test Calendar time zones, all-day events, range validation, read-only calendars and rejection of recurring-event writes.
- Verify native helper compilation, authentication, disposal, permission failures, restart/reload behavior and standalone plugin loading.
- Perform live reads on this Mac. Create, update and delete one clearly labeled temporary event without attendees; verify cleanup. Mail writes use fixtures.
- Verify whole-repository and individual-plugin installation. Test existing Reminders credentials against the replacement plugin.
- Publish the new repository before opening the removal PR. In that PR, relocate Reminders tests, update built-in-plugin assertions and document installing the replacement before upgrading.

## Defaults and boundaries

- Node 24+, macOS 14+, and Xcode Command Line Tools.
- Run in the logged-in user’s session, directly or through a Switchboard satellite.
- New list APIs return at most 100 items per page.
- Mail covers locally available data exposed by Mail’s scripting interface. Attachment transfer, HTML composition, message deletion and body-wide search are deferred.
- The companion Switchboard PR remains unmerged.

## Other useful macOS integrations

These are recommendations for later additions:

| Integration | Useful plugin capabilities |
|---|---|
| **[Contacts](https://developer.apple.com/documentation/contacts)** | Find people, resolve recipient email addresses, manage contacts and groups. **Best next addition.** |
| **Apple Notes via scripting** | Search/read notes and create or update notes; the installed app exposes an account/folder/note scripting dictionary. |
| **[Shortcuts](https://support.apple.com/guide/shortcuts-mac/run-shortcuts-from-the-command-line-apd455c82f02/mac)** | List and run selected personal workflows with inputs and outputs. |
| **[Spotlight metadata](https://developer.apple.com/library/archive/documentation/Carbon/Conceptual/SpotlightQuery/Concepts/QueryingMetadata.html)** | Find local documents by indexed names, content and metadata. |
| **[PhotoKit](https://developer.apple.com/documentation/photokit)** | Browse photo libraries and albums, retrieve assets and manage collections. |
| **[Vision](https://developer.apple.com/documentation/vision/recognizing-text-in-images) + [PDFKit](https://developer.apple.com/documentation/pdfkit/pdfdocument/string)** | Extract text from screenshots, scanned documents and PDFs. |
| **[MapKit](https://developer.apple.com/documentation/mapkit/mkdirections)** | Estimate travel time and routes for calendar planning. |
