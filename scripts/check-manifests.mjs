import { access, readFile, readdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const boundaries = JSON.parse(await readFile(new URL('runtime-boundaries.json', root), 'utf8'));
const classified = new Set([...boundaries.portable, ...boundaries.adapters]);
const failures = [];
const rootManifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const canonicalLicense = await readFile(new URL('LICENSE', root), 'utf8');
const defaultNodeEngine = '>=22.13.0';
const memoryRuntimeNodeEngine = '>=24.14.0';
const memoryRuntimePackages = new Set([
  'attachments',
  'brain',
  'codex',
  'runtime',
  'agent-runtime-codex',
  'agent-runtime-host',
]);
const quillstonePackages = new Set([
  'analysis-tools',
  'communities-processes',
  'contracts',
  'embedding-runtime',
  'local-alpha-index-core',
  'marshal-memory-bridge',
  'pdg-taint',
  'repository-registry-config',
  'resolution-index-pipeline',
  'scanner-parsers',
  'search',
  'shared-schema',
]);

if (rootManifest.private !== true) failures.push('root package must remain private');
if (rootManifest.packageManager !== 'pnpm@10.32.1') {
  failures.push('root packageManager must be pinned to pnpm@10.32.1');
}
if (rootManifest.engines?.node !== memoryRuntimeNodeEngine) {
  failures.push(`root engines.node must be ${memoryRuntimeNodeEngine}`);
}

const packageDirectories = await workspacePackageDirectories();
const manifests = new Map();
const names = new Set();
let publishableCount = 0;
for (const directory of packageDirectories) {
  const packageRoot = new URL(`packages/${directory}/`, root);
  const manifest = JSON.parse(await readFile(new URL('package.json', packageRoot), 'utf8'));
  manifests.set(directory, manifest);
  const label = manifest.name ?? directory;

  if (!classified.has(directory)) failures.push(`${directory}: package is not boundary-classified`);
  const expectedNamespace = quillstonePackages.has(directory) ? '@quillstone' : '@marshal';
  if (manifest.name !== `${expectedNamespace}/${directory}`) {
    failures.push(`${directory}: expected package name ${expectedNamespace}/${directory}`);
  }
  if (names.has(manifest.name)) failures.push(`${directory}: duplicate package name ${manifest.name}`);
  names.add(manifest.name);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? '')) {
    failures.push(`${label}: version must be an explicit semver`);
  }
  if (typeof manifest.description !== 'string' || !manifest.description.trim()) {
    failures.push(`${label}: description is required`);
  }
  if (manifest.type !== 'module') failures.push(`${label}: type must be module`);
  const expectedNodeEngine = memoryRuntimePackages.has(directory)
    || quillstonePackages.has(directory)
    || directory === 'agent-runtime-code-intelligence'
    ? memoryRuntimeNodeEngine
    : defaultNodeEngine;
  if (manifest.engines?.node !== expectedNodeEngine) {
    failures.push(`${label}: engines.node must be ${expectedNodeEngine}`);
  }
  if (manifest.private !== true) {
    publishableCount += 1;
    if (manifest.license !== 'MIT') failures.push(`${label}: license must be MIT`);
    if (manifest.publishConfig?.access !== 'public') {
      failures.push(`${label}: publishConfig.access must be public`);
    }
    if (quillstonePackages.has(directory)) {
      validateQuillstoneExports(label, manifest);
    } else {
      if (manifest.main !== 'dist/index.js' || manifest.types !== 'dist/index.d.ts') {
        failures.push(`${label}: main/types must point to dist/index.js and dist/index.d.ts`);
      }
      if (
        manifest.exports?.['.']?.default !== './dist/index.js' ||
        manifest.exports?.['.']?.types !== './dist/index.d.ts'
      ) {
        failures.push(`${label}: exports[.] must expose dist JavaScript and declarations`);
      }
    }
    if (!Array.isArray(manifest.files) || !manifest.files.includes('dist') || !manifest.files.includes('README.md')) {
      failures.push(`${label}: files must include dist and README.md`);
    }
    try {
      await access(new URL('README.md', packageRoot));
    } catch {
      failures.push(`${label}: README.md is required`);
    }
    try {
      const packageLicense = await readFile(new URL('LICENSE', packageRoot), 'utf8');
      if (packageLicense !== canonicalLicense) {
        failures.push(`${label}: LICENSE must match the repository license exactly`);
      }
    } catch {
      failures.push(`${label}: LICENSE is required`);
    }
    if (!manifest.scripts?.build || !manifest.scripts?.typecheck) {
      failures.push(`${label}: build and typecheck scripts are required`);
    }
    if (!manifest.devDependencies?.typescript && !manifest.dependencies?.typescript) {
      failures.push(`${label}: TypeScript must be an explicit dependency`);
    }
  }
}

