import { gunzipSync } from 'node:zlib';

const dependencySections = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'devDependencies',
];

export function readTarEntries(compressedArchive) {
  const archive = gunzipSync(compressedArchive);
  const entries = new Map();
  let offset = 0;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const entryPath = prefix ? `${prefix}/${name}` : name;
    const sizeText = readTarString(header, 124, 12).trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Invalid tar entry size for ${entryPath || '<unnamed>'}`);
    }

    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > archive.length) throw new Error(`Truncated tar entry: ${entryPath}`);
    entries.set(entryPath, archive.subarray(contentStart, contentEnd));
    offset = contentStart + Math.ceil(size / 512) * 512;
  }

  return entries;
}

export function validatePackedManifest({ sourceManifest, packedManifest, workspaceVersions }) {
  const failures = [];
  if (packedManifest.name !== sourceManifest.name) failures.push('packed name differs from package.json');
  if (packedManifest.version !== sourceManifest.version) failures.push('packed version differs from package.json');
  if (packedManifest.private === true) failures.push('packed manifest is private');

  for (const section of dependencySections) {
    const sourceDependencies = sourceManifest[section] ?? {};
    const packedDependencies = packedManifest[section] ?? {};
    for (const [name, sourceRange] of Object.entries(sourceDependencies)) {
      const packedRange = packedDependencies[name];
      if (typeof packedRange !== 'string') {
        failures.push(`${section}.${name} is missing from the packed manifest`);
        continue;
      }
      if (packedRange.startsWith('workspace:')) {
        failures.push(`${section}.${name} retained unresolved range ${packedRange}`);
        continue;
      }
      const workspaceVersion = workspaceVersions.get(name);
      if (workspaceVersion === undefined || typeof sourceRange !== 'string' || !sourceRange.startsWith('workspace:')) continue;
      const expectedRange = packedWorkspaceRange(sourceRange, workspaceVersion);
      if (packedRange !== expectedRange) {
        failures.push(`${section}.${name} resolved to ${packedRange}; expected ${expectedRange}`);
      }
    }
  }

  return failures;
}

export function declaredEntrypoints(manifest) {
  const entrypoints = new Set();
  addEntrypoint(entrypoints, manifest.main);
  addEntrypoint(entrypoints, manifest.module);
  addEntrypoint(entrypoints, manifest.types);
  if (typeof manifest.bin === 'string') addEntrypoint(entrypoints, manifest.bin);
  else for (const value of Object.values(manifest.bin ?? {})) addEntrypoint(entrypoints, value);
  collectExportEntrypoints(entrypoints, manifest.exports);
  return [...entrypoints].sort();
}

function packedWorkspaceRange(sourceRange, version) {
  const selector = sourceRange.slice('workspace:'.length);
  if (selector === '*' || selector === '') return version;
  if (selector === '^') return `^${version}`;
  if (selector === '~') return `~${version}`;
  return selector;
}

function collectExportEntrypoints(entrypoints, value) {
  if (typeof value === 'string') {
    addEntrypoint(entrypoints, value);
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const child of Object.values(value)) collectExportEntrypoints(entrypoints, child);
}

function addEntrypoint(entrypoints, value) {
  if (typeof value !== 'string') return;
  const normalized = value.replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('../') || normalized.startsWith('/')) return;
  entrypoints.add(normalized);
}

function readTarString(buffer, offset, length) {
  const end = buffer.indexOf(0, offset);
  const boundedEnd = end < 0 || end > offset + length ? offset + length : end;
  return buffer.toString('utf8', offset, boundedEnd);
}
