import fs from 'node:fs/promises';
import path from 'node:path';
import { buildHelper } from '../shared/runtime.js';
if (process.platform !== 'darwin') throw new Error('Native helper builds require macOS.');
export async function buildAll(root = path.resolve(import.meta.dirname, '..'), dataRoot = path.join(root, '.build')) {
  const results = {};
  for (const id of ['apple-reminders', 'apple-calendar', 'apple-mail']) {
    const dir = path.join(root, 'plugins', id), manifest = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8'));
    const frameworks = id === 'apple-mail' ? ['Foundation', 'AppKit', 'OSAKit'] : ['Foundation', 'EventKit'];
    results[id] = await buildHelper({ dir, manifest, dataDir: path.join(dataRoot, id) }, frameworks);
    console.log(`Built ${id}`);
  }
  return results;
}
if (process.argv[1] === import.meta.filename) await buildAll();
