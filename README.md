# macOS plugins for Switchboard

Local Apple Reminders, Apple Mail and Apple Calendar integrations for [Switchboard](https://github.com/tader/switchboard). Run them on a Mac, directly or through a Switchboard peer. There are no npm runtime dependencies.

> **AI authorship disclosure:** OpenAI Codex wrote the new implementation, tests and documentation at Thomas de Ruiter's request. Reminders was moved from Switchboard. The code has not been independently reviewed by a human. Validation and remaining gaps are recorded below and in [VALIDATION.md](VALIDATION.md).

## Install

In **Plugins → Install from GitHub**, enter:

```text
tader/switchboard-plugin-macos
```

Switchboard installs all three plugins from `plugins/`. To install one plugin, use its folder URL, for example:

```text
https://github.com/tader/switchboard-plugin-macos/tree/main/plugins/apple-mail
```

All plugins need macOS, Node 24+, the logged-in user's graphical session and Xcode Command Line Tools (`xcode-select --install`). Mail and Calendar target macOS 14+. Reminders retains its existing compatibility fallback. A per-user LaunchAgent works; a system daemon or Linux/Docker host cannot use this Mac's local data. Install on the Mac's peer when the main Switchboard runs elsewhere.

| Plugin | Connection | Capabilities |
|---|---|---|
| [Apple Reminders](plugins/apple-reminders/docs/setup.md) | This Mac; full Reminders access | Lists, filtered/paginated reminders, create, update, complete and delete |
| [Apple Mail](plugins/apple-mail/docs/setup.md) | One email address configured in Mail; Automation permission | Nested mailboxes, filtered/paginated message reads, drafts, sends/replies, read/flag state and same-account moves |
| [Apple Calendar](plugins/apple-calendar/docs/setup.md) | This Mac; full Calendar access | Calendars and bounded occurrence reads; create recurring series, update/delete one occurrence or future occurrences; read invitation status |

Mail and Calendar compile their Swift helpers on the first connection, then cache them in Switchboard's persistent plugin-data directory. Setup does not request their privacy permissions. Reminders retains its existing setup-time helper build and permission behavior.

## Move an existing Reminders connection

**Install this repository on every Mac providing Apple Reminders before upgrading Switchboard to a version that removes the built-in plugin.** Installed plugins take precedence over built-ins with the same ID.

The moved plugin keeps `apple-reminders`, its `eventkit` authentication method, account ID, saved credentials, API operations, helper bundle ID and persistent data directory. Installing it does not require deleting or reconnecting existing connections. Do not uninstall the built-in connection or remove its plugin-data directory. The Swift source and Info.plist are unchanged by the move.

For local development, copy each complete plugin directory into `<Switchboard data>/plugins/`; use real directories because Switchboard copies plugins when loading them. Changes outside an installed plugin directory are not available at runtime.

## Development and validation

```sh
npm run check
npm test
npm run smoke
npm run build:helpers
```

`npm test` uses isolated Mail fixtures and injected native/HTTP transports. On macOS it also exercises native EventKit date behavior without requesting access or saving data. `npm run smoke` imports separately copied plugins and checks a real loopback adapter using fake calendar data; it never contacts Mail or creates events. `npm run build:helpers` compiles all three native helpers on macOS. The prepared CI workflow targets Linux and macOS and compiles helpers on macOS; publishing it remains pending (see the validation record).

Optional live validation, from a normal Terminal:

```sh
APPLE_MAIL_EMAIL=you@example.com npm run live
```

This reads Reminders, reads calendars, creates/reads/updates/deletes one clearly labeled temporary event without attendees, then reads the selected Mail account, one mailbox page and at most one full message. It never drafts or sends mail, marks messages or moves them. macOS can show permission prompts. `APPLE_CALENDAR_ID` can select the writable test calendar; otherwise the default writable calendar is selected. Cleanup identity and results are stored in ignored `.build/live-report.json`; if cleanup fails, delete the recorded temporary event manually.

The implementation session passed the fixture tests and helper compilation. Its sandbox prevented real loopback listening, EventKit service access and JXA access to Mail. Real Mail sending, native draft persistence and real Calendar writes therefore remain unverified. See [VALIDATION.md](VALIDATION.md) for details.

The runtime source lives in `shared/runtime.js` and is vendored into each new plugin so individual installations are self-contained. Run `npm run sync` after changing it; `npm run check` rejects stale copies.

With a Switchboard checkout and its dependencies installed, `SWITCHBOARD_ROOT=../switchboard npm run integration` exercises the actual installer with a temporary local tarball, database and copied plugins. It checks repository-wide and single-folder installation while suppressing native services; it never changes your running instance.

## Further macOS integrations

See [ROADMAP.md](ROADMAP.md). Contacts is the next recommended addition, followed by Notes, Shortcuts and Spotlight file search. Photos, document OCR/PDF extraction and Maps are also useful candidates.

## Releases

Release-please opens version and changelog pull requests from Conventional Commits. Merge the release PR to publish its tag and GitHub release. Plugin manifests are updated with their package versions. Family repositories maintain an independent version for each plugin.
