import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isContained } from './common.js';

export async function initializeSafeDirectory(
  configuredDirectory: string,
  field: string,
  containmentRoot?: string,
): Promise<string> {
  if (!path.isAbsolute(configuredDirectory)) {
    throw new Error(`${field} must be absolute.`);
  }
  const resolvedDirectory = path.resolve(configuredDirectory);
  let canonicalContainmentRoot: string | undefined;
  if (containmentRoot !== undefined) {
    if (!path.isAbsolute(containmentRoot)) {
      throw new Error(`${field} containment root must be absolute.`);
    }
    const resolvedContainmentRoot = path.resolve(containmentRoot);
    if (!isContained(resolvedContainmentRoot, resolvedDirectory)) {
      throw new Error(`${field} must stay within its configured containment root.`);
    }
    canonicalContainmentRoot = await walkDirectoryComponents(
      resolvedContainmentRoot,
      `${field} containment root`,
      false,
    );
  }

  const canonicalDirectory = await walkDirectoryComponents(resolvedDirectory, field, true);
  if (
    canonicalContainmentRoot
    && !isContained(canonicalContainmentRoot, canonicalDirectory)
  ) {
    throw new Error(`${field} escaped its configured containment root.`);
  }
  return canonicalDirectory;
}

async function walkDirectoryComponents(
  directory: string,
  field: string,
  create: boolean,
): Promise<string> {
  const volumeRoot = path.parse(directory).root;
  let current = await validateDirectoryComponent(volumeRoot, field);
  const segments = path.relative(volumeRoot, directory).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    const candidate = path.join(current, segment);
    try {
      current = await validateDirectoryComponent(candidate, field);
    } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        await fs.mkdir(candidate);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
      }
      current = await validateDirectoryComponent(candidate, field);
    }
  }
  return current;
}

async function validateDirectoryComponent(directory: string, field: string): Promise<string> {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${field} contains a symbolic link, junction, or non-directory component.`);
  }
  const canonical = await fs.realpath(directory);
  if (!samePath(directory, canonical)) {
    throw new Error(`${field} cannot traverse a symbolic link or junction.`);
  }
  return canonical;
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
