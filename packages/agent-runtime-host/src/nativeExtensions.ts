import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import * as path from 'node:path';
import {
  computeRuntimeExtensionIntegrity,
  RUNTIME_EXTENSION_MANIFEST_FILENAME,
  RuntimeExtensionPackageError,
  validateRuntimeExtensionManifest,
  type RuntimeExtensionCatalogSourceEntry,
  type RuntimeExtensionIntegrity,
  type RuntimeExtensionInstallRequest,
  type RuntimeExtensionInstallation,
  type RuntimeExtensionManifest,
  type RuntimeExtensionCatalogSource,
} from '@marshal/agent-runtime-extensions';
import {
  sameStableFileIdentity,
  sameStableFileSnapshot,
  type RuntimeCatalogProvider as CoreRuntimeCatalogProvider,
} from '@marshal/agent-runtime-core';
import { ComposedRuntimeLifecycle } from './lifecycle.js';
import { createRuntimeResourceCatalogProvider } from './resourceCatalog.js';
import { isContained } from './state.js';
import {
  RuntimeNativeExtensionInstallationError,
  runRuntimeNativeExtensionInstallation,
  type RuntimeNativeExtensionInstallationEvent,
  type RuntimeNativeExtensionInstallationOptions,
  type RuntimeNativeExtensionInstallationResult,
} from './nativeExtensionInstallation.js';
import type { RuntimeLifecyclePort } from './types.js';
import type { RuntimeExtensionUiHostPlacement } from '@marshal/agent-runtime-extensions';

const MAX_NATIVE_ROOTS = 64;
const MAX_CHILDREN_PER_ROOT = 256;
const MAX_NATIVE_ENTRIES = 512;
const MAX_NATIVE_PACKAGE_CANDIDATES = 2_048;
const MAX_WORKSPACE_PATTERNS = 64;
const MAX_WORKSPACE_PACKAGES_PER_REPOSITORY = 256;
const MAX_METADATA_BYTES = 128 * 1024;
const PACKAGE_CANDIDATE_BOUND_ERROR =
  'Runtime native extension package candidates exceed the configured bound.';
const WORKSPACE_BOUND_ERROR =
  'Runtime native extension workspace declarations exceed the configured bound.';

export type RuntimeCatalogProvider = CoreRuntimeCatalogProvider;
export interface RuntimeLifecycleAuthority extends RuntimeLifecyclePort {
  register(lifecycle: RuntimeLifecyclePort): { dispose(): Promise<void> };
}
export interface RuntimeHostMaterializerRequest {
  readonly packageRoot: string;
  readonly integrity?: RuntimeExtensionIntegrity;
  readonly signal?: AbortSignal;
  readonly onInstallationEvent?: (event: RuntimeNativeExtensionInstallationEvent) => void;
}

function ordinal(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference) return difference;
  }
  return left.length - right.length;
}
export interface RuntimeHostMaterialization extends RuntimeExtensionInstallRequest {
  readonly canonicalRoot: string;
  readonly installation?: RuntimeNativeExtensionInstallationResult;
}
export interface RuntimeHostMaterializer {
  readonly allowedRoots: readonly string[];
  materialize(request: RuntimeHostMaterializerRequest): Promise<RuntimeHostMaterialization>;
}
export interface RuntimeHostMaterializerOptions {
  readonly allowedRoots: readonly string[];
  readonly installation?: Omit<RuntimeNativeExtensionInstallationOptions, 'signal'>;
}

export interface RuntimeHostExtensionsOptions extends RuntimeHostMaterializerOptions {
  /** Roots scanned for explicit install candidates. Defaults to allowedRoots. */
  readonly discoveryRoots?: readonly string[];
  /** Exact host overrides layered over the reviewed Node builtin module map. */
  readonly modules?: Readonly<Record<string, unknown>>;
  readonly uiPlacements?: readonly RuntimeExtensionUiHostPlacement[];
  /** Set false only for hosts exposing extension resources without native navigation. */
  readonly uiPlacementsRequired?: boolean;
  readonly restore?: boolean;
}

export type RuntimeNativeExtensionCandidateStatus =
  | 'installable'
  | 'invalid'
  | 'unbuilt'
  | 'unreadable';

