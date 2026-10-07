import fs from 'node:fs/promises';
const source = await fs.readFile(new URL('../shared/runtime.js', import.meta.url));
for (const plugin of ['apple-mail', 'apple-calendar']) {
  const target = new URL(`../plugins/${plugin}/lib/runtime.js`, import.meta.url);
  if (process.argv.includes('--check')) {
    if (!source.equals(await fs.readFile(target))) throw new Error(`${plugin} runtime is stale. Run npm run sync.`);
  } else await fs.writeFile(target, source);
}
