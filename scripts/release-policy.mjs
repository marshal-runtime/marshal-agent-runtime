#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import {
  authorityPath,
  authorityTemplatePath,
  buildInventory,
  readJson,
  readWorkspacePackages,
  renderAuthorityTemplate,
  stableJson,
  validateAuthority,
  validateLicenseAuthority,
  validatePackageReleaseMetadata,
} from './release-engineering.mjs';

const templateMode = process.argv.includes('--template');
const explicitIndex = process.argv.findIndex((argument) => argument === '--authority');
const file = templateMode
  ? authorityTemplatePath
  : explicitIndex >= 0
    ? path.resolve(process.argv[explicitIndex + 1] ?? '')
    : authorityPath;
const packages = await readWorkspacePackages();
const authority = await readJson(file);
const failures = validateAuthority(authority, packages, { template: templateMode });
const { licenseInventory } = await buildInventory(packages);
failures.push(...validateLicenseAuthority(authority, licenseInventory, { template: templateMode }));
if (templateMode && stableJson(authority) !== stableJson(renderAuthorityTemplate(packages))) {
  failures.push('.github/release-authority.example.json is stale or contains an authority decision');
}
if (!templateMode) failures.push(...validatePackageReleaseMetadata(packages, authority));
if (failures.length) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${templateMode ? 'Validated unconfigured authority template' : 'Validated explicit release authority and package metadata'} for ${packages.length} packages.\n`);
}
