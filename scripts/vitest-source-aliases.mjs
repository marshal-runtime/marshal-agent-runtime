import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultPackagesRoot = fileURLToPath(new URL('../packages/', import.meta.url));

export function workspaceSourceAliasPlan(rootPackageName, options = {}) {
  const packagesRoot = path.resolve(options.packagesRoot ?? defaultPackagesRoot);
  const manifests = workspaceManifests(packagesRoot);
  const rootPackage = manifests.get(rootPackageName);
  if (!rootPackage) {
    throw new Error(`Workspace source aliases could not find ${rootPackageName}.`);
  }

  const closure = workspaceClosure(
    manifests,
    rootPackageName,
    options.includeDevDependencies === true,
  );
  const entries = [];
  const seenSpecifiers = new Set();

  for (const packageName of closure) {
    const current = manifests.get(packageName);
    if (!current) continue;
    for (const [subpath, value] of manifestExports(current.manifest)) {
      if (subpath.includes('*')) {
        throw new Error(
          `Workspace source aliases require exact public exports; ${packageName} exposes ${subpath}.`,
        );
      }
      const target = runtimeExportTarget(value);
      if (!target) continue;
      const replacement = sourceTarget(current.directory, packageName, subpath, target);
      const specifier = subpath === '.' ? packageName : `${packageName}/${subpath.slice(2)}`;
      if (seenSpecifiers.has(specifier)) {
        throw new Error(`Workspace source aliases found duplicate export ${specifier}.`);
      }
      seenSpecifiers.add(specifier);
      entries.push({ packageName, specifier, replacement });
    }
  }

  return entries.sort((left, right) =>
    segmentCount(right.specifier) - segmentCount(left.specifier)
    || right.specifier.length - left.specifier.length
    || left.specifier.localeCompare(right.specifier));
}

export function workspaceSourceAliases(rootPackageName, options = {}) {
  return workspaceSourceAliasPlan(rootPackageName, options).map(({ specifier, replacement }) => ({
    find: new RegExp(`^${escapeRegExp(specifier)}$`),
    replacement,
  }));
}

function workspaceManifests(packagesRoot) {
  const manifests = new Map();
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })
    .filter((candidate) => candidate.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const directory = path.join(packagesRoot, entry.name);
    const manifestPath = path.join(directory, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@marshal/')) continue;
    manifests.set(manifest.name, { directory, manifest });
  }
  return manifests;
}

function workspaceClosure(manifests, rootPackageName, includeDevDependencies) {
  const visited = new Set();
  const pending = [rootPackageName];
  while (pending.length > 0) {
    const packageName = pending.shift();
    if (!packageName || visited.has(packageName)) continue;
    visited.add(packageName);
    const current = manifests.get(packageName);
    if (!current) continue;
    const manifest = current.manifest;
    const dependencies = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
      ...(manifest.peerDependencies ?? {}),
      ...(packageName === rootPackageName && includeDevDependencies
        ? manifest.devDependencies ?? {}
        : {}),
    };
    for (const dependency of Object.keys(dependencies).sort()) {
      if (manifests.has(dependency) && !visited.has(dependency)) pending.push(dependency);
    }
  }
  return [...visited].sort();
}

function manifestExports(manifest) {
  const exports = manifest.exports;
  if (exports === undefined) return [['.', manifest.main]];
  if (
    exports
    && typeof exports === 'object'
    && !Array.isArray(exports)
    && Object.keys(exports).some((key) => key.startsWith('.'))
  ) {
    return Object.entries(exports)
      .filter(([key]) => key === '.' || key.startsWith('./'))
      .sort(([left], [right]) => left.localeCompare(right));
  }
  return [['.', exports]];
}

function runtimeExportTarget(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const target = runtimeExportTarget(candidate);
      if (target) return target;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  for (const condition of ['import', 'node', 'default', 'require', 'types']) {
    const target = runtimeExportTarget(value[condition]);
    if (target) return target;
  }
  for (const candidate of Object.values(value)) {
    const target = runtimeExportTarget(candidate);
    if (target) return target;
  }
  return undefined;
}

function sourceTarget(packageDirectory, packageName, subpath, target) {
  if (!target.startsWith('./dist/')) {
    throw new Error(
      `Workspace source aliases cannot derive ${packageName} ${subpath} from ${target}.`,
    );
  }
  const relativeTarget = target
    .slice('./dist/'.length)
    .replace(/\.d\.ts$/u, '.ts')
    .replace(/\.mjs$/u, '.mts')
    .replace(/\.cjs$/u, '.cts')
    .replace(/\.js$/u, '.ts');
  const primary = path.join(packageDirectory, 'src', relativeTarget);
  const candidates = [
    primary,
    primary.replace(/\.ts$/u, '.tsx'),
    primary.replace(/\.ts$/u, '.mts'),
    primary.replace(/\.ts$/u, '.cts'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `Workspace source aliases could not map ${packageName} ${subpath} (${target}) to source.`,
    );
  }
  return found;
}

function segmentCount(specifier) {
  return specifier.split('/').length;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
