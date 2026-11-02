#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { configuredPackageManager } from './package-manager.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootManifest = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
const packageManager = configuredPackageManager(rootManifest);

const steps = [
  [process.execPath, [path.join(repositoryRoot, 'scripts', 'validate-docs.mjs')]],
  [process.execPath, [path.join(repositoryRoot, 'scripts', 'run-workspace-script.mjs'), 'build']],
  [process.execPath, [
    packageManager.cli,
    '--filter',
    '@marshal/agent-runtime-conformance',
    'test',
  ]],
  [process.execPath, [path.join(repositoryRoot, 'scripts', 'smoke-detached-mcp.mjs')]],
  [process.execPath, ['--test', path.join(repositoryRoot, 'examples', 'publication', '__tests__', '*.test.mjs')]],
];

for (const [command, arguments_] of steps) {
  const result = spawnSync(command, arguments_, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

process.stdout.write('Offline publication documentation, conformance, and detached-package gates passed.\n');
