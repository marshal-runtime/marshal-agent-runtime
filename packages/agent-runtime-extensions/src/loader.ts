import { createHash, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { TextDecoder } from 'node:util';
import * as vm from 'node:vm';
import {
  sameStableFileIdentity,
  sameStableFileSnapshot,
  type StableFileSnapshot,
} from '@marshal/agent-runtime-core';
import {
  RUNTIME_EXTENSION_INTEGRITY_DOMAIN,
  RUNTIME_EXTENSION_MANIFEST_FILENAME,
  type LoadedRuntimeExtensionPackage,
  type RuntimeExtensionInstallRequest,
  type RuntimeExtensionIntegrity,
  type RuntimeExtensionModule,
  type RuntimeExtensionPackageLoader,
  type RuntimeExtensionPackageMetadata,
} from './contracts.js';
import {
  requireRuntimeExtensionIdentity,
  requireRuntimeExtensionVersion,
  validateRuntimeExtensionManifest,
} from './manifest.js';

const PACKAGE_METADATA_FILENAME = 'package.json';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_PACKAGE_FILES = 2_048;
const MAX_PACKAGE_BYTES = 128 * 1024 * 1024;
const MAX_PACKAGE_FILE_BYTES = 32 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const REQUIRE_BUILTIN = createRequire(import.meta.url);
const DEFAULT_NODE_BUILTIN_MODULES = Object.freeze([
  'buffer',
  'events',
  'fs',
  'http',
  'https',
  'node:async_hooks',
  'node:child_process',
  'node:crypto',
  'node:fs/promises',
  'node:os',
  'node:path',
  'node:sqlite',
  'node:url',
  'node:util',
  'os',
  'path',
  'stream',
  'tty',
  'url',
  'util',
  'zlib',
] as const);

export type RuntimeExtensionPackageErrorCode =
  | 'INVALID_LOADER_ROOT'
  | 'INVALID_REQUEST'
  | 'INVALID_INTEGRITY'
  | 'SOURCE_UNAVAILABLE'
  | 'ROOT_NOT_ALLOWED'
  | 'UNSAFE_PACKAGE_TREE'
  | 'PACKAGE_LIMIT_EXCEEDED'
  | 'INTEGRITY_MISMATCH'
  | 'INVALID_MANIFEST'
  | 'IDENTITY_MISMATCH'
  | 'VERSION_MISMATCH'
  | 'INVALID_ENTRYPOINT'
  | 'UNSUPPORTED_MODULE_FORMAT'
  | 'UNSUPPORTED_MODULE_DEPENDENCY'
  | 'UNSUPPORTED_MODULE_SHAPE'
  | 'MODULE_LOAD_FAILED'
  | 'CANCELLED';

const ERROR_MESSAGES: Readonly<Record<RuntimeExtensionPackageErrorCode, string>> = {
  INVALID_LOADER_ROOT: 'An extension loader root is not a canonical real directory.',
  INVALID_REQUEST: 'The extension package load request is invalid.',
  INVALID_INTEGRITY: 'The extension package integrity descriptor is invalid.',
  SOURCE_UNAVAILABLE: 'The extension package source is unavailable.',
  ROOT_NOT_ALLOWED: 'The extension package source is outside the host-allowed roots.',
  UNSAFE_PACKAGE_TREE: 'The extension package tree contains an unsafe path or file.',
  PACKAGE_LIMIT_EXCEEDED: 'The extension package exceeds the host loader limits.',
  INTEGRITY_MISMATCH: 'The extension package integrity does not match.',
  INVALID_MANIFEST: 'The extension package manifest is invalid.',
  IDENTITY_MISMATCH: 'The extension package identity does not match package.json.',
  VERSION_MISMATCH: 'The extension package version does not match package.json.',
  INVALID_ENTRYPOINT: 'The extension package entrypoint is invalid.',
  UNSUPPORTED_MODULE_FORMAT: 'The extension package module format is unsupported.',
  UNSUPPORTED_MODULE_DEPENDENCY:
    'The extension package requested a module that the host did not provide.',
  UNSUPPORTED_MODULE_SHAPE:
    'The extension package entrypoint must export an object with activate(context).',
  MODULE_LOAD_FAILED: 'The verified extension package entrypoint failed to load.',
  CANCELLED: 'The extension package load was cancelled.',
};

export class RuntimeExtensionPackageError extends Error {
  constructor(
    readonly code: RuntimeExtensionPackageErrorCode,
    cause?: unknown,
  ) {
    super(ERROR_MESSAGES[code], cause === undefined ? undefined : { cause });
    this.name = 'RuntimeExtensionPackageError';
  }
}

export interface LocalRuntimeExtensionPackageLoaderOptions {
  /** Canonical directory roots from which a host permits materialized packages. */
  readonly allowedRoots: readonly string[];
  /** Exact in-memory modules exposed to verified bundled CommonJS entrypoints. */
  readonly modules?: Readonly<Record<string, unknown>>;
}

/** Creates the lazy reviewed Node builtin map used by supported native bundles. */
export function createNodeBuiltinModuleMap(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const descriptors: PropertyDescriptorMap = Object.create(null) as PropertyDescriptorMap;
  for (const specifier of DEFAULT_NODE_BUILTIN_MODULES) {
    descriptors[specifier] = {
      enumerable: true,
      get: () => REQUIRE_BUILTIN(specifier),
    };
  }
  Object.assign(descriptors, Object.getOwnPropertyDescriptors(overrides));
  return freezeModuleMap(Object.defineProperties(Object.create(null), descriptors));
}

interface PackageFile extends StableFileSnapshot {
  readonly absolutePath: string;
  readonly relativePath: string;
}

interface HashedPackage {
  readonly integrity: RuntimeExtensionIntegrity;
  readonly files: ReadonlyMap<string, Buffer>;
  readonly fileCount: number;
  readonly totalBytes: number;
}

/** Integrity-verifying loader for host-selected, already-materialized package roots. */
export class LocalRuntimeExtensionPackageLoader implements RuntimeExtensionPackageLoader {
  private readonly allowedRoots: readonly string[];
  private readonly modules: Readonly<Record<string, unknown>>;

  constructor(options: LocalRuntimeExtensionPackageLoaderOptions) {
    if (options.allowedRoots.length === 0) {
      throw new RuntimeExtensionPackageError('INVALID_LOADER_ROOT');
    }
    this.allowedRoots = Object.freeze(options.allowedRoots.map(resolveAllowedRoot));
    this.modules = freezeModuleMap(options.modules ?? {});
  }

  load(
    input: RuntimeExtensionInstallRequest,
    signal?: { readonly aborted: boolean },
  ): LoadedRuntimeExtensionPackage {
    assertNotCancelled(signal);
    const request = validateRequest(input);
    const canonicalRoot = resolvePackageRoot(request.packageRoot, this.allowedRoots);
    const hashed = hashPackage(canonicalRoot);
    assertIntegrity(hashed.integrity, request.integrity);
    assertNotCancelled(signal);
    const manifest = parsePackageMetadata(hashed.files);
    const entrypointBytes = hashed.files.get(manifest.entrypoint);
    if (!entrypointBytes) throw new RuntimeExtensionPackageError('INVALID_ENTRYPOINT');
    const entrypointPath = path.join(
      canonicalRoot,
      ...manifest.entrypoint.split('/'),
    );
    const loadedModule = loadCommonJsModule(
      entrypointBytes,
      entrypointPath,
      this.modules,
    );
    assertNotCancelled(signal);
    const metadata: RuntimeExtensionPackageMetadata = Object.freeze({
      manifest,
      integrity: Object.freeze({ ...hashed.integrity }),
      canonicalRoot,
      fileCount: hashed.fileCount,
      totalBytes: hashed.totalBytes,
    });
    return Object.freeze({ metadata, module: loadedModule });
  }
}

/** Computes the domain-separated package-tree digest a host pins in a load request. */
export function computeRuntimeExtensionIntegrity(packageRoot: string): RuntimeExtensionIntegrity {
  try {
    const canonicalRoot = resolveUnboundedPackageRoot(packageRoot);
    return hashPackage(canonicalRoot).integrity;
  } catch (error) {
    if (error instanceof RuntimeExtensionPackageError) throw error;
    throw new RuntimeExtensionPackageError('SOURCE_UNAVAILABLE', error);
  }
}

function validateRequest(input: RuntimeExtensionInstallRequest): RuntimeExtensionInstallRequest {
  if (
    !input
    || typeof input !== 'object'
    || typeof input.packageRoot !== 'string'
    || !input.packageRoot
    || !input.integrity
    || typeof input.integrity !== 'object'
  ) {
    throw new RuntimeExtensionPackageError('INVALID_REQUEST');
  }
  const integrity = input.integrity;
  if (
    integrity.algorithm !== 'sha256'
    || integrity.domain !== RUNTIME_EXTENSION_INTEGRITY_DOMAIN
    || !SHA256_PATTERN.test(integrity.value)
  ) {
    throw new RuntimeExtensionPackageError('INVALID_INTEGRITY');
  }
  return {
    packageRoot: input.packageRoot,
    integrity: Object.freeze({ ...integrity }),
  };
}

function resolveAllowedRoot(input: string): string {
  try {
    const resolved = path.resolve(input);
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new RuntimeExtensionPackageError('INVALID_LOADER_ROOT');
    }
    const canonical = fs.realpathSync(resolved);
    if (canonical !== resolved && path.normalize(canonical) !== path.normalize(resolved)) {
      throw new RuntimeExtensionPackageError('INVALID_LOADER_ROOT');
    }
    return canonical;
  } catch (error) {
    if (error instanceof RuntimeExtensionPackageError) throw error;
    throw new RuntimeExtensionPackageError('INVALID_LOADER_ROOT', error);
  }
}

