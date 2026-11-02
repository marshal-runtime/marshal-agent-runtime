#!/usr/bin/env node
import { access, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import {
  authorityPath,
  buildInventory,
  dependencyOrderedMatrix,
  readJson,
  readWorkspacePackages,
  repositoryRoot,
  stableJson,
  validateAuthority,
  validateLicenseAuthority,
  validatePackageReleaseMetadata,
  validatePublishEnvironment,
} from './release-engineering.mjs';
import { configuredPackageManager } from './package-manager.mjs';

const mode = process.argv.includes('--publish') ? 'publish' : process.argv.includes('--dry-run') ? 'dry-run' : 'plan';
const json = process.argv.includes('--json');
const rootIndex = process.argv.findIndex((argument) => argument === '--root');
const root = rootIndex >= 0 ? path.resolve(process.argv[rootIndex + 1] ?? '') : repositoryRoot;
const authorityIndex = process.argv.findIndex((argument) => argument === '--authority');
const configuredAuthority = authorityIndex >= 0 ? path.resolve(process.argv[authorityIndex + 1] ?? '') : root === repositoryRoot ? authorityPath : path.join(root, '.github', 'release-authority.json');
const packages = await readWorkspacePackages(root);
const matrix = dependencyOrderedMatrix(packages);
if (mode === 'plan') {
  process.stdout.write(json ? stableJson({ schemaVersion: 1, packages: matrix }) : renderMatrix(matrix));
  process.exit(0);
}

const authority = await readJson(configuredAuthority);
const { licenseInventory } = await buildInventory(packages, root);
const failures = [
  ...validateAuthority(authority, packages),
  ...validateLicenseAuthority(authority, licenseInventory),
  ...validatePackageReleaseMetadata(packages, authority),
];
if (mode === 'publish') failures.push(...validatePublishEnvironment(authority, process.env));
if (failures.length) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exit(1);
}

const rootManifest = await readJson(path.join(root, 'package.json'));
const packageManager = configuredPackageManager(rootManifest);
const npmCli = process.env.MARSHAL_NPM_CLI || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
await access(npmCli);
assertSupportedNpm(npmCli);
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'marshal-npm-release-'));
const results = [];
try {
  for (const row of matrix) {
    const item = packages.find((candidate) => candidate.name === row.name);
    const destination = path.join(temporaryRoot, String(row.order).padStart(2, '0'));
    await mkdir(destination, { recursive: true });
    const pack = spawnSync(process.execPath, [packageManager.cli, 'pack', '--pack-destination', destination], {
      cwd: item.root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    requireSuccess(pack, `${row.name}: pnpm pack`);
    const tarballs = (await readdir(destination)).filter((name) => name.endsWith('.tgz'));
    if (tarballs.length !== 1) throw new Error(`${row.name}: expected exactly one packed tarball`);
    const tarball = path.join(destination, tarballs[0]);
    const arguments_ = [
      npmCli,
      'publish',
      tarball,
      '--registry', authority.npm.registryUrl,
      '--access', authority.npm.access,
      '--tag', authority.npm.tag,
      '--json',
    ];
    if (mode === 'dry-run') arguments_.push('--dry-run', '--fetch-retries', '0', '--fetch-timeout', '1000');
    else arguments_.push('--provenance');
    const published = spawnSync(process.execPath, arguments_, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, NPM_CONFIG_PROVENANCE: mode === 'publish' ? 'true' : 'false' },
    });
    requireSuccess(published, `${row.name}: npm publish ${mode === 'dry-run' ? '--dry-run' : '--provenance'}`);
    results.push({ ...row, tarball: tarballs[0], mode, npm: parseJsonOutput(published.stdout) });
  }
} finally {
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  const resolvedSystemTemp = path.resolve(os.tmpdir());
  if (!resolvedTemporaryRoot.startsWith(`${resolvedSystemTemp}${path.sep}`)) throw new Error('Refusing to clean a release staging directory outside the system temporary directory');
  await rm(resolvedTemporaryRoot, { recursive: true, force: true });
}
process.stdout.write(stableJson({ schemaVersion: 1, mode, packages: results }));

function assertSupportedNpm(cli) {
  const result = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
  requireSuccess(result, 'npm --version');
  const [major, minor] = result.stdout.trim().split('.').map(Number);
  if (major < 11 || (major === 11 && minor < 5)) throw new Error(`npm >=11.5.0 is required for trusted publishing provenance; found ${result.stdout.trim()}`);
}

function requireSuccess(result, label) {
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed (${result.status ?? 'unknown'}): ${(result.stderr || result.stdout).trim()}`);
}

function parseJsonOutput(output) {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return { output: trimmed };
  }
}

function renderMatrix(rows) {
  return `${rows.map((row) => `${String(row.order).padStart(2, '0')} ${row.name}@${row.version}${row.internalDependencies.length ? ` after ${row.internalDependencies.join(', ')}` : ''}`).join('\n')}\n`;
}
