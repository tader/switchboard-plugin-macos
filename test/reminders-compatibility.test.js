import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { createHash } from 'node:crypto';

test('Moved Reminders accepts existing credentials before and after reload without reconnecting', async () => {
  const dir = path.resolve('plugins/apple-reminders'), dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reminders-compatibility-'));
  const originalCreate = http.createServer, originalSpawn = childProcess.spawn, originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const source = await fs.readFile(path.join(dir, 'helper.swift')), plist = await fs.readFile(path.join(dir, 'Info.plist'));
  await fs.writeFile(path.join(dataDir, 'helper-version'), createHash('sha256').update(source).update(plist).digest('hex'));
  await fs.writeFile(path.join(dataDir, 'apple-reminders-helper'), 'unused fixture binary');
  let handler, helperCalls = 0;
  http.createServer = callback => {
    handler = callback;
    return { once() {}, listen(port, host, ready) { ready(); }, address: () => ({ port: 12345 }), close: callback => callback() };
  };
  childProcess.spawn = (executable, args) => {
    assert.equal(executable, path.join(dataDir, 'apple-reminders-helper')); assert.deepEqual(args, []);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
    let json = ''; child.stdin.on('data', chunk => { json += chunk; });
    child.stdin.on('finish', () => { const input = JSON.parse(json); assert.notEqual(input.operation, 'authorize', 'Existing credentials must not request authorization again'); helperCalls++; child.stdout.emit('data', Buffer.from(JSON.stringify({ status: 200, body: { items: [{ id: 'legacy-list', title: 'Fixture' }] } }))); child.emit('exit', 0); });
    return child;
  };
  syncBuiltinESMExports(); Object.defineProperty(process, 'platform', { value: 'darwin' });
  try {
    const setup = (await import('../plugins/apple-reminders/index.ts')).default;
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8'));
    const existing = { credentials: { token: 'the-existing-encrypted-token-after-Switchboard-decrypts-it' }, account: { id: 'local', label: 'Reminders on this Mac' }, serviceId: 'apple-reminders', methodId: 'eventkit' };
    for (let reload = 0; reload < 2; reload++) {
      const instance = await setup({ dir, dataDir, manifest, log: console });
      const service = instance.services[0], auth = service.authMethods[0];
      assert.equal(service.id, existing.serviceId); assert.equal(auth.id, existing.methodId);
      const request = { url: new URL('/lists', service.baseUrl), headers: new Headers() };
      auth.authorize(request, existing);
      let status, body;
      const incoming = Readable.from([]); Object.assign(incoming, { method: 'GET', url: '/lists', headers: { authorization: request.headers.get('authorization') } });
      await handler(incoming, { writeHead(value) { status = value; }, end(value) { body = JSON.parse(value); } });
      assert.equal(status, 200); assert.equal(body.items[0].id, 'legacy-list');
      assert.equal(existing.credentials.token, 'the-existing-encrypted-token-after-Switchboard-decrypts-it');
      await instance.dispose();
    }
    assert.equal(helperCalls, 2);
  } finally {
    http.createServer = originalCreate; childProcess.spawn = originalSpawn; syncBuiltinESMExports(); Object.defineProperty(process, 'platform', originalPlatform);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