export type RuntimeNativeExtensionDiagnosticCode =
  | 'manifest_missing'
  | 'manifest_invalid'
  | 'package_metadata_missing'
  | 'package_metadata_invalid'
  | 'package_metadata_mismatch'
  | 'entrypoint_missing'
  | 'installation_missing'
  | 'entrypoint_invalid'
  | 'package_changed'
  | 'package_unreadable'
  | 'package_limit_exceeded'
  | 'unsafe_package_tree'
  | 'scan_failed'
  | 'watcher_failed';

export interface RuntimeNativeExtensionDiagnostic {
  readonly code: RuntimeNativeExtensionDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

interface RuntimeNativeExtensionCandidateBase {
  readonly packageRoot: string;
  readonly diagnostics: readonly RuntimeNativeExtensionDiagnostic[];
}

export type RuntimeNativeExtensionCandidate =
  | (RuntimeNativeExtensionCandidateBase & {
      readonly status: 'installable';
      readonly identity: string;
      readonly version: string;
      readonly manifest: RuntimeExtensionManifest;
      readonly catalogEntry: RuntimeExtensionCatalogSourceEntry;
    })
  | (RuntimeNativeExtensionCandidateBase & {
      readonly status: 'unbuilt';
      readonly identity: string;
      readonly version: string;
      readonly manifest: RuntimeExtensionManifest;
      readonly installation?: RuntimeExtensionInstallation;
    })
  | (RuntimeNativeExtensionCandidateBase & {
      readonly status: 'invalid' | 'unreadable';
      readonly identity?: string;
      readonly version?: string;
    });

export interface RuntimeNativeExtensionScanResult {
  readonly roots: readonly string[];
  readonly candidates: readonly RuntimeNativeExtensionCandidate[];
  readonly entries: readonly RuntimeExtensionCatalogSourceEntry[];
}

export function createRuntimeLifecycleAuthority(
  stateRoot: string,
  delegates: readonly RuntimeLifecyclePort[],
  protectedResultRoot?: string,
): RuntimeLifecycleAuthority {
  return new ComposedRuntimeLifecycle(stateRoot, delegates, protectedResultRoot);
}

export { createRuntimeResourceCatalogProvider };

export async function createRuntimeHostMaterializer(
  options: RuntimeHostMaterializerOptions,
): Promise<RuntimeHostMaterializer> {
  if (!options || !Array.isArray(options.allowedRoots) || options.allowedRoots.length === 0) {
    throw new Error('Runtime host materializer requires at least one allowed root.');
  }

  const allowedRoots = await Promise.all(options.allowedRoots.map(resolveCanonicalRoot));
  const canonicalAllowedRoots = freezeUniqueRoots(allowedRoots);
  return {
    allowedRoots: canonicalAllowedRoots,
    async materialize(request) {
      const canonicalRoot = await resolveCanonicalRoot(request.packageRoot);
      if (!canonicalAllowedRoots.some((allowedRoot) => isContained(allowedRoot, canonicalRoot))) {
        throw new Error('Runtime extension package root must remain inside an allowed root.');
      }

      const installation = request.integrity
        ? undefined
        : await runOptionalInstallation(
            canonicalRoot,
            request.signal,
            options.installation,
            request.onInstallationEvent,
          );

      const computedIntegrity = computeRuntimeExtensionIntegrity(canonicalRoot);
      if (request.integrity) {
        assertIntegrityMatch(request.integrity, computedIntegrity);
        return { packageRoot: canonicalRoot, canonicalRoot, integrity: request.integrity };
      }

      return {
        packageRoot: canonicalRoot,
        canonicalRoot,
        integrity: computedIntegrity,
        ...(installation ? { installation } : {}),
      };
    },
  };
}

async function runOptionalInstallation(
  packageRoot: string,
  signal: AbortSignal | undefined,
  options: Omit<RuntimeNativeExtensionInstallationOptions, 'signal'> | undefined,
  onEvent: RuntimeNativeExtensionInstallationOptions['onEvent'],
): Promise<RuntimeNativeExtensionInstallationResult | undefined> {
  try {
    return await runRuntimeNativeExtensionInstallation(packageRoot, {
      ...options,
      signal,
      onEvent: (event) => {
        options?.onEvent?.(event);
        onEvent?.(event);
      },
    });
  } catch (error) {
    if (
      error instanceof RuntimeNativeExtensionInstallationError
      && error.code === 'INSTALLATION_NOT_DECLARED'
    ) {
      return undefined;
    }
    throw error;
  }
}

async function resolveCanonicalRoot(candidate: string): Promise<string> {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
    throw new Error('Runtime host materializer roots must be absolute.');
  }
  const resolved = path.resolve(candidate);
  try {
    const stat = await fs.lstat(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Runtime host materializer roots must be real directories.');
    }
    const canonical = await fs.realpath(resolved);
    if (!samePath(resolved, canonical)) {
      throw new Error('Runtime host materializer roots cannot traverse a symbolic link or junction.');
    }
    return canonical;
  } catch (error) {
    if (error instanceof Error && /Runtime host materializer roots/.test(error.message)) throw error;
    throw new Error('Runtime host materializer roots must be real directories.', { cause: error });
  }
}

