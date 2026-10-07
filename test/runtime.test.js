import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createAdapter, Ledger, SerialQueue, page, pageResult, runHelper } from '../shared/runtime.js';
import { definition as mailDefinition } from '../plugins/apple-mail/index.js';
import { definition as calendarDefinition } from '../plugins/apple-calendar/index.js';
import { fixture } from './mail-fixture.js';

export function fakeServer() {
  let handler;
  const server = { once() {}, listen(port, host, ready) { assert.equal(host, '127.0.0.1'); ready(); }, address: () => ({ port: 12345 }), close: callback => callback(), closeIdleConnections() {} };
  return {
    createServer(callback) { handler = callback; return server; },
    async request(method, url, body, headers = {}) {
      const request = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
      Object.assign(request, { method, url, headers });
      let result;
      await handler(request, { destroyed: false, writeHead(status, headers) { result = { status, headers }; }, end(value) { result.body = JSON.parse(value); } });
      return result;
    },
  };
}
async function context(id, t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'macos-runtime-test-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { dataDir, manifest: { id, name: id }, dir: path.resolve('plugins', id), log: console };
}
function invocation(service, connection, method, pathname) {
  const request = { method, url: new URL(pathname, service.baseUrl), headers: new Headers() };
  service.authMethods[0].authorize(request, connection);
  return { url: request.url.pathname + request.url.search, headers: { authorization: request.headers.get('authorization') } };
}
test('Native adapters advertise nothing off macOS', async t => {
  assert.deepEqual(await createAdapter(await context('apple-mail', t), mailDefinition, { platform: 'linux', createServer: () => { throw new Error('must not listen'); } }), {});
});
test('Request capabilities bind account, method and URL, expire on revoke and cannot replay', async t => {
  const ctx = await context('apple-mail', t), fake = fixture(), transport = fakeServer();
  const instance = await createAdapter(ctx, mailDefinition, { platform: 'darwin', createServer: transport.createServer, runNative: async input => fake.dispatch(input) });
  t.after(() => instance.dispose());
  const service = instance.services[0], auth = service.authMethods[0];
  const connected = await auth.connect({ config: { email: 'me@example.test' } });
  const connection = { credentials: connected.credentials };
  let request = invocation(service, connection, 'GET', '/account');
  assert.equal((await transport.request('GET', request.url, undefined, request.headers)).body.id, 'account-a');
  assert.equal((await transport.request('GET', request.url, undefined, request.headers)).status, 401);
  request = invocation(service, connection, 'GET', '/account');
  assert.equal((await transport.request('GET', '/mailboxes', undefined, request.headers)).status, 403);
  request = invocation(service, connection, 'GET', '/account');
  assert.equal((await transport.request('POST', request.url, {}, request.headers)).status, 403);
  request = invocation(service, connection, 'GET', '/account'); await auth.revoke(connection);
  assert.equal((await transport.request('GET', request.url, undefined, request.headers)).status, 401);
  assert.equal((await transport.request('GET', '/account')).status, 401);
});
test('Send retries survive adapter reload and conflict on changed payloads', async t => {
  const ctx = await context('apple-mail', t), fake = fixture();
  let transport = fakeServer();
  let instance = await createAdapter(ctx, mailDefinition, { platform: 'darwin', createServer: transport.createServer, runNative: async input => fake.dispatch(input) });
  let service = instance.services[0]; const connection = { credentials: (await service.authMethods[0].connect({ config: { email: 'me@example.test' } })).credentials };
  const body = { to: ['alice@example.test'], subject: 'Fixture', text: 'One message', idempotencyKey: 'send-reload-0001' };
  async function send(payload) { const req = invocation(service, connection, 'POST', '/messages/send'); return transport.request('POST', req.url, payload, req.headers); }
  assert.equal((await send(body)).status, 202);
  await instance.dispose(); transport = fakeServer();
  instance = await createAdapter(ctx, mailDefinition, { platform: 'darwin', createServer: transport.createServer, runNative: async input => fake.dispatch(input) });
  service = instance.services[0]; t.after(() => instance.dispose());
  const result = await send(body); assert.equal(result.body.replayed, true); assert.equal(fake.stats().sends, 1);
  assert.equal((await send({ ...body, text: 'Different message' })).status, 409); assert.equal(fake.stats().sends, 1);
  await instance.dispose(); assert.throws(() => invocation(service, connection, 'GET', '/account'), /unloaded/);
});
test('Malformed JSON and oversized bodies never reach Mail', async t => {
  const ctx = await context('apple-mail', t), fake = fixture(), transport = fakeServer();
  const instance = await createAdapter(ctx, mailDefinition, { platform: 'darwin', createServer: transport.createServer, runNative: async input => fake.dispatch(input) }); t.after(() => instance.dispose());
  const service = instance.services[0], connection = { credentials: (await service.authMethods[0].connect({ config: { email: 'me@example.test' } })).credentials };
  for (const [body, expected] of [['{bad', 400], ['x'.repeat(129 * 1024), 413]]) {
    const req = invocation(service, connection, 'POST', '/messages/send');
    assert.equal((await transport.request('POST', req.url, body, req.headers)).status, expected);
  }
  assert.equal(fake.stats().sends, 0);
});
test('A crash or negative native receipt keeps durable intent and prevents another mutation', async t => {
  const ctx = await context('apple-mail', t); const ledger = new Ledger(path.join(ctx.dataDir, 'ledger.json'));
  let attempts = 0;
  const execute = async () => { attempts++; throw new Error('lost native response'); };
  await assert.rejects(ledger.run('uncertain-key', ['send', 'text'], execute), /could not be confirmed/);
  await assert.rejects(new Ledger(ledger.file).run('uncertain-key', ['send', 'text'], execute), /already attempted|attempted but not confirmed/);
  assert.equal(attempts, 1);
  const negative = new Ledger(path.join(ctx.dataDir, 'negative.json'));
  await assert.rejects(negative.run('negative-key', ['draft'], async () => ({ status: 502, body: { error: 'failed' } })), /could not be confirmed/);
  await assert.rejects(negative.run('negative-key', ['draft'], execute), /attempted but not confirmed/);
});
test('Concurrent native calls serialize and queue limits reject excess work', async () => {
  const queue = new SerialQueue(2); let release, active = 0, max = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const task = async () => { active++; max = Math.max(max, active); await gate; active--; };
  const a = queue.run('native', task), b = queue.run('native', task);
  await assert.rejects(queue.run('native', task), /queue is full/);
  release(); await Promise.all([a, b]); await queue.drain(); assert.equal(max, 1);
});
test('New pagination tokens bind account, path, page size and filters', () => {
  const first = page(new URL('http://local/messages?query=review&pageSize=2'), 'a');
  const result = pageResult({ items: [], nextOffset: 7, truncated: true }, first.fingerprint);
  assert.equal(page(new URL(`http://local/messages?pageSize=2&query=review&nextToken=${result.nextToken}`), 'a').offset, 7);
  for (const [account, path] of [['b', 'messages'], ['a', 'mailboxes']]) assert.throws(() => page(new URL(`http://local/${path}?query=review&pageSize=2&nextToken=${result.nextToken}`), account), /another account or query/);
});
test('Calendar create retries use the same durable result', async t => {
  const ctx = await context('apple-calendar', t), transport = fakeServer(); let creations = 0;
  const instance = await createAdapter(ctx, calendarDefinition, { platform: 'darwin', createServer: transport.createServer, runNative: async input => input.operation === 'authorize' ? ({ status: 200, body: { authorized: true } }) : ({ status: 201, body: { id: `event-${++creations}` } }) }); t.after(() => instance.dispose());
  const service = instance.services[0], connection = { credentials: (await service.authMethods[0].connect()).credentials };
  const body = { title: 'Fixture', startDate: '2026-10-07T12:00:00Z', endDate: '2026-10-07T13:00:00Z', idempotencyKey: 'calendar-create-0001' };
  for (let i = 0; i < 2; i++) { const req = invocation(service, connection, 'POST', '/events'); assert.equal((await transport.request('POST', req.url, body, req.headers)).status, 201); }
  assert.equal(creations, 1);
});
test('Native process timeouts kill the child and invalid results fail clearly', async () => {
  function child() { const value = new EventEmitter(); value.stdout = new PassThrough(); value.stderr = new PassThrough(); value.stdin = new PassThrough(); value.kill = () => { value.killed = true; }; return value; }
  const stalled = child();
  await assert.rejects(runHelper('fixture', {}, { spawnProcess: () => stalled, timeoutMs: 5 }), /timed out/); assert.equal(stalled.killed, true);
  const malformed = child();
  const result = runHelper('fixture', {}, { spawnProcess: () => malformed }); malformed.stdout.end('not json'); malformed.emit('close', 0);
  await assert.rejects(result, /invalid JSON/);
});
