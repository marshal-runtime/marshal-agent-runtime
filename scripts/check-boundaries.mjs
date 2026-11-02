import { readFile, readdir } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const config = JSON.parse(await readFile(new URL('runtime-boundaries.json', root), 'utf8'));
const failures = [];
const portable = new Set(config.portable);
const adapters = new Set(config.adapters);
const packageDirectories = await workspacePackageDirectories();
const manifests = new Map();

for (const directory of portable) {
  if (adapters.has(directory)) failures.push(`${directory}: classified as both portable and adapter`);
}

for (const directory of packageDirectories) {
  if (!portable.has(directory) && !adapters.has(directory)) {
    failures.push(`${directory}: workspace package is not classified in runtime-boundaries.json`);
  }
  manifests.set(
    directory,
    JSON.parse(await readFile(new URL(`packages/${directory}/package.json`, root), 'utf8')),
  );
}

const adapterPackageNames = new Set(
  [...adapters].map((directory) => manifests.get(directory)?.name ?? `@marshal/${directory}`),
);
const forbiddenDependencies = new Set([
  ...config.forbiddenPortableDependencies,
  ...adapterPackageNames,
]);
const forbiddenPrefixes = config.forbiddenPortableDependencyPrefixes ?? [];

for (const directory of portable) {
  if (!manifests.has(directory)) continue;
  const packageRoot = new URL(`packages/${directory}/`, root);
  const manifest = manifests.get(directory);
  const declared = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
    ...(manifest.peerDependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
  };
  for (const dependency of Object.keys(declared)) {
    if (isForbiddenSpecifier(dependency)) {
      failures.push(`${directory}: forbidden dependency ${dependency}`);
    }
  }
  for (const file of await sourceFiles(new URL('src/', packageRoot))) {
    const source = await readFile(file, 'utf8');
    for (const specifier of moduleSpecifiers(source)) {
      if (isForbiddenSpecifier(specifier)) {
        failures.push(`${directory}: source imports ${specifier} in ${displayPath(file)}`);
      }
      if (specifier.startsWith('.')) {
        const imported = resolve(dirname(fileURLToPath(file)), specifier);
        for (const adapter of adapters) {
          const adapterRoot = resolve(fileURLToPath(root), 'packages', adapter);
          const rel = relative(adapterRoot, imported);
          if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..')) {
            failures.push(`${directory}: relative import enters adapter ${adapter} in ${displayPath(file)}`);
          }
        }
      }
    }
  }
}

if (failures.length) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Portable package boundaries are clean (${packageDirectories.length} packages classified).\n`);
}

async function sourceFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
    if (entry.isDirectory()) files.push(...await sourceFiles(child));
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(child);
  }
  return files;
}

async function workspacePackageDirectories() {
  const packagesRoot = new URL('packages/', root);
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await readFile(new URL(`${entry.name}/package.json`, packagesRoot));
      found.push(entry.name);
    } catch {
      // Non-package support directories do not participate in runtime boundaries.
    }
  }
  return found.sort();
}

function moduleSpecifiers(source) {
  const found = new Set();
  const patterns = [
    /\b(?:from|import)\s*[(']?\s*['"`]([^'"`]+)['"`]/g,
    /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
  return found;
}

function isForbiddenSpecifier(specifier) {
  for (const dependency of forbiddenDependencies) {
    if (specifier === dependency || specifier.startsWith(`${dependency}/`)) return true;
  }
  return forbiddenPrefixes.some((prefix) => specifier.startsWith(prefix));
}

function displayPath(file) {
  return relative(fileURLToPath(root), fileURLToPath(file)).split(sep).join('/');
}