function resolvePackageRoot(input: string, allowedRoots: readonly string[]): string {
  const canonical = resolveUnboundedPackageRoot(input);
  if (!allowedRoots.some((root) => isSameOrInside(root, canonical))) {
    throw new RuntimeExtensionPackageError('ROOT_NOT_ALLOWED');
  }
  return canonical;
}

function resolveUnboundedPackageRoot(input: string): string {
  try {
    const resolved = path.resolve(input);
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new RuntimeExtensionPackageError('UNSAFE_PACKAGE_TREE');
    }
    return fs.realpathSync(resolved);
  } catch (error) {
    if (error instanceof RuntimeExtensionPackageError) throw error;
    if (isNodeError(error, 'ENOENT')) {
      throw new RuntimeExtensionPackageError('SOURCE_UNAVAILABLE');
    }
    throw new RuntimeExtensionPackageError('SOURCE_UNAVAILABLE', error);
  }
}

function hashPackage(root: string): HashedPackage {
  const before = collectPackageFiles(root);
  const hash = createHash('sha256');
  const files = new Map<string, Buffer>();
  let totalBytes = 0;
  hash.update(RUNTIME_EXTENSION_INTEGRITY_DOMAIN, 'utf8');
  hash.update(Buffer.from([0]));
  for (const file of before) {
    const bytes = readStableFile(root, file);
    const relative = Buffer.from(file.relativePath, 'utf8');
    hash.update(Buffer.from([0x46]));
    hash.update(unsigned64(relative.length));
    hash.update(relative);
    hash.update(unsigned64(bytes.length));
    hash.update(bytes);
    files.set(file.relativePath, bytes);
    totalBytes += bytes.length;
  }
  assertSameInventory(before, collectPackageFiles(root));
  return {
    integrity: Object.freeze({
      algorithm: 'sha256',
      domain: RUNTIME_EXTENSION_INTEGRITY_DOMAIN,
      value: hash.digest('hex'),
    }),
    files,
    fileCount: before.length,
    totalBytes,
  };
}