function freezeUniqueRoots(roots: readonly string[]): readonly string[] {
  const unique: string[] = [];
  for (const root of roots) {
    if (unique.some((existing) => samePath(existing, root))) continue;
    unique.push(root);
  }
  return Object.freeze(unique);
}

function assertIntegrityMatch(
  pinned: RuntimeExtensionIntegrity,
  computed: RuntimeExtensionIntegrity,
): void {
  if (pinned.algorithm !== computed.algorithm || pinned.domain !== computed.domain || pinned.value !== computed.value) {
    throw new Error('Runtime extension integrity does not match the materialized package tree.');
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

/** Default standalone-repository location for a Runtime source checkout. */
export function resolveRuntimeExtensionDiscoveryRoot(root: string = process.cwd()): string {
  return path.resolve(root, 'extensions');
}

/** Bounded catalog source for packages already materialized below host-approved roots. */
export function createRuntimeNativeExtensionCatalogSource(
  roots: readonly string[] = [resolveRuntimeExtensionDiscoveryRoot()],
): RuntimeExtensionCatalogSource {
  assertNativeDiscoveryRoots(roots);
  const boundedRoots = Object.freeze([...roots]);
  return {
    id: 'runtime.native-materialized',
    label: 'Materialized native extensions',
    order: 0,
    async list(_context, signal) {
      return (await scanRuntimeNativeExtensions(boundedRoots, signal)).entries;
    },
  };
}

export async function scanRuntimeNativeExtensions(
  roots: readonly string[] = [resolveRuntimeExtensionDiscoveryRoot()],
  signal?: { readonly aborted: boolean },
): Promise<RuntimeNativeExtensionScanResult> {
  assertNativeDiscoveryRoots(roots);
  const canonicalRoots = await resolveDiscoveryRoots(roots);
  const entries: RuntimeExtensionCatalogSourceEntry[] = [];
  const candidates: RuntimeNativeExtensionCandidate[] = [];
  let packageCandidateCount = 0;
  const seen = new Map<string, Map<string, string>>();

  for (const root of canonicalRoots) {
    throwIfAborted(signal);
    let orderedChildren: readonly string[];
    try {
      orderedChildren = await readBoundedChildren(root, signal);
    } catch (error) {
      if (isMissingPath(error)) continue;
      throw error;
    }
    for (const child of orderedChildren) {
      throwIfAborted(signal);
      const repositoryRoot = path.join(root, child);
      let declared: DeclaredPackageRoots;
      let canonicalRepositoryRoot: string;
      try {
        canonicalRepositoryRoot = await resolveCanonicalChild(root, repositoryRoot);
        declared = await readDeclaredPackageRoots(canonicalRepositoryRoot, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof Error
          && (error.message === WORKSPACE_BOUND_ERROR
            || error.message === PACKAGE_CANDIDATE_BOUND_ERROR)) {
          throw error;
        }
        candidates.push(nonInstallableCandidate(
          repositoryRoot,
          'unreadable',
          diagnostic('package_unreadable', repositoryRoot, error),
        ));
        continue;
      }
      packageCandidateCount += declared.roots.length;
      if (packageCandidateCount > MAX_NATIVE_PACKAGE_CANDIDATES) {
        throw new Error(PACKAGE_CANDIDATE_BOUND_ERROR);
      }
      for (const packageRoot of declared.roots) {
        throwIfAborted(signal);
        let read: NativeCatalogCandidateRead;
        try {
          read = await readNativeCatalogCandidate(
            packageRoot,
            packageRoot === canonicalRepositoryRoot && declared.repositoryContainer,
            signal,
          );
        } catch (error) {
          if (signal?.aborted) throw error;
          read = candidateFailure(
            'unreadable',
            diagnostic('package_unreadable', packageRoot, error),
          );
        }
        if (read.status === 'ignored') continue;
        if (read.status === 'unbuilt') {
          candidates.push(Object.freeze({
            packageRoot,
            status: 'unbuilt',
            identity: read.identity,
            version: read.version,
            manifest: read.manifest,
            ...(read.installation ? { installation: read.installation } : {}),
            diagnostics: read.diagnostics,
          }));
          continue;
        }
        if (read.status !== 'installable') {
          candidates.push(nonInstallableCandidate(
            packageRoot,
            read.status,
            read.diagnostic,
            read.identity,
            read.version,
          ));
          continue;
        }

        const { canonicalRoot, manifest, integrity } = read;
        const baseId = `${manifest.identity}@${manifest.version}`;
        const integrityKey = `${integrity.algorithm}:${integrity.domain}:${integrity.value}`;
        const previousIntegrities = seen.get(baseId);
        const previousId = previousIntegrities?.get(integrityKey);
        const id = previousId
          ?? (previousIntegrities ? `${baseId}#${integrity.value}` : baseId);
        const entry = nativeCatalogEntry(id, canonicalRoot, manifest, integrity);
        candidates.push(Object.freeze({
          packageRoot: canonicalRoot,
          status: 'installable',
          identity: manifest.identity,
          version: manifest.version,
          manifest,
          catalogEntry: entry,
          diagnostics: Object.freeze([]),
        }));
        if (previousId) continue;
        if (previousIntegrities) previousIntegrities.set(integrityKey, id);
        else seen.set(baseId, new Map([[integrityKey, id]]));
        entries.push(entry);
        assertNativeEntryBound(entries.length);
      }
    }
  }
  throwIfAborted(signal);
  return Object.freeze({
    roots: Object.freeze([...canonicalRoots]),
    candidates: Object.freeze(candidates.sort((a, b) => ordinal(a.packageRoot, b.packageRoot))),
    entries: Object.freeze(entries.sort((a, b) => ordinal(a.id, b.id))),
  });
}

function assertNativeDiscoveryRoots(roots: readonly string[]): void {
  if (!Array.isArray(roots) || roots.length > MAX_NATIVE_ROOTS) {
    throw new Error('Runtime native extension roots exceed the configured bound.');
  }
  if (roots.some((root) => typeof root !== 'string' || !path.isAbsolute(root))) {
    throw new Error('Runtime native extension roots must be absolute.');
  }
}

async function resolveDiscoveryRoots(roots: readonly string[]): Promise<readonly string[]> {
  const canonicalRoots: string[] = [];
  for (const root of roots) {
    let stat;
    try {
      stat = await fs.lstat(root);
    } catch (error) {
      if (isMissingPath(error)) continue;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Runtime native extension roots must be real directories.');
    }
    const canonical = await fs.realpath(root);
    if (!samePath(root, canonical)) {
      throw new Error('Runtime native extension roots cannot traverse a symbolic link or junction.');
    }
    if (!canonicalRoots.some((existing) => samePath(existing, canonical))) {
      canonicalRoots.push(canonical);
    }
  }
  return canonicalRoots;
}

async function readDeclaredPackageRoots(
  repositoryRoot: string,
  signal?: { readonly aborted: boolean },
): Promise<DeclaredPackageRoots> {
  const declared = [repositoryRoot];
  const packageJsonPath = path.join(repositoryRoot, 'package.json');
  const packageRead = await readStableJsonFile(packageJsonPath);
  if (packageRead.status !== 'ok') {
    return { roots: declared, repositoryContainer: false };
  }
  throwIfAborted(signal);
  const workspacePatterns = readWorkspacePatterns(packageRead.value);
  const candidates: string[] = [];
  for (const pattern of workspacePatterns) {
    throwIfAborted(signal);
    for (const candidate of await expandWorkspacePattern(repositoryRoot, pattern, signal)) {
      let canonical: string;
      try {
        canonical = await resolveCanonicalDescendant(repositoryRoot, candidate);
      } catch {
        continue;
      }
      if (declared.some((existing) => samePath(existing, canonical))) continue;
      declared.push(canonical);
      candidates.push(canonical);
      if (candidates.length > MAX_WORKSPACE_PACKAGES_PER_REPOSITORY) {
        throw new Error(WORKSPACE_BOUND_ERROR);
      }
    }
  }
  return {
    roots: declared,
    repositoryContainer: workspacePatterns.length > 0,
  };
}

function readWorkspacePatterns(value: unknown): readonly string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const workspaces = Reflect.get(value, 'workspaces');
  const patterns = Array.isArray(workspaces)
    ? workspaces
    : workspaces && typeof workspaces === 'object' && !Array.isArray(workspaces)
      ? Reflect.get(workspaces, 'packages')
      : undefined;
  if (!Array.isArray(patterns)) return [];
  if (patterns.length > MAX_WORKSPACE_PATTERNS) throw new Error(WORKSPACE_BOUND_ERROR);
  return patterns.filter((pattern): pattern is string =>
    typeof pattern === 'string' && pattern.length > 0 && pattern.length <= 512);
}

async function expandWorkspacePattern(
  repositoryRoot: string,
  pattern: string,
  signal?: { readonly aborted: boolean },
): Promise<readonly string[]> {
  if (pattern.startsWith('!') || pattern.includes('\\') || path.isAbsolute(pattern)) return [];
  const segments = pattern.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return [];
  const wildcardIndexes = segments
    .map((segment, index) => segment === '*' ? index : -1)
    .filter((index) => index >= 0);
  if (segments.some((segment) => segment.includes('*') && segment !== '*')
    || wildcardIndexes.length > 1) {
    return [];
  }
  if (wildcardIndexes.length === 0) {
    return [path.join(repositoryRoot, ...segments)];
  }
  const wildcardIndex = wildcardIndexes[0]!;
  const parent = path.join(repositoryRoot, ...segments.slice(0, wildcardIndex));
  let children: readonly string[];
  try {
    children = await readBoundedChildren(parent, signal);
  } catch (error) {
    if (error instanceof Error
      && error.message === 'Runtime native extension root contains more than 256 direct child directories.') {
      throw new Error(WORKSPACE_BOUND_ERROR, { cause: error });
    }
    return [];
  }
  return children.map((child) =>
    path.join(parent, child, ...segments.slice(wildcardIndex + 1)));
}

async function resolveCanonicalDescendant(root: string, candidate: string): Promise<string> {
  const resolved = path.resolve(candidate);
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Runtime extension workspace packages must be real directories.');
  }
  const canonical = await fs.realpath(resolved);
  if (!samePath(resolved, canonical) || !isContained(root, canonical)) {
    throw new Error('Runtime extension workspace packages must remain inside their repository.');
  }
  return canonical;
}

