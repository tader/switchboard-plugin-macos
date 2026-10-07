---
title: Apple Mail
services: [apple-mail]
---

# Apple Mail

Connect using one email address already configured in Apple Mail. The plugin resolves that address to exactly one native account; ambiguous or missing addresses fail. Create separate connections for other accounts. Account ID and selected sender are checked on every native call. Unified mailboxes and “On My Mac” mailboxes are outside this account-scoped version.

Run Switchboard in your logged-in macOS session with Node 24+ and Xcode Command Line Tools. On first connection, macOS requests permission to control Mail. If denied, enable **Switchboard Apple Mail** under **System Settings → Privacy & Security → Automation → Mail**. The responsible application can instead appear as Terminal or your host app depending on how macOS attributes the process. Mail may launch when called. Sandboxed development environments can prevent application discovery or Apple events; use a normal Terminal for live checks.

The plugin uses Mail's scripting dictionary via a fixed JXA script and a Swift OSAKit helper. MailKit is for app extensions and does not supply this general mailbox API. No account passwords, provider tokens, Mail database files or private network endpoints are accessed.

## Read and search

Operations appear in Switchboard's API reference and MCP tools:

- `getAppleMailAccount`: details of this connection's account.
- `listAppleMailMailboxes`: nested mailboxes with opaque `id`, hierarchy and unread counts.
- `listAppleMailMessages`: locally available message summaries; bodies are not loaded.
- `getAppleMailMessage`: one exact message's plain-text body, headers and metadata.

List calls accept `pageSize` (1–100, default 100) and return `items` plus `nextToken` when work remains. Keep all parameters, including page size, unchanged while paging. IDs and tokens are scoped to the connected account. A mailbox rename or message move can invalidate IDs; list again rather than guessing. Live changes while paging can affect ordering; this is not a snapshot archive.

Message filters: `mailboxId`, `query` (case-insensitive subject substring), `sender`, `recipient` (To/Cc), `receivedAfter`, `receivedBefore`, `unreadOnly` and `flagged`. Dates must include an explicit ISO 8601 time zone; date comparisons are strict. Searches do not inspect bodies or query the mail provider. Mail's current local/synced contents determine availability.

`maxScan` (1–10,000, default 1,000) limits summaries examined per request. A page can be empty while `nextToken` advances past unmatched messages. Follow it until absent to finish the local traversal. `scanned` and `truncated` describe the current page; `completeAccount=false` and `locallyAvailableOnly=true` remain explicit. Mailbox discovery is limited to 2,000 boxes and 50 nesting levels; errors do not claim complete results. Summary order is mailbox hierarchy then descending native message ID, not an account-wide date sort. Native ID enumeration is still performed for traversed mailboxes; the helper's 60-second timeout bounds slow native work.

## Drafts, sends and replies

`createAppleMailDraft` (`POST /drafts`) and `sendAppleMailMessage` (`POST /messages/send`) accept:

```json
{
  "to": ["alice@example.com"],
  "cc": [],
  "bcc": [],
  "subject": "Review",
  "text": "Please review the proposal.",
  "idempotencyKey": "review-2026-10-07-0001"
}
```

Use email addresses without display names. Sending always uses the connected address; the API has no arbitrary sender field. Drafts are saved for manual review in Mail. The returned `outgoingId` is diagnostic, not a message ID accepted by read/update operations. Draft editing and sending an existing draft are deferred.

`replyToAppleMailMessage` (`POST /messages/{id}/reply`) accepts `text`, `idempotencyKey`, and optional `replyAll` (default false). Mail creates the native threaded reply, preserving its quote and recipient selection; the connected address remains the sender. Sending reports `accepted_by_mail` with `deliveryConfirmed=false`, describing Mail's send command rather than recipient delivery.

**Reuse the same idempotency key for every retry of one intended operation.** Keys are 8–128 letters, digits or `. _ : -`. The durable ledger binds a key to the account, operation and complete payload before native execution. Successful retries replay the saved result, including across reloads. Reusing a key with different content fails. `mutation_uncertain` means execution or its receipt could not be confirmed; inspect Mail and do not retry with a new key. This conservatively includes native failures after intent was saved. At 10,000 entries, new operations stop rather than discard duplicate protection.

## Organize messages

`updateAppleMailMessage` (`PATCH /messages/{id}`) sets `read` and/or `flagged` explicitly. Repeating the same desired state does not toggle it.

`moveAppleMailMessage` (`POST /messages/{id}/move`) takes `mailboxId` and `idempotencyKey`. Both mailboxes must belong to this account. It returns the destination message's refreshed ID. A same-mailbox move is a no-op. Missing or ambiguous destination confirmation is uncertain and must be inspected.

Attachments, HTML composition, deleting messages, full-body search and background subscriptions are deferred. The helper never replaces your existing outgoing drafts. A failed compose operation may leave a new draft for inspection.

## Storage and verification

Helpers and durable ledgers live in `<Switchboard data>/plugin-data/apple-mail/`; ledgers use mode 0600 and contain operation receipts. Back them up with Switchboard's data. Connection deletion revokes outstanding request capabilities but retains the ledger so reconnecting cannot silently discard retry protection. Switchboard's normal audit trail may contain requests and responses, including mail content.

Fixture tests cover the exposed operations. Native draft persistence, real sending and end-to-end Mail reads require verification from a normal Terminal; the implementation sandbox denied JXA application access. `APPLE_MAIL_EMAIL=you@example.com npm run live` performs reads only for Mail.