function collectPackageFiles(root: string): PackageFile[] {
  const files: PackageFile[] = [];
  const portablePaths = new Map<string, string>();
  let totalBytes = 0;
  const visit = (directory: string, relativeDirectory: string): void => {
    const directoryStat = fs.lstatSync(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new RuntimeExtensionPackageError('UNSAFE_PACKAGE_TREE');
    }
    if (!isSameOrInside(root, fs.realpathSync(directory))) {
      throw new RuntimeExtensionPackageError('UNSAFE_PACKAGE_TREE');
    }
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      Buffer.compare(Buffer.from(left.name, 'utf8'), Buffer.from(right.name, 'utf8')));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      assertPortablePackagePath(relativePath);
      const key = relativePath.toLowerCase();
      const previous = portablePaths.get(key);
      if (previous && previous !== relativePath) {
        throw new RuntimeExtensionPackageError('UNSAFE_PACKAGE_TREE');
      }
      portablePaths.set(key, relativePath);
      const absolutePath = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new RuntimeExtensionPackageError('UNSAFE_PACKAGE_TREE');
      }
      if (!isSameOrInside(root, fs.realpathSync(absolutePath))) {
        throw new RuntimeExtensionPackageError('UNSAFE_PACKAGE_TREE');
      }
      if (
        entry.name === '.git'
        || (entry.name === 'node_modules' && stat.isDirectory())
      ) {
        continue;
      }
      if (stat.isDirectory()) {
        visit(absolutePath, relativePath);
        continue;
      }
      if (!stat.isFile()) throw new RuntimeExtensionPackageError('UNSAFE_PACKAGE_TREE');
      if (stat.size > MAX_PACKAGE_FILE_BYTES) {
        throw new RuntimeExtensionPackageError('PACKAGE_LIMIT_EXCEEDED');
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_PACKAGE_BYTES) {
        throw new RuntimeExtensionPackageError('PACKAGE_LIMIT_EXCEEDED');
      }
      files.push({ absolutePath, relativePath, ...snapshot(stat) });
      if (files.length > MAX_PACKAGE_FILES) {
        throw new RuntimeExtensionPackageError('PACKAGE_LIMIT_EXCEEDED');
      }
    }
  };
  visit(root, '');
  return files.sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.relativePath, 'utf8'),
      Buffer.from(right.relativePath, 'utf8'),
    ));
}