async function readNativeCatalogCandidate(
  packageRoot: string,
  ignoreMissingManifest: boolean,
  signal?: { readonly aborted: boolean },
): Promise<NativeCatalogCandidateRead> {
  const canonicalRoot = packageRoot;
  const manifestPath = path.join(canonicalRoot, RUNTIME_EXTENSION_MANIFEST_FILENAME);
  const manifestRead = await readStableJsonFile(manifestPath);
  if (manifestRead.status === 'missing') {
    return ignoreMissingManifest
      ? { status: 'ignored' }
      : candidateFailure(
          'invalid',
          diagnostic(
            'manifest_missing',
            manifestPath,
            'Runtime extension manifest is missing.',
          ),
        );
  }
  if (manifestRead.status === 'invalid') {
    return candidateFailure(
      'invalid',
      diagnostic('manifest_invalid', manifestPath, manifestRead.message),
    );
  }
  if (manifestRead.status === 'changed') {
    return candidateFailure(
      'unreadable',
      diagnostic('package_changed', manifestPath, manifestRead.message),
    );
  }
  if (manifestRead.status === 'unreadable') {
    return candidateFailure(
      'unreadable',
      diagnostic('package_unreadable', manifestPath, manifestRead.message),
    );
  }

  let manifest: RuntimeExtensionManifest;
  try {
    manifest = validateRuntimeExtensionManifest(manifestRead.value);
  } catch (error) {
    return candidateFailure(
      'invalid',
      diagnostic('manifest_invalid', manifestPath, error),
    );
  }
  throwIfAborted(signal);
  const packageJsonPath = path.join(canonicalRoot, 'package.json');
  const packageRead = await readStableJsonFile(packageJsonPath);
  if (packageRead.status === 'missing') {
    return candidateFailure(
      'invalid',
      diagnostic(
        'package_metadata_missing',
        packageJsonPath,
        'Runtime extension package.json is missing.',
      ),
      manifest,
    );
  }
  if (packageRead.status === 'invalid') {
    return candidateFailure(
      'invalid',
      diagnostic('package_metadata_invalid', packageJsonPath, packageRead.message),
      manifest,
    );
  }
  if (packageRead.status === 'changed') {
    return candidateFailure(
      'unreadable',
      diagnostic('package_changed', packageJsonPath, packageRead.message),
      manifest,
    );
  }
  if (packageRead.status === 'unreadable') {
    return candidateFailure(
      'unreadable',
      diagnostic('package_unreadable', packageJsonPath, packageRead.message),
      manifest,
    );
  }

  const packageMetadata = packageRead.value;
  if (!packageMetadata || typeof packageMetadata !== 'object' || Array.isArray(packageMetadata)
    || Reflect.get(packageMetadata, 'name') !== manifest.identity
    || Reflect.get(packageMetadata, 'version') !== manifest.version
    || Reflect.get(packageMetadata, 'type') !== 'commonjs'
    || Reflect.get(packageMetadata, 'main') !== manifest.entrypoint) {
    return candidateFailure(
      'invalid',
      diagnostic(
        'package_metadata_mismatch',
        packageJsonPath,
        'Runtime extension package.json must match the validated manifest identity, version, module format, and entrypoint.',
      ),
      manifest,
    );
  }

  const entrypointPath = path.join(canonicalRoot, ...manifest.entrypoint.split('/'));
  const entrypointSnapshot = await readStableRegularFileSnapshot(entrypointPath);
  if (entrypointSnapshot.status === 'missing') {
    const entrypointIssue = diagnostic(
      'entrypoint_missing',
      entrypointPath,
      'Runtime extension entrypoint has not been built.',
    );
    return {
      status: 'unbuilt',
      identity: manifest.identity,
      version: manifest.version,
      manifest,
      ...(manifest.installation ? { installation: manifest.installation } : {}),
      diagnostics: Object.freeze(manifest.installation
        ? [entrypointIssue]
        : [
            entrypointIssue,
            diagnostic(
              'installation_missing',
              manifestPath,
              'Runtime extension manifest does not declare an installation script.',
            ),
          ]),
    };
  }
  if (entrypointSnapshot.status === 'invalid') {
    return candidateFailure(
      'invalid',
      diagnostic('entrypoint_invalid', entrypointPath, entrypointSnapshot.message),
      manifest,
    );
  }
  if (entrypointSnapshot.status === 'changed') {
    return candidateFailure(
      'unreadable',
      diagnostic('package_changed', entrypointPath, entrypointSnapshot.message),
      manifest,
    );
  }
  if (entrypointSnapshot.status === 'unreadable') {
    return candidateFailure(
      'unreadable',
      diagnostic('package_unreadable', entrypointPath, entrypointSnapshot.message),
      manifest,
    );
  }

  throwIfAborted(signal);
  let integrity: RuntimeExtensionIntegrity;
  try {
    integrity = computeRuntimeExtensionIntegrity(canonicalRoot);
  } catch (error) {
    if (error instanceof RuntimeExtensionPackageError
      && error.code === 'PACKAGE_LIMIT_EXCEEDED') {
      return candidateFailure(
        'invalid',
        diagnostic('package_limit_exceeded', canonicalRoot, error),
        manifest,
      );
    }
    if (error instanceof RuntimeExtensionPackageError
      && error.code === 'UNSAFE_PACKAGE_TREE') {
      return candidateFailure(
        'invalid',
        diagnostic('unsafe_package_tree', canonicalRoot, error),
        manifest,
      );
    }
    return candidateFailure(
      'unreadable',
      diagnostic('package_unreadable', canonicalRoot, error),
      manifest,
    );
  }
  throwIfAborted(signal);
  let manifestAfter: Stats;
  let packageAfter: Stats;
  let entrypointAfter: Stats;
  try {
    [manifestAfter, packageAfter, entrypointAfter] = await Promise.all([
      fs.lstat(manifestPath),
      fs.lstat(packageJsonPath),
      fs.lstat(entrypointPath),
    ]);
  } catch (error) {
    return candidateFailure(
      'unreadable',
      diagnostic(
        isMissingPath(error) ? 'package_changed' : 'package_unreadable',
        canonicalRoot,
        error,
      ),
      manifest,
    );
  }
  if (!sameStableFileSnapshot(manifestRead.snapshot, manifestAfter)
    || !sameStableFileSnapshot(packageRead.snapshot, packageAfter)
    || !sameStableFileSnapshot(entrypointSnapshot.snapshot, entrypointAfter)) {
    return candidateFailure(
      'unreadable',
      diagnostic(
        'package_changed',
        canonicalRoot,
        'Runtime extension package changed while discovery was in progress.',
      ),
      manifest,
    );
  }
  return { status: 'installable', canonicalRoot, manifest, integrity };
}

