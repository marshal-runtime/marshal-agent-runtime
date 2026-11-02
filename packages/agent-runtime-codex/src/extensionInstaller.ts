import * as fs from 'node:fs/promises';
import * as path from 'node:path';
interface RuntimeExtensionManifest {
  readonly entrypoint: string;
}

export interface CodexExtensionInstallerArgs {
  readonly source: string;
  readonly destinationRoot?: string;
  readonly workspacePath?: string;
  readonly configurationJson?: string;
  readonly configurationFile?: string;
  readonly help: boolean;
}

export function parseCodexExtensionInstallerArgs(
  argv: readonly string[],
): CodexExtensionInstallerArgs {
  let source: string | undefined;
  let destinationRoot: string | undefined;
  let workspacePath: string | undefined;
  let configurationJson: string | undefined;
  let configurationFile: string | undefined;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    switch (value) {
      case '--directory':
      case '--manifest': {
        const next = argv[++index];
        if (!next || next.startsWith('--')) throw new Error(`${value} requires a path.`);
        source = next;
        break;
      }
      case '--destination-root':
      case '--workspace': {
        const next = argv[++index];
        if (!next || next.startsWith('--')) throw new Error(`${value} requires a path.`);
        if (value === '--workspace') workspacePath = next;
        else destinationRoot = next;
        break;
      }
      case '--configuration-json':
      case '--configuration-file': {
        const next = argv[++index];
        if (!next || next.startsWith('--')) throw new Error(`${value} requires a value.`);
        if (value === '--configuration-json') configurationJson = next;
        else configurationFile = next;
        break;
      }
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (configurationJson !== undefined && configurationFile !== undefined) {
    throw new Error('--configuration-json and --configuration-file are mutually exclusive.');
  }
  if (!help && !source) throw new Error('--directory or --manifest is required.');
  return { source: source ?? '', destinationRoot, workspacePath, configurationJson, configurationFile, help };
}

const PACKAGE_METADATA_FILENAME = 'package.json';
const MANIFEST_FILENAME = 'runtime-extension.json';
const MAX_MATERIALIZED_FILES = 2_048;
const MAX_MATERIALIZED_BYTES = 128 * 1024 * 1024;

export async function materializeRuntimeExtensionPackage(
  source: string,
  manifest: RuntimeExtensionManifest,
  destinationRoot: string,
): Promise<string> {
  const staging = path.join(destinationRoot, `.staging-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.mkdir(staging, { recursive: true });
  try {
    const packageMetadata = await readPackageMetadata(source);
    const requested = new Set<string>([
      PACKAGE_METADATA_FILENAME,
      MANIFEST_FILENAME,
      validateMaterializedPath(manifest.entrypoint),
    ]);
    if (packageMetadata.files !== undefined) {
      if (!Array.isArray(packageMetadata.files) || packageMetadata.files.some((entry) => typeof entry !== 'string')) {
        throw new Error('package.json files must be an array of relative paths.');
      }
      for (const entry of packageMetadata.files) {
        const relative = validateMaterializedPath(entry);
        if (relative === 'node_modules' || relative.startsWith('node_modules/')) {
          throw new Error('package.json files cannot include node_modules.');
        }
        await collectRegularFiles(source, relative, requested);
      }
    }
    let totalBytes = 0;
    for (const relative of [...requested].sort()) {
      const bytes = await readRegularSourceFile(source, relative);
      totalBytes += bytes.length;
      if (totalBytes > MAX_MATERIALIZED_BYTES) throw new Error('Extension package exceeds materialization limits.');
      if (requested.size > MAX_MATERIALIZED_FILES) throw new Error('Extension package contains too many files.');
      const target = path.join(staging, ...relative.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes, { flag: 'wx' });
    }
    return staging;
  } catch (error) {
    await removeDirectory(staging);
    throw error;
  }
}

export async function publishMaterializedPackage(
  staging: string,
  destination: string,
  integrity: string,
  computeIntegrity: (packageRoot: string) => { readonly value: string },
): Promise<void> {
  try {
    const stat = await fs.lstat(destination);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Extension destination is not a regular directory: ${destination}`);
    }
    if (computeIntegrity(destination).value !== integrity) {
      throw new Error(`Extension destination integrity mismatch: ${destination}`);
    }
    await removeDirectory(staging);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
    try {
      await fs.rename(staging, destination);
    } catch (renameError) {
      if (!isNodeError(renameError, 'EEXIST')) throw renameError;
      if (computeIntegrity(destination).value !== integrity) {
        throw new Error(`Extension destination integrity mismatch: ${destination}`);
      }
      await removeDirectory(staging);
    }
  }
}

async function readPackageMetadata(source: string): Promise<{ readonly files?: readonly unknown[] }> {
  const value: unknown = JSON.parse(await fs.readFile(path.join(source, PACKAGE_METADATA_FILENAME), 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('package.json must contain an object.');
  }
  const files = (value as { files?: unknown }).files;
  return { ...(files === undefined ? {} : { files: files as readonly unknown[] }) };
}

async function collectRegularFiles(source: string, relative: string, output: Set<string>): Promise<void> {
  const absolute = path.join(source, ...relative.split('/'));
  const stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink()) throw new Error(`Extension package file is a symlink: ${relative}`);
  if (stat.isFile()) {
    output.add(relative);
    return;
  }
  if (!stat.isDirectory()) throw new Error(`Extension package path is not a file or directory: ${relative}`);
  if (relative === '.git' || relative.startsWith('.git/')) throw new Error('package.json files cannot include .git.');
  if (relative === 'node_modules' || relative.startsWith('node_modules/')) {
    throw new Error('package.json files cannot include node_modules.');
  }
  for (const entry of (await fs.readdir(absolute, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name))) {
    await collectRegularFiles(source, `${relative}/${entry.name}`, output);
  }
}

async function readRegularSourceFile(source: string, relative: string): Promise<Buffer> {
  const absolute = path.join(source, ...relative.split('/'));
  const stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Extension package file must be a regular file: ${relative}`);
  }
  return fs.readFile(absolute);
}

function validateMaterializedPath(input: string): string {
  if (!input || input.includes('\\') || input.startsWith('/') || path.posix.isAbsolute(input)
    || input.split('/').some((segment) => !segment || segment === '.' || segment === '..'
      || /[*?[\]{}!]/.test(segment))) {
    throw new Error(`Extension package path is unsafe: ${input}`);
  }
  return input;
}

async function removeDirectory(directory: string): Promise<void> {
  await fs.rm(directory, { recursive: true, force: true });
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
