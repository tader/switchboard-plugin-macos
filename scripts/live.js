import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildAll } from './build-helpers.js';
import { runHelper } from '../shared/runtime.js';
const root = path.resolve(import.meta.dirname, '..');
const report = { startedAt: new Date().toISOString(), checks: [], mailWritesPerformed: false };
const helpers = await buildAll();
async function call(id, input) {
  const result = await runHelper(helpers[id], input, { args: id === 'apple-mail' ? [path.join(root, 'plugins/apple-mail/mail.js')] : [] });
  if (result.status < 200 || result.status >= 300) throw new Error(`${id}/${input.operation}: ${JSON.stringify(result.body)}`);
  return result.body;
}
try {
  const lists = await call('apple-reminders', { operation: 'lists', limit: 1 });
  report.checks.push({ name: 'Reminders read', listCountOnPage: lists.items.length });
  await call('apple-calendar', { operation: 'authorize' });
  const calendars = await call('apple-calendar', { operation: 'calendars', limit: 100 });
  report.checks.push({ name: 'Calendar read', calendarCountOnPage: calendars.items.length });
  const calendarId = process.env.APPLE_CALENDAR_ID || calendars.items.find(item => item.default && item.writable)?.id || calendars.items.find(item => item.writable)?.id;
  if (!calendarId) throw new Error('No writable calendar is available for the authorized live event test.');
  const start = new Date(Date.now() + 86400000); start.setUTCSeconds(0, 0);
  let target;
  try {
    const created = await call('apple-calendar', { operation: 'create', calendarId, title: `Switchboard temporary validation ${randomUUID()}`, startDate: start.toISOString(), endDate: new Date(start.getTime() + 600000).toISOString(), notes: 'Temporary plugin validation event. No attendees. Safe to delete.' });
    target = JSON.parse(Buffer.from(created.id, 'base64url').toString());
    // Persist cleanup identity before subsequent calls; never log personal calendar content.
    report.temporaryEvent = target;
    await fs.writeFile(path.join(root, '.build/live-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    const read = await call('apple-calendar', { operation: 'get', target }); assert.equal(read.id, created.id);
    const updated = await call('apple-calendar', { operation: 'update', target, notes: 'Temporary validation event updated successfully.' });
    target = JSON.parse(Buffer.from(updated.id, 'base64url').toString());
    report.checks.push({ name: 'Calendar create/read/update', passed: true });
  } finally {
    if (target) {
      await call('apple-calendar', { operation: 'delete', target });
      delete report.temporaryEvent; report.checks.push({ name: 'Calendar delete and cleanup', passed: true });
    }
  }
  if (process.env.APPLE_MAIL_EMAIL) {
    const account = await call('apple-mail', { operation: 'authorize', email: process.env.APPLE_MAIL_EMAIL });
    const mailboxes = await call('apple-mail', { operation: 'mailboxes', scope: account.scope, limit: 1 });
    const messages = await call('apple-mail', { operation: 'messages', scope: account.scope, limit: 1, maxScan: 1 });
    if (messages.items[0]) await call('apple-mail', { operation: 'get', scope: account.scope, target: JSON.parse(Buffer.from(messages.items[0].id, 'base64url').toString()) });
    report.checks.push({ name: 'Mail account/mailbox/message reads', mailboxCountOnPage: mailboxes.items.length, messageCountOnPage: messages.items.length });
  } else report.checks.push({ name: 'Mail reads', skipped: 'Set APPLE_MAIL_EMAIL to an address configured in Mail.' });
  report.success = true;
} catch (error) { report.success = false; report.error = error.message; process.exitCode = 1; }
report.finishedAt = new Date().toISOString();
await fs.writeFile(path.join(root, '.build/live-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