async function readStableJsonFile(
  filePath: string,
): Promise<StableJsonRead> {
  let before: Stats;
  try {
    before = await fs.lstat(filePath);
  } catch (error) {
    return isMissingPath(error)
      ? { status: 'missing' }
      : { status: 'unreadable', message: diagnosticMessage(error) };
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    return {
      status: 'invalid',
      message: 'Runtime extension metadata must be a regular file.',
    };
  }
  if (before.size > MAX_METADATA_BYTES) {
    return {
      status: 'invalid',
      message: 'Runtime extension metadata exceeds the 128 KiB limit.',
    };
  }
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const opened = await handle.stat();
    const afterOpen = await fs.lstat(filePath);
    if (!opened.isFile()
      || !sameStableFileIdentity(before, opened)
      || !sameStableFileIdentity(opened, afterOpen)) {
      return {
        status: 'changed',
        message: 'Runtime extension metadata changed while it was opened.',
      };
    }
    const content = await handle.readFile({ encoding: 'utf8' });
    const afterDescriptorRead = await handle.stat();
    const afterRead = await fs.lstat(filePath);
    if (!sameStableFileSnapshot(opened, afterDescriptorRead)
      || !sameStableFileIdentity(afterDescriptorRead, afterRead)) {
      return {
        status: 'changed',
        message: 'Runtime extension metadata changed while it was read.',
      };
    }
    try {
      return {
        status: 'ok',
        value: JSON.parse(content) as unknown,
        snapshot: afterDescriptorRead,
      };
    } catch (error) {
      return { status: 'invalid', message: diagnosticMessage(error) };
    }
  } catch (error) {
    return {
      status: isMissingPath(error) ? 'changed' : 'unreadable',
      message: diagnosticMessage(error),
    };
  } finally {
    await handle?.close();
  }
}

