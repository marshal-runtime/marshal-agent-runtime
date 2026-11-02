#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  buildInventory,
  licenseInventoryPath,
  readWorkspacePackages,
  sbomPath,
  stableJson,
} from './release-engineering.mjs';

const check = process.argv.includes('--check');
const packages = await readWorkspacePackages();
const inventory = await buildInventory(packages);
const outputs = [
  [sbomPath, stableJson(inventory.sbom)],
  [licenseInventoryPath, stableJson(inventory.licenseInventory)],
];
const failures = [];
for (const [file, expected] of outputs) {
  if (check) {
    let actual;
    try {
      actual = await readFile(file, 'utf8');
    } catch {
      failures.push(`${path.relative(process.cwd(), file)} is missing`);
      continue;
    }
    if (actual !== expected) failures.push(`${path.relative(process.cwd(), file)} is stale; run pnpm release:inventory`);
  } else {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, expected);
  }
}
if (failures.length) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${check ? 'Validated' : 'Generated'} deterministic SPDX and license inventories for ${packages.length} packages.\n`);
}