const internalDirectoriesByName = new Map(
  [...manifests].map(([directory, manifest]) => [manifest.name, directory]),
);
const internalNames = new Set(internalDirectoriesByName.keys());
for (const [directory, manifest] of manifests) {
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [dependency, range] of Object.entries(manifest[section] ?? {})) {
      if (internalNames.has(dependency) && !String(range).startsWith('workspace:')) {
        failures.push(`${directory}: internal ${section} entry ${dependency} must use workspace:`);
      }
      if (/^(?:file|link):/.test(String(range))) {
        failures.push(`${directory}: ${section} entry ${dependency} uses non-reproducible ${range}`);
      }
    }
  }
}

const runtimeManifest = manifests.get('runtime');
if (
  runtimeManifest?.exports?.['./host']?.default !== './dist/host.js'
  || runtimeManifest?.exports?.['./host']?.types !== './dist/host.d.ts'
) {
  failures.push('@marshal/runtime must expose the infrastructure host at ./host');
}

const forbiddenRuntimeHostClosure = new Set([
  'agent-runtime-codex',
  'agent-runtime-codex-capabilities',
  'codex',
]);
for (const directory of workspaceProductionClosure('runtime')) {
  if (manifests.get(directory)?.private === true) {
    failures.push(`@marshal/runtime production closure includes private package ${directory}`);
  }
  if (forbiddenRuntimeHostClosure.has(directory)) {
    failures.push(`@marshal/runtime/host production closure includes domain package ${directory}`);
  }
}

if (failures.length) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Validated ${publishableCount} publishable and ${packageDirectories.length - publishableCount} private package manifests.\n`,
  );
}

function validateQuillstoneExports(label, manifest) {
  const manifestTypes = normalizePackageTarget(manifest.types);
  if (!manifestTypes || !isDeclarationTarget(manifestTypes)) {
    failures.push(`${label}: types must point to a declaration under dist`);
  }

  const exports = manifest.exports;
  if (!exports || typeof exports !== 'object' || Array.isArray(exports) || Object.keys(exports).length === 0) {
    failures.push(`${label}: exports must define at least one ESM entrypoint`);
    return;
  }

  const exportedTypes = new Set();
  for (const [subpath, conditions] of Object.entries(exports)) {
    if (!isPackageExportSubpath(subpath)) {
      failures.push(`${label}: invalid export subpath ${subpath}`);
      continue;
    }
    if (!conditions || typeof conditions !== 'object' || Array.isArray(conditions)) {
      failures.push(`${label}: export ${subpath} must define import and types conditions`);
      continue;
    }
    const importTarget = normalizePackageTarget(conditions.import);
    const typesTarget = normalizePackageTarget(conditions.types);
    if (!importTarget || !isJavaScriptTarget(importTarget)) {
      failures.push(`${label}: export ${subpath} import must point to JavaScript under dist`);
    }
    if (!typesTarget || !isDeclarationTarget(typesTarget)) {
      failures.push(`${label}: export ${subpath} types must point to a declaration under dist`);
    }
    if (importTarget && typesTarget && declarationJavaScriptTarget(typesTarget) !== importTarget) {
      failures.push(`${label}: export ${subpath} JavaScript and declaration targets must correspond`);
    }
    if (typesTarget) exportedTypes.add(typesTarget);
  }

  if (manifestTypes && !exportedTypes.has(manifestTypes)) {
    failures.push(`${label}: package types must match one exported declaration target`);
  }
}

function normalizePackageTarget(target) {
  if (typeof target !== 'string' || target.includes('\\')) return undefined;
  const normalized = target.startsWith('./') ? target.slice(2) : target;
  const segments = normalized.split('/');
  if (
    !normalized.startsWith('dist/')
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return undefined;
  }
  return normalized;
}

function isPackageExportSubpath(subpath) {
  if (subpath === '.') return true;
  if (!subpath.startsWith('./')) return false;
  const segments = subpath.slice(2).split('/');
  return segments.every((segment) => segment && segment !== '.' && segment !== '..');
}

function isJavaScriptTarget(target) {
  return target.endsWith('.js') || target.endsWith('.mjs');
}

function isDeclarationTarget(target) {
  return target.endsWith('.d.ts') || target.endsWith('.d.mts');
}

function declarationJavaScriptTarget(target) {
  if (target.endsWith('.d.mts')) return `${target.slice(0, -6)}.mjs`;
  if (target.endsWith('.d.ts')) return `${target.slice(0, -5)}.js`;
  return undefined;
}

async function workspacePackageDirectories() {
  const packagesRoot = new URL('packages/', root);
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await access(new URL(`${entry.name}/package.json`, packagesRoot));
      found.push(entry.name);
    } catch {
      // Ignore support directories without package manifests.
    }
  }
  return found.sort();
}

function workspaceProductionClosure(rootDirectory) {
  const visited = new Set();
  const pending = [rootDirectory];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory || visited.has(directory)) continue;
    visited.add(directory);
    const manifest = manifests.get(directory);
    if (!manifest) continue;
    const dependencies = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
      ...(manifest.peerDependencies ?? {}),
    };
    for (const dependency of Object.keys(dependencies)) {
      const child = internalDirectoriesByName.get(dependency);
      if (child && !visited.has(child)) pending.push(child);
    }
  }
  return visited;
}