async function readStableRegularFileSnapshot(filePath: string): Promise<StableFileRead> {
  let before: Stats;
  try {
    before = await fs.lstat(filePath);
  } catch (error) {
    return isMissingPath(error)
      ? { status: 'missing' }
      : { status: 'unreadable', message: diagnosticMessage(error) };
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    return {
      status: 'invalid',
      message: 'Runtime extension entrypoint must be a regular file.',
    };
  }
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const opened = await handle.stat();
    const afterOpen = await fs.lstat(filePath);
    if (!opened.isFile()
      || !sameStableFileIdentity(before, opened)
      || !sameStableFileIdentity(opened, afterOpen)) {
      return {
        status: 'changed',
        message: 'Runtime extension entrypoint changed while it was opened.',
      };
    }
    return { status: 'ok', snapshot: afterOpen };
  } catch (error) {
    return {
      status: isMissingPath(error) ? 'changed' : 'unreadable',
      message: diagnosticMessage(error),
    };
  } finally {
    await handle?.close();
  }
}

interface DeclaredPackageRoots {
  readonly roots: readonly string[];
  readonly repositoryContainer: boolean;
}

type StableJsonRead =
  | { readonly status: 'ok'; readonly value: unknown; readonly snapshot: Stats }
  | { readonly status: 'missing' }
  | { readonly status: 'invalid'; readonly message: string }
  | { readonly status: 'changed'; readonly message: string }
  | { readonly status: 'unreadable'; readonly message: string };

