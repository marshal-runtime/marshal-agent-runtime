// Restores the released @quillstone/* tarballs listed in quillstone.lock.json into vendor/quillstone/ and checks their sha256. The tarballs are committed, so CI and a fresh clone need no download and no credential;
// this script only repairs a missing or modified tarball and needs `gh` access to marshal-runtime/quillstone.
// pnpm-workspace.yaml overrides every @quillstone/* dependency to file:vendor/quillstone/<tarball>, so this must run before `pnpm install` (`pnpm bootstrap` does both; a root `preinstall` hook is too late, pnpm reads the tarballs first)
// Tarballs already present with the right sha256 are not downloaded again.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(join(root, 'quillstone.lock.json'), 'utf8'));
const out = join(root, 'vendor', 'quillstone');
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const stale = lock.packages.filter(({ file, sha256: expected }) => !existsSync(join(out, file)) || sha256(join(out, file)) !== expected);

if (stale.length > 0) {
  mkdirSync(out, { recursive: true });
  const ghEnv = { ...process.env };
  if (process.env.QUILLSTONE_TOKEN) ghEnv.GH_TOKEN = process.env.QUILLSTONE_TOKEN;
  for (const { file } of stale) {
    execFileSync('gh', ['release', 'download', lock.tag, '--repo', lock.repository, '--pattern', file, '--dir', out, '--clobber'], {
      env: ghEnv,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  }
}
const bad = lock.packages.filter(({ file, sha256: expected }) => !existsSync(join(out, file)) || sha256(join(out, file)) !== expected);
if (bad.length > 0) {
  console.error(`quillstone tarballs do not match quillstone.lock.json: ${bad.map(({ file }) => file).join(', ')}`);
  process.exit(1);
}
console.log(`quillstone ${lock.tag}: ${lock.packages.length} tarballs verified in vendor/quillstone`);
