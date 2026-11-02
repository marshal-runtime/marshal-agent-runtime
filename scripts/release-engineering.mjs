import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const authorityTemplatePath = path.join(repositoryRoot, '.github', 'release-authority.example.json');
export const authorityPath = path.join(repositoryRoot, '.github', 'release-authority.json');
export const sbomPath = path.join(repositoryRoot, 'docs', 'release', 'sbom.spdx.json');
export const licenseInventoryPath = path.join(repositoryRoot, 'docs', 'release', 'license-inventory.json');

export async function readWorkspacePackages(root = repositoryRoot) {
  const packagesRoot = path.join(root, 'packages');
  const entries = (await readdir(packagesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  const packages = [];
  for (const entry of entries) {
    const manifestPath = path.join(packagesRoot, entry.name, 'package.json');
    if (!(await exists(manifestPath))) continue;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    packages.push({
      directory: entry.name,
      root: path.dirname(manifestPath),
      manifestPath,
      manifest,
      name: manifest.name,
      version: manifest.version,
    });
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

export function dependencyOrderedMatrix(packages) {
  const byName = new Map(packages.map((item) => [item.name, item]));
  const internalDependencies = new Map();
  for (const item of packages) {
    const names = new Set();
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const dependency of Object.keys(item.manifest[section] ?? {})) {
        if (byName.has(dependency)) names.add(dependency);
      }
    }
    internalDependencies.set(item.name, [...names].sort());
  }

  const result = [];
  const visiting = [];
  const completed = new Set();
  function visit(name) {
    if (completed.has(name)) return;
    const cycleStart = visiting.indexOf(name);
    if (cycleStart >= 0) {
      throw new Error(`Internal package dependency cycle: ${[...visiting.slice(cycleStart), name].join(' -> ')}`);
    }
    visiting.push(name);
    for (const dependency of internalDependencies.get(name) ?? []) visit(dependency);
    visiting.pop();
    completed.add(name);
    result.push(name);
  }
  for (const name of [...byName.keys()].sort()) visit(name);

  return result.map((name, index) => ({
    order: index + 1,
    name,
    version: byName.get(name).version,
    directory: byName.get(name).directory,
    internalDependencies: internalDependencies.get(name),
  }));
}

export function renderAuthorityTemplate(packages) {
  return {
    schemaVersion: 1,
    source: {
      repositoryUrl: null,
      homepageUrl: null,
      bugsUrl: null,
    },
    npm: {
      registryUrl: null,
      scope: null,
      access: null,
      tag: null,
    },
    release: {
      packageVersions: Object.fromEntries(packages.map((item) => [item.name, null])),
    },
    licenses: {
      approvedExpressions: null,
      reviewReference: null,
    },
    github: {
      serverUrl: null,
      repository: null,
      environment: null,
      workflowPath: '.github/workflows/publish.yml',
      trustedPublisher: {
        owner: null,
        repository: null,
        workflowFilename: 'publish.yml',
        environment: null,
      },
    },
  };
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export function validateAuthority(authority, packages, { template = false } = {}) {
  const failures = [];
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) {
    return ['release authority must be a JSON object'];
  }
  if (authority.schemaVersion !== 1) failures.push('schemaVersion must be 1');
  rejectCredentialFields(authority, [], failures);

  const expectedPackageNames = packages.map((item) => item.name).sort();
  const configuredVersions = authority.release?.packageVersions;
  if (!configuredVersions || typeof configuredVersions !== 'object' || Array.isArray(configuredVersions)) {
    failures.push('release.packageVersions must be an object');
  } else {
    const configuredNames = Object.keys(configuredVersions).sort();
    if (JSON.stringify(configuredNames) !== JSON.stringify(expectedPackageNames)) {
      failures.push('release.packageVersions must list every publishable package exactly once');
    }
  }

  const authorityValues = [
    ['source.repositoryUrl', authority.source?.repositoryUrl],
    ['source.homepageUrl', authority.source?.homepageUrl],
    ['source.bugsUrl', authority.source?.bugsUrl],
    ['npm.registryUrl', authority.npm?.registryUrl],
    ['npm.scope', authority.npm?.scope],
    ['npm.access', authority.npm?.access],
    ['npm.tag', authority.npm?.tag],
    ['github.serverUrl', authority.github?.serverUrl],
    ['github.repository', authority.github?.repository],
    ['github.environment', authority.github?.environment],
    ['github.trustedPublisher.owner', authority.github?.trustedPublisher?.owner],
    ['github.trustedPublisher.repository', authority.github?.trustedPublisher?.repository],
    ['github.trustedPublisher.environment', authority.github?.trustedPublisher?.environment],
  ];

  if (template) {
    for (const [label, value] of authorityValues) {
      if (value !== null) failures.push(`${label} must remain null in the authority template`);
    }
    for (const [name, version] of Object.entries(configuredVersions ?? {})) {
      if (version !== null) failures.push(`release.packageVersions.${name} must remain null in the authority template`);
    }
  } else {
    for (const [label, value] of authorityValues) {
      if (typeof value !== 'string' || !value.trim()) failures.push(`${label} must be explicitly authorized`);
    }
    if (!/^https:\/\//.test(authority.source?.repositoryUrl ?? '')) {
      failures.push('source.repositoryUrl must be an HTTPS URL');
    }
    for (const key of ['homepageUrl', 'bugsUrl']) {
      if (!/^https:\/\//.test(authority.source?.[key] ?? '')) failures.push(`source.${key} must be an HTTPS URL`);
    }
    if (!/^https:\/\//.test(authority.npm?.registryUrl ?? '')) failures.push('npm.registryUrl must be an HTTPS URL');
    if (!/^@[a-z0-9][a-z0-9._-]*$/.test(authority.npm?.scope ?? '')) failures.push('npm.scope must be a valid scoped npm owner');
    if (!['public', 'restricted'].includes(authority.npm?.access)) failures.push('npm.access must be public or restricted');
    if (!/^[a-z][a-z0-9._-]*$/.test(authority.npm?.tag ?? '') || /^v?\d+(?:\.\d+){0,2}$/.test(authority.npm?.tag ?? '')) {
      failures.push('npm.tag must be a non-version npm distribution tag');
    }
    if (!/^[^/\s]+\/[^/\s]+$/.test(authority.github?.repository ?? '')) failures.push('github.repository must be owner/repository');
    if (!/^https:\/\//.test(authority.github?.serverUrl ?? '')) failures.push('github.serverUrl must be an HTTPS URL');
    if (authority.github?.workflowPath !== '.github/workflows/publish.yml') {
      failures.push('github.workflowPath must be .github/workflows/publish.yml');
    }
    if (authority.github?.trustedPublisher?.workflowFilename !== 'publish.yml') {
      failures.push('github.trustedPublisher.workflowFilename must be publish.yml');
    }
    const [owner, repository] = String(authority.github?.repository ?? '').split('/');
    if (authority.source?.repositoryUrl !== `${String(authority.github?.serverUrl ?? '').replace(/\/$/, '')}/${authority.github?.repository}.git`) {
      failures.push('source.repositoryUrl must identify the authorized GitHub repository');
    }
    if (authority.github?.trustedPublisher?.owner !== owner) failures.push('trusted publisher owner must match github.repository');
    if (authority.github?.trustedPublisher?.repository !== repository) failures.push('trusted publisher repository must match github.repository');
    if (authority.github?.trustedPublisher?.environment !== authority.github?.environment) {
      failures.push('trusted publisher environment must match github.environment');
    }
    for (const item of packages) {
      const configured = configuredVersions?.[item.name];
      if (configured !== item.version) failures.push(`${item.name}: authorized version must equal package.json version ${item.version}`);
      if (!item.name.startsWith(`${authority.npm?.scope}/`)) failures.push(`${item.name}: package is outside authorized npm.scope`);
    }
  }
  return failures;
}

export function validatePackageReleaseMetadata(packages, authority) {
  const failures = [];
  for (const item of packages) {
    const manifest = item.manifest;
    if (manifest.publishConfig?.access !== authority.npm.access) {
      failures.push(`${item.name}: publishConfig.access does not match authorized npm.access`);
    }
    const repository = manifest.repository;
    if (repository?.type !== 'git' || repository?.url !== authority.source.repositoryUrl) {
      failures.push(`${item.name}: repository.type/url must match authorized source.repositoryUrl`);
    }
    if (repository?.directory !== `packages/${item.directory}`) {
      failures.push(`${item.name}: repository.directory must be packages/${item.directory}`);
    }
    if (manifest.homepage !== authority.source.homepageUrl) failures.push(`${item.name}: homepage must match authorized source.homepageUrl`);
    if (manifest.bugs?.url !== authority.source.bugsUrl) failures.push(`${item.name}: bugs.url must match authorized source.bugsUrl`);
  }
  return failures;
}

export function validateLicenseAuthority(authority, licenseInventory, { template = false } = {}) {
  const failures = [];
  const approved = authority.licenses?.approvedExpressions;
  const reviewReference = authority.licenses?.reviewReference;
  if (template) {
    if (approved !== null) failures.push('licenses.approvedExpressions must remain null in the authority template');
    if (reviewReference !== null) failures.push('licenses.reviewReference must remain null in the authority template');
    return failures;
  }
  if (!Array.isArray(approved) || approved.some((item) => typeof item !== 'string' || !item.trim())) {
    failures.push('licenses.approvedExpressions must explicitly list reviewed license expressions');
  } else {
    const approvedSet = new Set(approved);
    for (const entry of licenseInventory.licenses) {
      if (!approvedSet.has(entry.license)) failures.push(`license expression requires explicit approval: ${entry.license}`);
    }
    for (const expression of approvedSet) {
      if (!licenseInventory.licenses.some((entry) => entry.license === expression)) failures.push(`approved license expression is not present in the deterministic inventory: ${expression}`);
    }
  }
  if (typeof reviewReference !== 'string' || !reviewReference.trim()) {
    failures.push('licenses.reviewReference must identify the human/legal review record');
  }
  if (licenseInventory.unresolvedLicenses.length) {
    failures.push(`unresolved licenses cannot be published: ${licenseInventory.unresolvedLicenses.join(', ')}`);
  }
  return failures;
}

export function validatePublishEnvironment(authority, environment) {
  const failures = [];
  const required = {
    GITHUB_ACTIONS: 'true',
    CI: 'true',
    MARSHAL_RELEASE_CONFIRMATION: 'publish-with-provenance',
    GITHUB_REPOSITORY: authority.github.repository,
    MARSHAL_NPM_ENVIRONMENT: authority.github.environment,
  };
  for (const [name, expected] of Object.entries(required)) {
    if (environment[name] !== expected) failures.push(`${name} must equal ${JSON.stringify(expected)}`);
  }
  if (!environment.ACTIONS_ID_TOKEN_REQUEST_URL || !environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    failures.push('GitHub OIDC identity token variables are required');
  }
  if (!/^[0-9a-f]{40}$/i.test(environment.GITHUB_SHA ?? '')) failures.push('GITHUB_SHA must be a full commit SHA');
  if (environment.MARSHAL_RELEASE_COMMIT !== environment.GITHUB_SHA) failures.push('MARSHAL_RELEASE_COMMIT must equal GITHUB_SHA');
  if (environment.MARSHAL_RELEASE_TAG !== authority.npm.tag) failures.push('MARSHAL_RELEASE_TAG must match authorized npm.tag');
  if (environment.MARSHAL_RELEASE_ACCESS !== authority.npm.access) failures.push('MARSHAL_RELEASE_ACCESS must match authorized npm.access');
  return failures;
}

export async function buildInventory(packages, root = repositoryRoot) {
  const lockBytes = await readFile(path.join(root, 'pnpm-lock.yaml'));
  const licenseBytes = await readFile(path.join(root, 'LICENSE'));
  const lockSha256 = sha256(lockBytes);
  const canonicalLicenseSha256 = sha256(licenseBytes);
  const external = new Map();
  const relationships = [];

  for (const item of packages) {
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [dependency, requested] of Object.entries(item.manifest[section] ?? {}).sort()) {
        if (dependency.startsWith('@marshal/')) {
          relationships.push({ from: item.name, to: dependency, type: 'DEPENDS_ON', requested });
          continue;
        }
        const resolved = await resolveInstalledDependency(item.root, root, dependency);
        const key = `${dependency}@${resolved.version}`;
        external.set(key, {
          name: dependency,
          version: resolved.version,
          license: normalizeLicense(resolved.license),
          packageJson: slash(path.relative(root, resolved.manifestPath)),
        });
        relationships.push({ from: item.name, to: key, type: 'DEPENDS_ON', requested });
      }
    }
  }

  const workspace = packages.map((item) => ({
    name: item.name,
    version: item.version,
    license: item.manifest.license,
    licenseFileSha256: canonicalLicenseSha256,
    directory: `packages/${item.directory}`,
  }));
  const externalPackages = [...external.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
  relationships.sort((left, right) => `${left.from}\0${left.to}\0${left.requested}`.localeCompare(`${right.from}\0${right.to}\0${right.requested}`));

  const spdxIds = new Map();
  for (const item of [...workspace, ...externalPackages]) {
    const key = `${item.name}@${item.version}`;
    spdxIds.set(key, `SPDXRef-${slug(key)}-${sha256(key).slice(0, 12)}`);
  }
  const sbomPackages = [...workspace, ...externalPackages]
    .sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`))
    .map((item) => ({
      SPDXID: spdxIds.get(`${item.name}@${item.version}`),
      name: item.name,
      versionInfo: item.version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: item.license || 'NOASSERTION',
      licenseDeclared: item.license || 'NOASSERTION',
      copyrightText: 'NOASSERTION',
      externalRefs: [{
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: npmPurl(item.name, item.version),
      }],
    }));
  const byWorkspaceName = new Map(workspace.map((item) => [item.name, item]));
  const sbomRelationships = [
    ...workspace.map((item) => ({
      spdxElementId: 'SPDXRef-DOCUMENT',
      relationshipType: 'DESCRIBES',
      relatedSpdxElement: spdxIds.get(`${item.name}@${item.version}`),
    })),
    ...relationships.map((relationship) => {
      const from = byWorkspaceName.get(relationship.from);
      const target = byWorkspaceName.get(relationship.to);
      const externalTarget = external.get(relationship.to);
      return {
        spdxElementId: spdxIds.get(`${from.name}@${from.version}`),
        relationshipType: relationship.type,
        relatedSpdxElement: spdxIds.get(target ? `${target.name}@${target.version}` : `${externalTarget.name}@${externalTarget.version}`),
        comment: `Declared range: ${relationship.requested}`,
      };
    }),
  ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

  const sbom = {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: 'Marshal agent runtime npm publication set',
    documentNamespace: `urn:marshal:agent-runtime:spdx:${lockSha256}`,
    documentComment: 'Deterministic publication SBOM. It inventories workspace packages and their direct declared runtime/optional/peer dependencies; dependencies are references and are not bundled into Marshal tarballs.',
    creationInfo: {
      created: '1970-01-01T00:00:00Z',
      creators: ['Tool: marshal-release-inventory-1'],
      comment: 'The fixed timestamp is a deterministic sentinel, not wall-clock generation time.',
    },
    packages: sbomPackages,
    relationships: sbomRelationships,
  };
  const licenses = new Map();
  for (const item of [...workspace, ...externalPackages]) {
    const license = item.license || 'NOASSERTION';
    if (!licenses.has(license)) licenses.set(license, []);
    licenses.get(license).push(`${item.name}@${item.version}`);
  }
  const licenseInventory = {
    schemaVersion: 1,
    scope: 'published workspace packages plus direct declared dependency references; dependencies are not bundled',
    pnpmLockSha256: lockSha256,
    canonicalWorkspaceLicenseSha256: canonicalLicenseSha256,
    workspacePackages: workspace,
    externalDependencyReferences: externalPackages,
    licenses: [...licenses.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([license, components]) => ({ license, components: components.sort() })),
    unresolvedLicenses: [...licenses.get('NOASSERTION') ?? []].sort(),
  };
  return { sbom, licenseInventory };
}

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function resolveInstalledDependency(packageRoot, root, name) {
  const segments = name.split('/');
  for (const base of [packageRoot, root]) {
    const manifestPath = path.join(base, 'node_modules', ...segments, 'package.json');
    if (!(await exists(manifestPath))) continue;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.name !== name || typeof manifest.version !== 'string') continue;
    return { ...manifest, manifestPath };
  }
  throw new Error(`Installed manifest is missing for declared dependency ${name}; run the frozen pnpm install first`);
}

function rejectCredentialFields(value, parents, failures) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const location = [...parents, key].join('.');
    if (/(?:token|password|secret|otp|auth)$/i.test(key)) failures.push(`${location}: credentials are forbidden in release authority files`);
    rejectCredentialFields(child, [...parents, key], failures);
  }
}

function normalizeLicense(license) {
  if (typeof license === 'string' && license.trim()) return license.trim();
  if (Array.isArray(license)) return license.map(normalizeLicense).filter((item) => item !== 'NOASSERTION').join(' OR ') || 'NOASSERTION';
  if (license && typeof license === 'object' && typeof license.type === 'string') return license.type;
  return 'NOASSERTION';
}

function npmPurl(name, version) {
  const encodedName = name.startsWith('@') ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function slug(value) {
  return value.replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function slash(value) {
  return value.split(path.sep).join('/');
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
