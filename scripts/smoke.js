import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAdapter } from '../shared/runtime.js';
const root = path.resolve(import.meta.dirname, '..'), temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'macos-plugins-smoke-'));
try {
  // Switchboard copies each plugin separately for installation and hot reload.
  for (const id of ['apple-reminders', 'apple-calendar', 'apple-mail']) {
    const dir = path.join(temporary, id);
    await fs.cp(path.join(root, 'plugins', id), dir, { recursive: true });
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8'));
    const mod = await import(pathToFileURL(path.join(dir, manifest.main ?? 'index.ts')).href);
    assert.equal(typeof mod.default, 'function');
    console.log(`Standalone copied plugin imports: ${id}`);
  }
  const { definition } = await import('../plugins/apple-calendar/index.js');
  const instance = await createAdapter({ manifest: { id: 'apple-calendar', name: 'Apple Calendar' }, dataDir: temporary }, definition, {
    platform: 'darwin', runNative: async input => input.operation === 'authorize' ? { status: 200, body: { authorized: true } } : { status: 200, body: { items: [{ id: 'fixture-calendar', title: 'Fixture calendar' }] } },
  });
  try {
    const service = instance.services[0], auth = service.authMethods[0], connection = { credentials: (await auth.connect()).credentials };
    const request = { method: 'GET', url: new URL('/calendars', service.baseUrl), headers: new Headers() };
    auth.authorize(request, connection);
    const response = await fetch(request.url, { headers: request.headers });
    assert.equal(response.status, 200); assert.equal((await response.json()).items[0].id, 'fixture-calendar');
    assert.equal((await fetch(request.url, { headers: request.headers })).status, 401);
    console.log('Real loopback adapter, credential authorization and replay rejection passed. No native data was accessed.');
  } finally { await instance.dispose(); }
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