function readStableFile(root: string, file: PackageFile): Buffer {
  let handle: number | undefined;
  try {
    const before = fs.lstatSync(file.absolutePath);
    assertStableFile(root, file.absolutePath, before);
    assertSamePathSnapshot(file, snapshot(before));
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number'
      ? fs.constants.O_NOFOLLOW
      : 0;
    handle = fs.openSync(file.absolutePath, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(handle);
    assertSamePathSnapshot(file, snapshot(opened));
    const bytes = fs.readFileSync(handle);
    const after = fs.fstatSync(handle);
    assertSameOpenedSnapshot(snapshot(opened), snapshot(after));
    if (bytes.length !== after.size) {
      throw new RuntimeExtensionPackageError('UNSAFE_PACKAGE_TREE');
    }
    return bytes;
  } catch (error) {
    if (error instanceof RuntimeExtensionPackageError) throw error;
    throw new RuntimeExtensionPackageError('UNSAFE_PACKAGE_TREE', error);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function parsePackageMetadata(files: ReadonlyMap<string, Buffer>) {
  const manifestBytes = files.get(RUNTIME_EXTENSION_MANIFEST_FILENAME);
  const packageBytes = files.get(PACKAGE_METADATA_FILENAME);
  if (
    !manifestBytes
    || !packageBytes
    || manifestBytes.length > MAX_METADATA_BYTES
    || packageBytes.length > MAX_METADATA_BYTES
  ) {
    throw new RuntimeExtensionPackageError('INVALID_MANIFEST');
  }
  try {
    const manifest = validateRuntimeExtensionManifest(parseJson(manifestBytes));
    const packageMetadata = parseJson(packageBytes);
    if (!isRecord(packageMetadata)) {
      throw new RuntimeExtensionPackageError('INVALID_MANIFEST');
    }
    const name = requireRuntimeExtensionIdentity(packageMetadata.name);
    const version = requireRuntimeExtensionVersion(packageMetadata.version);
    if (name !== manifest.identity) {
      throw new RuntimeExtensionPackageError('IDENTITY_MISMATCH');
    }
    if (version !== manifest.version) {
      throw new RuntimeExtensionPackageError('VERSION_MISMATCH');
    }
    if (packageMetadata.type !== 'commonjs') {
      throw new RuntimeExtensionPackageError('UNSUPPORTED_MODULE_FORMAT');
    }
    if (packageMetadata.main !== manifest.entrypoint) {
      throw new RuntimeExtensionPackageError('INVALID_ENTRYPOINT');
    }
    if (hasExcludedPackageSegment(manifest.entrypoint)) {
      throw new RuntimeExtensionPackageError('INVALID_ENTRYPOINT');
    }
    return manifest;
  } catch (error) {
    if (error instanceof RuntimeExtensionPackageError) throw error;
    throw new RuntimeExtensionPackageError('INVALID_MANIFEST', error);
  }
}

function loadCommonJsModule(
  bytes: Buffer,
  filename: string,
  modules: Readonly<Record<string, unknown>>,
): RuntimeExtensionModule {
  let source: string;
  try {
    source = UTF8_DECODER.decode(bytes);
  } catch (error) {
    throw new RuntimeExtensionPackageError('MODULE_LOAD_FAILED', error);
  }
  const moduleRecord: { exports: unknown } = { exports: {} };
  const requireModule = (specifier: string): unknown => {
    if (!Object.hasOwn(modules, specifier)) {
      throw new RuntimeExtensionPackageError('UNSUPPORTED_MODULE_DEPENDENCY');
    }
    return modules[specifier];
  };
  try {
    const script = new vm.Script(
      `(function (exports, require, module, __filename, __dirname) {\n${source}\n})`,
      { filename },
    );
    const wrapper = script.runInThisContext() as (
      exports: unknown,
      require: (specifier: string) => unknown,
      module: { exports: unknown },
      filename: string,
      dirname: string,
    ) => void;
    wrapper(moduleRecord.exports, requireModule, moduleRecord, filename, path.dirname(filename));
  } catch (error) {
    if (
      error instanceof RuntimeExtensionPackageError
      && error.code === 'UNSUPPORTED_MODULE_DEPENDENCY'
    ) {
      throw error;
    }
    throw new RuntimeExtensionPackageError('MODULE_LOAD_FAILED', error);
  }
  if (
    !isRecord(moduleRecord.exports)
    || typeof moduleRecord.exports.activate !== 'function'
  ) {
    throw new RuntimeExtensionPackageError('UNSUPPORTED_MODULE_SHAPE');
  }
  return Object.freeze({
    activate: moduleRecord.exports.activate as RuntimeExtensionModule['activate'],
  });
}

function parseJson(bytes: Buffer): unknown {
  return JSON.parse(UTF8_DECODER.decode(bytes)) as unknown;
}

function assertIntegrity(
  actual: RuntimeExtensionIntegrity,
  expected: RuntimeExtensionIntegrity,
): void {
  const left = Buffer.from(actual.value, 'hex');
  const right = Buffer.from(expected.value, 'hex');
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new RuntimeExtensionPackageError('INTEGRITY_MISMATCH');
  }
}

function assertNotCancelled(signal: { readonly aborted: boolean } | undefined): void {
  if (signal?.aborted) throw new RuntimeExtensionPackageError('CANCELLED');
}

function assertPortablePackagePath(relativePath: string): void {
  if (
    !relativePath
    || relativePath.includes('\\')
    || relativePath.startsWith('/')
    || Buffer.byteLength(relativePath, 'utf8') > 512
    || relativePath.split('/').some((segment) =>
      !segment
      || segment === '.'
      || segment === '..'
      || segment.length > 120
      || segment.endsWith('.')
      || segment.endsWith(' '))
  ) {
    throw new RuntimeExtensionPackageError('UNSAFE_PACKAGE_TREE');
  }
}

function assertStableFile(root: string, filename: string, stat: fs.Stats): void {
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || !isSameOrInside(root, fs.realpathSync(filename))
  ) {
    throw new RuntimeExtensionPackageError('UNSAFE_PACKAGE_TREE');
  }
}

function snapshot(stat: fs.Stats): StableFileSnapshot {
  return {
    dev: stat.dev,
    ino: stat.ino,
    birthtimeMs: stat.birthtimeMs,
    size: stat.size,
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function assertSamePathSnapshot(
  left: StableFileSnapshot,
  right: StableFileSnapshot,
): void {
  if (
    !sameStableFileIdentity(left, right)
    || left.size !== right.size
    || left.mtimeMs !== right.mtimeMs
  ) {
    throw new RuntimeExtensionPackageError('UNSAFE_PACKAGE_TREE');
  }
}

function assertSameOpenedSnapshot(
  left: StableFileSnapshot,
  right: StableFileSnapshot,
): void {
  if (!sameStableFileSnapshot(left, right)) {
    throw new RuntimeExtensionPackageError('UNSAFE_PACKAGE_TREE');
  }
}

function assertSameInventory(
  left: readonly PackageFile[],
  right: readonly PackageFile[],
): void {
  if (left.length !== right.length) {
    throw new RuntimeExtensionPackageError('UNSAFE_PACKAGE_TREE');
  }
  for (let index = 0; index < left.length; index += 1) {
    const before = left[index];
    const after = right[index];
    if (!before || !after || before.relativePath !== after.relativePath) {
      throw new RuntimeExtensionPackageError('UNSAFE_PACKAGE_TREE');
    }
    assertSamePathSnapshot(before, after);
  }
}

function unsigned64(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

function isSameOrInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === code
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function freezeModuleMap(
  modules: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.defineProperties(
    Object.create(null),
    Object.getOwnPropertyDescriptors(modules),
  )) as Readonly<Record<string, unknown>>;
}

function hasExcludedPackageSegment(relativePath: string): boolean {
  return relativePath.split('/').some(
    (segment) => segment === '.git' || segment === 'node_modules',
  );
}
