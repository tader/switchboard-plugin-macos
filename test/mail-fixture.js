import vm from 'node:vm';
import fs from 'node:fs/promises';
const source = await fs.readFile(new URL('../plugins/apple-mail/mail.js', import.meta.url), 'utf8');
export function fixture() {
  let bodyReads = 0, sends = 0, replies = 0, saves = 0, lastOutgoing;
  const collection = values => {
    const accessor = () => values;
    accessor.push = value => values.push(value);
    accessor.id = () => values.map(value => value.id());
    accessor.byId = id => { const found = values.filter(value => value.id() === id); if (found.length !== 1) throw new Error('Unknown fixture ID'); return found[0]; };
    return accessor;
  };
  function property(object, name, initial) {
    let value = initial;
    Object.defineProperty(object, name, { get: () => () => value, set: replacement => { value = replacement; }, configurable: true });
  }
  const recipient = address => ({ address: () => address });
  function message(id, subject, read = false) {
    const object = { id: () => id, messageId: () => `<${id}@fixture>`, subject: () => subject, sender: () => 'Alice <alice@example.test>', toRecipients: collection([recipient('me@example.test')]), ccRecipients: collection([]), dateReceived: () => new Date('2026-10-07T12:00:00Z'), dateSent: () => new Date('2026-10-07T11:59:00Z'), content: () => { bodyReads++; return 'A private body'; }, allHeaders: () => `Message-ID: <${id}@fixture>` };
    property(object, 'readStatus', read); property(object, 'flaggedStatus', false);
    return object;
  }
  const account = (id, address) => ({ id: () => id, name: () => id, emailAddresses: () => [address], mailboxes: collection([]) });
  const first = account('account-a', 'me@example.test'), second = account('account-b', 'other@example.test');
  function mailbox(name, owner, messages = [], children = []) { return { name: () => name, account: () => owner, messages: collection(messages), mailboxes: collection(children), unreadCount: () => messages.filter(item => !item.readStatus()).length }; }
  const nested = mailbox('Projects', first, [message(3, 'Launch review')]);
  const inbox = mailbox('Inbox', first, [message(1, 'Hello'), message(2, 'Review tomorrow', true)], [nested]);
  const archive = mailbox('Archive', first);
  first.mailboxes.push(inbox); first.mailboxes.push(archive); second.mailboxes.push(mailbox('Inbox', second, [message(4, 'Other account private')])) ;
  function outgoing(properties) {
    const object = { id: () => 100, toRecipients: collection([]), ccRecipients: collection([]), bccRecipients: collection([]) };
    property(object, 'subject', properties.subject); property(object, 'content', properties.content); property(object, 'sender', 'other@example.test');
    lastOutgoing = object; return object;
  }
  const mail = { accounts: collection([first, second]), outgoingMessages: collection([]), OutgoingMessage: outgoing, ToRecipient: input => recipient(input.address), CcRecipient: input => recipient(input.address), BccRecipient: input => recipient(input.address), extractAddressFrom: address => address.match(/<([^>]+)>/)?.[1] ?? address,
    reply(original, options) { replies++; const value = outgoing({ subject: 'Re: ' + original.subject(), content: 'Quoted original' }); value.toRecipients.push(recipient('alice@example.test')); if (options.replyToAll) value.ccRecipients.push(recipient('team@example.test')); return value; },
    send() { sends++; return true; }, save() { saves++; },
    move(value, options) { for (const box of [inbox, nested, archive]) { const items = box.messages(), index = items.indexOf(value); if (index >= 0) items.splice(index, 1); } options.to.messages.push(value); },
  };
  const context = vm.createContext({ Application: name => { if (name !== 'com.apple.mail') throw new Error('Unexpected application'); return mail; } });
  vm.runInContext(source, context);
  context.mailEncode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return { mail, first, second, inbox, archive, nested, dispatch: input => JSON.parse(context.dispatch(JSON.stringify(input))), get lastOutgoing() { return lastOutgoing; }, stats: () => ({ bodyReads, sends, replies, saves }) };
}
