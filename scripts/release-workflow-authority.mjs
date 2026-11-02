#!/usr/bin/env node
import process from 'node:process';
import {
  authorityPath,
  buildInventory,
  readJson,
  readWorkspacePackages,
  validateAuthority,
  validateLicenseAuthority,
  validatePackageReleaseMetadata,
} from './release-engineering.mjs';

const packages = await readWorkspacePackages();
const authority = await readJson(authorityPath);
const { licenseInventory } = await buildInventory(packages);
const failures = [
  ...validateAuthority(authority, packages),
  ...validateLicenseAuthority(authority, licenseInventory),
  ...validatePackageReleaseMetadata(packages, authority),
];
const expected = [
  ['github.serverUrl', authority.github?.serverUrl, process.env.GITHUB_SERVER_URL],
  ['github.repository', authority.github?.repository, process.env.MARSHAL_EXPECTED_REPOSITORY],
  ['github.environment', authority.github?.environment, process.env.MARSHAL_EXPECTED_ENVIRONMENT],
  ['npm.registryUrl', authority.npm?.registryUrl, process.env.MARSHAL_EXPECTED_REGISTRY],
  ['npm.tag', authority.npm?.tag, process.env.MARSHAL_EXPECTED_TAG],
  ['npm.access', authority.npm?.access, process.env.MARSHAL_EXPECTED_ACCESS],
];
for (const [label, configured, supplied] of expected) {
  if (!supplied || configured !== supplied) failures.push(`${label} does not match the explicit workflow authority`);
}
if (failures.length) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Workflow identity, environment, registry, tag, access, versions, and package metadata match explicit authority.\n');
}
