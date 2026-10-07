/* JavaScript for Automation. This file is also evaluated against Mail fixtures.
 * No eval, shell commands, arbitrary app names, or interpolated script source.
 */
function mailFailure(status, code, message) { var error = new Error(message); error.status = status; error.code = code; throw error; }
function normalized(value) { return String(value).trim().toLowerCase(); }
function mailboxIdentity(scope, path) { return { accountId: scope.accountId, path: path }; }
function mailEncode(value) {
  // Foundation encoding works in JXA; fixtures provide the same two functions.
  ObjC.import('Foundation');
  return $.NSString.alloc.initWithUTF8String(JSON.stringify(value)).dataUsingEncoding($.NSUTF8StringEncoding).base64EncodedStringWithOptions(0).js.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function accountInfo(account) { return { id: String(account.id()), name: String(account.name()), emailAddresses: account.emailAddresses().map(String) }; }
function resolveAccount(mail, input) {
  var accounts = mail.accounts(), matches;
  if (input.operation === 'authorize') {
    matches = accounts.filter(function(account) { return account.emailAddresses().some(function(address) { return normalized(address) === normalized(input.email); }); });
  } else {
    if (!input.scope || !input.scope.accountId || !input.scope.email) mailFailure(403, 'invalid_scope', 'A connected Mail account is required');
    matches = accounts.filter(function(account) { return String(account.id()) === input.scope.accountId; });
  }
  if (matches.length !== 1) mailFailure(matches.length ? 409 : 404, 'account_not_found', 'The selected Mail account is missing or ambiguous');
  var account = matches[0];
  if (input.operation !== 'authorize' && !account.emailAddresses().some(function(address) { return normalized(address) === input.scope.email; })) mailFailure(403, 'sender_changed', 'The connected sender is no longer configured on this account');
  return account;
}
function enumerateMailboxes(account) {
  var result = [];
  function walk(boxes, prefix) {
    if (prefix.length > 50) mailFailure(409, 'mailbox_depth', 'Mailbox nesting exceeds 50 levels');
    var names = Object.create(null);
    boxes.forEach(function(box) {
      var name = String(box.name());
      if (Object.prototype.hasOwnProperty.call(names, name)) mailFailure(409, 'ambiguous_mailbox', 'Two sibling mailboxes have the same name');
      names[name] = true;
      var path = prefix.concat([name]);
      result.push({ box: box, path: path });
      if (result.length > 2000) mailFailure(409, 'mailbox_limit', 'More than 2000 mailboxes are exposed');
      walk(box.mailboxes(), path);
    });
  }
  walk(account.mailboxes(), []);
  result.sort(function(a, b) { return JSON.stringify(a.path).localeCompare(JSON.stringify(b.path)); });
  return result;
}
function resolveMailbox(account, target, scope) {
  if (!target || target.accountId !== scope.accountId || !Array.isArray(target.path) || !target.path.length) mailFailure(403, 'account_mismatch', 'Mailbox belongs to a different account');
  var boxes = account.mailboxes(), box;
  target.path.forEach(function(name) {
    var matches = boxes.filter(function(item) { return String(item.name()) === name; });
    if (matches.length !== 1) mailFailure(matches.length ? 409 : 404, 'mailbox_not_found', 'Mailbox hierarchy is stale or ambiguous');
    box = matches[0]; boxes = box.mailboxes();
  });
  if (String(box.account().id()) !== scope.accountId) mailFailure(403, 'account_mismatch', 'Mailbox account changed');
  return box;
}
function messageIdentity(message, scope, path) {
  var header = message.messageId();
  return { accountId: scope.accountId, path: path, nativeId: Number(message.id()), messageId: header ? String(header) : null };
}
function resolveMessage(account, target, scope) {
  var box = resolveMailbox(account, target, scope);
  var ids = box.messages.id().map(Number).filter(function(id) { return id === target.nativeId; });
  if (ids.length !== 1) mailFailure(ids.length ? 409 : 404, 'message_not_found', 'Message identity is stale or ambiguous; list messages again');
  var message = box.messages.byId(target.nativeId), actual = messageIdentity(message, scope, target.path);
  if (actual.messageId !== target.messageId) mailFailure(409, 'message_changed', 'Message-ID no longer matches the selected message');
  return { message: message, box: box, path: target.path };
}
function addresses(message, property) { return message[property]().map(function(recipient) { return String(recipient.address()); }); }
function mailDate(getter) {
  try {
    var value = getter();
    if (value === null || value === undefined) return null;
    var result = new Date(value);
    return isFinite(result.getTime()) ? result.toISOString() : null;
  } catch (_) { return null; }
}
function messageInfo(message, scope, path, full) {
  var target = messageIdentity(message, scope, path);
  var value = { id: mailEncode(target), mailboxId: mailEncode(mailboxIdentity(scope, path)), messageId: target.messageId, subject: String(message.subject() || ''), sender: String(message.sender() || ''), to: addresses(message, 'toRecipients'), cc: addresses(message, 'ccRecipients'), receivedAt: mailDate(function() { return message.dateReceived(); }), sentAt: mailDate(function() { return message.dateSent(); }), read: Boolean(message.readStatus()), flagged: Boolean(message.flaggedStatus()) };
  if (full) { value.text = String(message.content() || ''); value.headers = String(message.allHeaders() || ''); }
  return value;
}
function pageMail(items, input) {
  var start = Math.min(Math.max(input.offset || 0, 0), items.length), end = Math.min(start + Math.min(input.limit || 100, 100), items.length);
  var result = { items: items.slice(start, end) };
  if (end < items.length) result.nextOffset = end;
  return result;
}
function mailMatches(value, input) {
  function has(value, query) { return String(value).toLowerCase().indexOf(String(query).toLowerCase()) >= 0; }
  if (input.query && !has(value.subject, input.query)) return false;
  if (input.sender && !has(value.sender, input.sender)) return false;
  if (input.recipient && !value.to.concat(value.cc).some(function(address) { return has(address, input.recipient); })) return false;
  if (input.unreadOnly && value.read) return false;
  if (input.flagged !== undefined && input.flagged !== value.flagged) return false;
  if (input.receivedAfter && (!value.receivedAt || Date.parse(value.receivedAt) <= Date.parse(input.receivedAfter))) return false;
  if (input.receivedBefore && (!value.receivedAt || Date.parse(value.receivedAt) >= Date.parse(input.receivedBefore))) return false;
  return true;
}
function composeMail(mail, input, original) {
  var message;
  if (original) {
    message = mail.reply(original, { openingWindow: false, replyToAll: input.replyAll === true });
    var quoted = String(message.content() || '');
    message.content = input.text + '\n\n' + quoted;
  } else {
    message = mail.OutgoingMessage({ subject: input.subject, content: input.text, visible: false });
    mail.outgoingMessages.push(message);
    ['to', 'cc', 'bcc'].forEach(function(kind) {
      var type = { to: 'ToRecipient', cc: 'CcRecipient', bcc: 'BccRecipient' }[kind];
      (input[kind] || []).forEach(function(address) { message[kind + 'Recipients'].push(mail[type]({ address: address })); });
    });
  }
  message.sender = input.scope.email;
  if (normalized(mail.extractAddressFrom(message.sender())) !== input.scope.email) mailFailure(409, 'sender_mismatch', 'Mail did not select the connected sender');
  // Native reply retains its threading and recipients. Verify recipients before send.
  var actual = addresses(message, 'toRecipients');
  if (!actual.length) mailFailure(409, 'no_recipient', 'Mail did not produce any reply recipients');
  if (!original) ['to', 'cc', 'bcc'].forEach(function(kind) {
    if (JSON.stringify(addresses(message, kind + 'Recipients').map(normalized)) !== JSON.stringify((input[kind] || []).map(normalized))) mailFailure(409, 'recipient_mismatch', 'Draft recipients do not match the requested recipients');
  });
  return message;
}
function mailDispatch(input, mail) {
  var account = resolveAccount(mail, input);
  if (input.operation === 'authorize') { var info = accountInfo(account); return { status: 200, body: { scope: { accountId: info.id, email: normalized(input.email) }, name: info.name } }; }
  var scope = input.scope, operation = input.operation;
  if (operation === 'account') return { status: 200, body: accountInfo(account) };
  if (operation === 'mailboxes') {
    var boxes = enumerateMailboxes(account).map(function(item) { return { id: mailEncode(mailboxIdentity(scope, item.path)), name: item.path[item.path.length - 1], path: item.path, unreadCount: Number(item.box.unreadCount()) }; });
    return { status: 200, body: pageMail(boxes, input) };
  }
  if (operation === 'messages') {
    var boxes = input.mailbox ? [{ box: resolveMailbox(account, input.mailbox, scope), path: input.mailbox.path }] : enumerateMailboxes(account);
    var items = [], position = 0, scanned = 0, stopped = false;
    var offset = input.offset || 0, limit = Math.min(input.limit || 100, 100), cap = Math.min(input.maxScan || 1000, 10000);
    for (var b = 0; b < boxes.length; b++) {
      var ids = boxes[b].box.messages.id().map(Number).sort(function(a, c) { return c - a; });
      for (var m = 0; m < ids.length; m++) {
        if (position < offset) { position++; continue; }
        if (scanned >= cap || items.length >= limit) { stopped = true; break; }
        var value = messageInfo(boxes[b].box.messages.byId(ids[m]), scope, boxes[b].path, false); position++; scanned++;
        if (mailMatches(value, input)) items.push(value);
      }
      if (stopped) break;
    }
    var result = { items: items, scanned: scanned, truncated: stopped, completeAccount: false, locallyAvailableOnly: true };
    if (stopped) result.nextOffset = position;
    return { status: 200, body: result };
  }
  if (operation === 'get' || operation === 'update' || operation === 'move' || operation === 'reply') {
    var selected = resolveMessage(account, input.target, scope);
    if (operation === 'get') return { status: 200, body: messageInfo(selected.message, scope, selected.path, true) };
    if (operation === 'update') {
      if (input.read !== undefined) selected.message.readStatus = input.read;
      if (input.flagged !== undefined) selected.message.flaggedStatus = input.flagged;
      if (input.read !== undefined && Boolean(selected.message.readStatus()) !== input.read || input.flagged !== undefined && Boolean(selected.message.flaggedStatus()) !== input.flagged) mailFailure(409, 'mutation_uncertain', 'Mail did not confirm the requested state');
      return { status: 200, body: messageInfo(selected.message, scope, selected.path, false) };
    }
    if (operation === 'move') {
      var destination = resolveMailbox(account, input.destination, scope);
      if (JSON.stringify(selected.path) === JSON.stringify(input.destination.path)) return { status: 200, body: messageInfo(selected.message, scope, selected.path, false) };
      var original = messageIdentity(selected.message, scope, selected.path);
      mail.move(selected.message, { to: destination });
      var moved = destination.messages().filter(function(item) { return original.messageId ? String(item.messageId()) === original.messageId : Number(item.id()) === original.nativeId; });
      if (moved.length !== 1) mailFailure(409, 'mutation_uncertain', 'Moved message was not uniquely observed in the destination');
      return { status: 200, body: messageInfo(moved[0], scope, input.destination.path, false) };
    }
    var reply = composeMail(mail, input, selected.message);
    resolveAccount(mail, input);
    if (mail.send(reply) !== true) mailFailure(409, 'send_uncertain', 'Mail did not confirm the reply send command');
    return { status: 202, body: { status: 'accepted_by_mail', deliveryConfirmed: false, replyToMessageId: input.target.messageId } };
  }
  if (operation === 'draft' || operation === 'send') {
    var outgoing = composeMail(mail, input, null);
    if (operation === 'draft') { mail.save(outgoing); return { status: 201, body: { status: 'saved_draft', outgoingId: Number(outgoing.id()), sender: scope.email } }; }
    resolveAccount(mail, input);
    if (mail.send(outgoing) !== true) mailFailure(409, 'send_uncertain', 'Mail did not confirm the send command');
    return { status: 202, body: { status: 'accepted_by_mail', deliveryConfirmed: false, sender: scope.email } };
  }
  mailFailure(400, 'unknown_operation', 'Unknown Mail operation');
}
function dispatch(json) {
  try { return JSON.stringify(mailDispatch(JSON.parse(json), Application('com.apple.mail'))); }
  catch (error) { return JSON.stringify({ status: error.status || 502, body: { error: { code: error.code || 'mail_automation_error', message: error.message || String(error) } } }); }
}
