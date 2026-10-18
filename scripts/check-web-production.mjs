import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root = resolve('apps/web/out');
async function walk(dir) {
  const files = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}
const files = await walk(root);
const forbidden = ['dd.preview.v2', 'LOCAL_PREVIEW_UNSUPPORTED', 'LOCAL PREVIEW · simulated data', 'DESIGN REVIEW · simulated data', 'Unknown operator preview endpoint', 'return["operators"]', "return\"local-preview\""];
for (const path of files) {
  if (path.includes('/__preview/')) throw new Error(`Demo route exported: ${path}`);
  if (!/\.(js|html|json)$/.test(path)) continue;
  const text = await readFile(path, 'utf8');
  for (const marker of forbidden) if (text.includes(marker)) throw new Error(`Demo marker ${marker} in ${path}`);
}
console.log('Production export contains no preview route or fixture/auth markers.');
