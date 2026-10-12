import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'apps/web/out');
const reviewOut = path.join(root, 'apps/web/review-out');
const build = spawnSync('pnpm', ['web:build'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, DROPDECK_DEMO: '1', DROPDECK_REVIEW_BUILD: '1' },
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
const html = readFileSync(path.join(out, 'index.html'), 'utf8');
if (!html.includes('Preparing local preview')) throw new Error('Review build did not include the scenario gallery entry point');
if (!existsSync(path.join(out, 'd/index.html')) || !existsSync(path.join(out, 'm/index.html'))) {
  throw new Error('Review build is missing buyer or merchant pages');
}
// A developer may have copied a real stage's public config locally. Never include it in the review site.
rmSync(path.join(out, 'config.json'), { force: true });
rmSync(reviewOut, { recursive: true, force: true });
renameSync(out, reviewOut);
console.log(`Review-only static export: ${reviewOut}`);
