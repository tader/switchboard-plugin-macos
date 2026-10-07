# Validation

Implementation validation on October 7, 2026, using Node 26.8.1, macOS 27.0.1 and the Xcode 27.1 toolchain. CI targets Node 24 on Linux and macOS.

## Passed

- 30 automated tests: Reminders migration and legacy credential reuse across reloads, Mail JXA fixtures, Calendar validation and native EventKit date behavior.
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
