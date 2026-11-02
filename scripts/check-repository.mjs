import { access, readFile, readdir } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const failures = [];
const forbiddenRoots = [
  'assets',
  'client',
  'dist-desktop',
  'dist-electron',
  'electron',
  'evals',
  'git-bin',
  'node-bin',
  'release',
  'src',
];

for (const directory of forbiddenRoots) {
  if (await exists(new URL(`${directory}/`, root))) {
    failures.push(`forbidden application directory at repository root: ${directory}`);
  }
}

const rootManifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
if (rootManifest.name === '@marshal/web-gateway') {
  failures.push('WBG application manifest is not allowed in the runtime repository');
}
checkElectronDependencies('root', rootManifest);

for (const file of await repositoryFiles(root, true)) {
  const path = displayPath(file);
  if (path === 'package-lock.json' || path.endsWith('/package-lock.json')) {
    failures.push(`npm lockfile is not allowed: ${path}`);
  }
  if (/\.[cm]?[jt]sx?$/.test(path)
    && !path.startsWith('packages/')
    && !path.startsWith('scripts/')
    && !path.startsWith('examples/')) {
    failures.push(`source code outside packages/, scripts/, or examples/: ${path}`);
  }
  if (path.endsWith('/package.json') && path.startsWith('packages/')) {
    checkElectronDependencies(path, JSON.parse(await readFile(file, 'utf8')));
  }
  if (/\.[cm]?[jt]sx?$/.test(path)) {
    const source = await readFile(file, 'utf8');
    for (const specifier of moduleSpecifiers(source)) {
      if (isElectronDependency(specifier)) {
        failures.push(`${path}: repository source imports Electron package ${specifier}`);
      }
    }
  }
}

if (failures.length) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Repository contains runtime packages only; no WBG/Electron source detected.\n');
}

function checkElectronDependencies(label, manifest) {
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const dependency of Object.keys(manifest[section] ?? {})) {
      if (isElectronDependency(dependency)) {
        failures.push(`${label}: ${section} contains Electron package ${dependency}`);
      }
    }
  }
}

function isElectronDependency(value) {
  return value === 'electron' || value.startsWith('@electron/') || value.startsWith('electron-');
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

async function repositoryFiles(directory, isRepositoryRoot = false) {
  const ignoredDirectories = new Set([
    '.git',
    '.marshal',
    'coverage',
    'dist',
    'node_modules',
  ]);
  if (isRepositoryRoot) ignoredDirectories.add('extensions');
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
    if (entry.isDirectory()) files.push(...await repositoryFiles(child));
    else files.push(child);
  }
  return files;
}

async function exists(url) {
  try {
    await access(url);
    return true;
  } catch {
    return false;
  }
}

function displayPath(file) {
  return relative(fileURLToPath(root), fileURLToPath(file)).split(sep).join('/');
}
