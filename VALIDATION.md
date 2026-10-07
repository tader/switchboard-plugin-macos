# Validation

Implementation validation on October 7, 2026, using Node 26.8.1, macOS 27.0.1 and the Xcode 27.1 toolchain. CI targets Node 24 on Linux and macOS.

## Publication

The plugins, tests and documentation are published at [tader/switchboard-plugin-macos](https://github.com/tader/switchboard-plugin-macos). The companion [Switchboard migration PR](https://github.com/tader/switchboard/pull/1) remains a draft; install the replacement Reminders plugin on every Mac/satellite before upgrading to that removal.

The CI workflow is prepared locally at `.github/workflows/ci.yml`, but has not been published or run: the connected GitHub credentials cannot write workflow files. The local `gh` client cannot reach `api.github.com` from this sandbox and reports invalid authentication. Publish the prepared workflow with a working credential that permits workflow updates, then require its Linux/macOS checks before treating this as validated for release.

## Calendar 1.1 changes

Recurring-event authoring and explicit single/future occurrence updates/deletes were added. Native in-memory EventKit tests cover rule construction, serialization, replacement/removal and scope guards without saving any calendar data. All invitations remain read-only by request; current-user attendance status is exposed. Real recurring-series writes and invitation status reads remain unverified in this sandbox.

## Passed

- 32 automated tests: Reminders migration and legacy credential reuse across reloads, Mail JXA fixtures, Calendar validation and native EventKit date/recurrence behavior.
- Injected HTTP/native transport tests: connection isolation, scoped request capabilities, replay rejection, revocation, body limits, serialized queues, helper timeout and durable retry protection across reloads.
- Compilation of all three Swift helpers, with their embedded Info.plist privacy descriptions.
- Separate copied-plugin imports, matching Switchboard's directory-copy installation/hot-reload model.
- Actual Switchboard GitHub installer integration using a temporary database and local tarball: all three independent plugins, uninstall and single-folder installation. Native service execution is suppressed for this installer check.
- Read-only AppleScript discovery of locally configured Mail accounts.

## Not completed in this sandbox

- A real loopback listener: the OS returned `listen EPERM` for `127.0.0.1`. In-memory transport checks passed; run `npm run smoke` from a normal Terminal or CI for the real listener check.
- Live EventKit reads/writes: Reminders returned `NSMachErrorDomain Code=4099` before live validation could reach Calendar. No temporary event was created, and no Calendar cleanup is outstanding.
- Live JXA Mail reads: the bundled OSAKit helper returned `Application can't be found`; a direct JXA read also failed with the same error. AppleScript account discovery worked, which does not validate the JXA adapter.
- Real draft persistence and sending/replying/flagging/moving in Mail. Mail writes were tested only against isolated fixtures, as agreed.
- Existing encrypted Reminders credentials against a running replacement installation. The credential/API/helper identity is preserved in source, and regression tests cover the legacy parsing behavior; an actual upgrade still needs the normal local validation.

Run `APPLE_MAIL_EMAIL=you@example.com npm run live` from a normal Terminal to complete native reads and the authorized temporary Calendar event cycle. It never writes to Mail. Review `.build/live-report.json` if native access or cleanup fails.

There has been no independent human code review. The above limitations are part of the release record, not successful validation claims.