type StableFileRead =
  | { readonly status: 'ok'; readonly snapshot: Stats }
  | { readonly status: 'missing' }
  | { readonly status: 'invalid'; readonly message: string }
  | { readonly status: 'changed'; readonly message: string }
  | { readonly status: 'unreadable'; readonly message: string };

type NativeCatalogCandidateRead =
  | {
      readonly status: 'installable';
      readonly canonicalRoot: string;
      readonly manifest: RuntimeExtensionManifest;
      readonly integrity: RuntimeExtensionIntegrity;
    }
  | { readonly status: 'ignored' }
  | {
      readonly status: 'unbuilt';
      readonly diagnostics: readonly RuntimeNativeExtensionDiagnostic[];
      readonly identity: string;
      readonly version: string;
      readonly manifest: RuntimeExtensionManifest;
      readonly installation?: RuntimeExtensionInstallation;
    }
  | {
      readonly status: 'invalid' | 'unreadable';
      readonly diagnostic: RuntimeNativeExtensionDiagnostic;
      readonly identity?: string;
      readonly version?: string;
    };

function candidateFailure(
  status: 'invalid' | 'unreadable',
  issue: RuntimeNativeExtensionDiagnostic,
  manifest?: RuntimeExtensionManifest,
): NativeCatalogCandidateRead {
  return {
    status,
    diagnostic: issue,
    ...(manifest ? { identity: manifest.identity, version: manifest.version } : {}),
  };
}

