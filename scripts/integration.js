import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Optional installer integration against an actual Switchboard checkout. All
// data, encryption keys, tarballs and installed copies live in a temporary dir.
const source = path.resolve(process.env.SWITCHBOARD_ROOT ?? '../switchboard');
const root = path.resolve(import.meta.dirname, '..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'macos-install-integration-'));
const originalFetch = globalThis.fetch, originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
let manager;
try {
  process.env.SWITCHBOARD_DATA_DIR = path.join(temporary, 'data');
  process.env.SWITCHBOARD_BUILTIN_PLUGINS_DIR = path.join(temporary, 'empty-builtins');
  process.env.SWITCHBOARD_WATCH_PLUGINS = 'false';
  await fs.mkdir(process.env.SWITCHBOARD_DATA_DIR, { recursive: true });
  Object.defineProperty(process, 'platform', { value: 'linux' }); // No native helper or privacy prompt during installation tests.
  const tar = createRequire(path.join(source, 'package.json'))('tar');
  const extracted = path.join(temporary, 'archive', 'repo');
  await fs.mkdir(extracted, { recursive: true });
  await fs.cp(path.join(root, 'plugins'), path.join(extracted, 'plugins'), { recursive: true });
  const archive = path.join(temporary, 'plugins.tgz');
  await tar.c({ gzip: true, file: archive, cwd: path.dirname(extracted) }, ['repo']);
  const contents = await fs.readFile(archive);
  globalThis.fetch = async input => {
    const url = String(input);
    if (url === 'https://api.github.com/repos/tader/switchboard-plugin-macos/commits/HEAD') return new Response('fixture-commit');
    if (url === 'https://api.github.com/repos/tader/switchboard-plugin-macos/tarball/fixture-commit') return new Response(contents);
    throw new Error(`Unexpected network request: ${url}`);
  };
  const load = file => import(pathToFileURL(path.join(source, 'server', file)).href);
  (await load('crypto.ts')).initKey(); (await load('db.ts')).initDb();
  manager = (await load('plugins/manager.ts')).plugins;
  await manager.start();
  const github = await load('plugins/github.ts');
  const ids = await github.install({ repo: 'tader/switchboard-plugin-macos' });
  assert.deepEqual(ids.sort(), ['apple-calendar', 'apple-mail', 'apple-reminders']);
  for (const id of ids) { assert.equal(manager.get(id).status, 'active'); assert.equal(manager.get(id).source.path, `plugins/${id}`); }
  for (const id of ids) await github.uninstall(id);
  const one = await github.install({ repo: 'tader/switchboard-plugin-macos', path: 'plugins/apple-mail' });
  assert.deepEqual(one, ['apple-mail']); assert.equal(manager.get('apple-mail').status, 'active');
  assert.throws(() => manager.get('apple-calendar')); assert.throws(() => manager.get('apple-reminders'));
  console.log('Actual Switchboard installer: whole repository, three independent copied plugins, uninstall and single-folder installation passed. No native data was accessed.');
} finally {
  await manager?.stop(); globalThis.fetch = originalFetch; Object.defineProperty(process, 'platform', originalPlatform);
  await fs.rm(temporary, { recursive: true, force: true });
}
