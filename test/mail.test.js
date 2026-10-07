import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './mail-fixture.js';
import { route, compose } from '../plugins/apple-mail/index.js';
import { opaque } from '../shared/runtime.js';
const scope = { accountId: 'account-a', email: 'me@example.test' };
const execute = (fake, input) => fake.dispatch({ ...input, scope });
const messageTarget = { accountId: scope.accountId, path: ['Inbox'], nativeId: 1, messageId: '<1@fixture>' };

test('Mail connects exactly one address and fails ambiguous or changed accounts', () => {
  const fake = fixture();
  const response = fake.dispatch({ operation: 'authorize', email: 'ME@example.test' });
  assert.equal(response.status, 200); assert.deepEqual(response.body.scope, scope);
  assert.equal(fake.dispatch({ operation: 'authorize', email: 'absent@example.test' }).status, 404);
  fake.second.emailAddresses = () => ['me@example.test'];
  assert.equal(fake.dispatch({ operation: 'authorize', email: scope.email }).status, 409);
  fake.first.emailAddresses = () => ['changed@example.test'];
  assert.equal(execute(fake, { operation: 'account' }).status, 403);
});
test('Mail discovers nested mailboxes and scopes IDs to the selected account', () => {
  const response = execute(fixture(), { operation: 'mailboxes' });
  assert.equal(response.status, 200); assert.equal(response.body.items.length, 3);
  assert.deepEqual(response.body.items.find(item => item.name === 'Projects').path, ['Inbox', 'Projects']);
  assert.ok(response.body.items.every(item => JSON.parse(Buffer.from(item.id, 'base64url')).accountId === scope.accountId));
});
test('Mail rejects duplicate sibling mailbox names', () => {
  const fake = fixture(); fake.first.mailboxes.push(fake.inbox);
  assert.equal(execute(fake, { operation: 'mailboxes' }).status, 409);
});
test('Mail summary reads are bounded, resumable and do not load bodies', () => {
  const fake = fixture(), items = []; let offset = 0;
  for (let n = 0; n < 5; n++) {
    const result = execute(fake, { operation: 'messages', offset, limit: 1, maxScan: 1 });
    assert.equal(result.status, 200); assert.ok(result.body.scanned <= 1);
    items.push(...result.body.items);
    if (result.body.nextOffset === undefined) break;
    assert.ok(result.body.nextOffset > offset); offset = result.body.nextOffset;
  }
  assert.equal(items.length, 3); assert.equal(new Set(items.map(item => item.id)).size, 3);
  assert.equal(fake.stats().bodyReads, 0);
});
test('Mail combines search filters without claiming an account archive', () => {
  const result = execute(fixture(), { operation: 'messages', query: 'review', sender: 'alice', recipient: 'me@', unreadOnly: true, receivedAfter: '2026-10-07T00:00:00Z', receivedBefore: '2026-10-08T00:00:00Z', flagged: false });
  assert.equal(result.body.items.length, 1); assert.equal(result.body.items[0].subject, 'Launch review'); assert.equal(result.body.completeAccount, false);
});
test('Mail missing draft timestamps stay null and cannot match received-date filters', () => {
  const fake = fixture(), message = fake.inbox.messages()[0];
  message.dateSent = () => undefined; message.dateReceived = () => { throw new Error('Missing date'); };
  const read = execute(fake, { operation: 'get', target: messageTarget });
  assert.equal(read.body.sentAt, null); assert.equal(read.body.receivedAt, null);
  const filtered = execute(fake, { operation: 'messages', receivedAfter: '2026-01-01T00:00:00Z' });
  assert.ok(filtered.body.items.every(item => item.messageId !== messageTarget.messageId));
});
test('Mail rejects foreign account IDs and changed message identity before reads or writes', () => {
  const fake = fixture();
  assert.equal(execute(fake, { operation: 'get', target: { ...messageTarget, accountId: 'account-b' } }).status, 403);
  assert.equal(execute(fake, { operation: 'reply', target: { ...messageTarget, messageId: '<wrong>' }, text: 'Hello' }).status, 409);
  assert.equal(fake.stats().sends, 0);
});
test('Mail fetches bodies only for exact full reads', () => {
  const fake = fixture(), response = execute(fake, { operation: 'get', target: messageTarget });
  assert.equal(response.body.text, 'A private body'); assert.match(response.body.headers, /Message-ID/); assert.equal(fake.stats().bodyReads, 1);
});
test('Mail state updates set desired state and same-account moves return a new identity', () => {
  const fake = fixture();
  for (let i = 0; i < 2; i++) {
    const result = execute(fake, { operation: 'update', target: messageTarget, read: true, flagged: true });
    assert.equal(result.body.read, true); assert.equal(result.body.flagged, true);
  }
  const moved = execute(fake, { operation: 'move', target: messageTarget, destination: { accountId: scope.accountId, path: ['Archive'] } });
  assert.equal(moved.status, 200); assert.deepEqual(JSON.parse(Buffer.from(moved.body.id, 'base64url')).path, ['Archive']);
  assert.equal(execute(fake, { operation: 'get', target: messageTarget }).status, 404);
});
test('Mail drafts and sends select the configured sender and preserve text as data', () => {
  const fake = fixture(), text = 'Quotes " and newline\n😀; Application("Other").doAnything()';
  const input = { to: ['alice@example.test'], cc: ['team@example.test'], bcc: ['hidden@example.test'], subject: 'Fixture', text };
  const draft = execute(fake, { ...input, operation: 'draft' });
  assert.equal(draft.status, 201); assert.equal(fake.lastOutgoing.content(), text); assert.equal(fake.lastOutgoing.sender(), scope.email); assert.equal(fake.stats().sends, 0);
  const sent = execute(fake, { ...input, operation: 'send' });
  assert.equal(sent.status, 202); assert.equal(sent.body.deliveryConfirmed, false); assert.equal(fake.stats().sends, 1);
});
test('Mail native replies retain quote and explicit reply-all intent', () => {
  const fake = fixture();
  assert.equal(execute(fake, { operation: 'reply', target: messageTarget, text: 'Thanks', replyAll: true }).status, 202);
  assert.match(fake.lastOutgoing.content(), /^Thanks\n\nQuoted original$/); assert.equal(fake.lastOutgoing.ccRecipients().length, 1); assert.equal(fake.lastOutgoing.sender(), scope.email);
});
test('Mail rejected send commands are uncertain', () => {
  const fake = fixture(); fake.mail.send = () => false;
  const result = execute(fake, { operation: 'send', to: ['alice@example.test'], subject: 'Hello', text: 'Test' });
  assert.equal(result.status, 409); assert.equal(result.body.error.code, 'send_uncertain');
});
test('Mail HTTP routes refuse arbitrary sender, target account, unknown fields and query injection', () => {
  assert.throws(() => compose({ to: ['a@example.test'], subject: '', text: 'x', idempotencyKey: 'fixture-key', sender: 'other@example.test' }), /Accepted fields/);
  const foreign = opaque({ ...messageTarget, accountId: 'other' });
  assert.throws(() => route('GET', new URL(`http://local/messages/${foreign}`), undefined, scope), /another Mail account/);
  assert.throws(() => route('GET', new URL('http://local/messages?maxScan=10001'), undefined, scope), /maxScan/);
  assert.throws(() => route('GET', new URL('http://local/messages?unreadOnly=1'), undefined, scope), /true or false/);
  assert.throws(() => route('GET', new URL('http://local/messages?query=a&query=b'), undefined, scope), /repeated/);
  assert.throws(() => compose({ to: ['Alice <a@example.test>'], subject: '', text: 'x', idempotencyKey: 'fixture-key' }), /one email address/);
});