function nonInstallableCandidate(
  packageRoot: string,
  status: 'invalid' | 'unreadable',
  issue: RuntimeNativeExtensionDiagnostic,
  identity?: string,
  version?: string,
): RuntimeNativeExtensionCandidate {
  return Object.freeze({
    packageRoot,
    status,
    ...(identity === undefined ? {} : { identity }),
    ...(version === undefined ? {} : { version }),
    diagnostics: Object.freeze([issue]),
  });
}

function nativeCatalogEntry(
  id: string,
  packageRoot: string,
  manifest: RuntimeExtensionManifest,
  integrity: RuntimeExtensionIntegrity,
): RuntimeExtensionCatalogSourceEntry {
  return Object.freeze({
    id,
    identity: manifest.identity,
    version: manifest.version,
    origin: 'native',
    title: manifest.displayName ?? manifest.identity,
    description: manifest.identity,
    request: Object.freeze({
      packageRoot,
      integrity: Object.freeze({ ...integrity }),
    }),
  });
}

function diagnostic(
  code: RuntimeNativeExtensionDiagnosticCode,
  diagnosticPath: string,
  detail: unknown,
): RuntimeNativeExtensionDiagnostic {
  return Object.freeze({
    code,
    path: diagnosticPath,
    message: diagnosticMessage(detail),
  });
}

function diagnosticMessage(detail: unknown): string {
  const message = detail instanceof Error
    ? detail.message
    : typeof detail === 'string'
      ? detail
      : 'Runtime native extension discovery failed.';
  return message.slice(0, 1_024);
}

function assertNativeEntryBound(count: number): void {
  if (count > MAX_NATIVE_ENTRIES) {
    throw new Error('Runtime native extension catalog entries exceed the configured bound.');
  }
}

async function readBoundedChildren(
  root: string,
  signal?: { readonly aborted: boolean },
): Promise<string[]> {
  const children: string[] = [];
  const directory = await fs.opendir(root);
  for await (const child of directory) {
    throwIfAborted(signal);
    if (!child.isDirectory() || child.isSymbolicLink()) continue;
    children.push(child.name);
    if (children.length > MAX_CHILDREN_PER_ROOT) {
      throw new Error('Runtime native extension root contains more than 256 direct child directories.');
    }
  }
  return children.sort(ordinal);
}

async function resolveCanonicalChild(root: string, candidate: string): Promise<string> {
  const canonical = await fs.realpath(candidate);
  if (!isContained(root, canonical) || samePath(root, canonical)) {
    throw new Error('Runtime extension package must be a direct child of an allowed root.');
  }
  if (!samePath(path.dirname(canonical), path.resolve(root))) {
    throw new Error('Runtime extension package must be a direct child of an allowed root.');
  }
  return canonical;
}

function throwIfAborted(signal?: { readonly aborted: boolean }): void {
  if (signal?.aborted) throw new Error('Runtime native extension discovery was cancelled.');
}

function isMissingPath(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && Reflect.get(error, 'code') === 'ENOENT';
}
