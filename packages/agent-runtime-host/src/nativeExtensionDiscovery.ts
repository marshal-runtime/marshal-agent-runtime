import { watch, type FSWatcher } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import {
  scanRuntimeNativeExtensions,
  type RuntimeNativeExtensionCandidate,
  type RuntimeNativeExtensionDiagnostic,
  type RuntimeNativeExtensionScanResult,
} from './nativeExtensions.js';
import type {
  InvocationContext,
  RuntimeAbortSignal,
} from '@marshal/agent-runtime-core';
import type {
  RuntimeExtensionCatalogSource,
  RuntimeExtensionCatalogSourceEntry,
} from '@marshal/agent-runtime-extensions';

const DEFAULT_DEBOUNCE_MS = 100;
const MIN_DEBOUNCE_MS = 10;
const MAX_DEBOUNCE_MS = 60_000;
const MAX_ROOTS = 64;
const MAX_SUBSCRIBERS = 256;
const MAX_WATCH_RECONCILIATIONS = 256;

export interface RuntimeNativeExtensionDiscoverySnapshot {
  readonly revision: number;
  readonly status: 'ready' | 'error';
  readonly scannedAt: string;
  readonly roots: readonly string[];
  readonly candidates: readonly RuntimeNativeExtensionCandidate[];
  readonly entries: readonly RuntimeExtensionCatalogSourceEntry[];
  readonly diagnostics: readonly RuntimeNativeExtensionDiagnostic[];
}

export type RuntimeNativeExtensionDiscoveryListener = (
  snapshot: RuntimeNativeExtensionDiscoverySnapshot,
) => void;

export interface RuntimeNativeExtensionDiscoverySubscription {
  dispose(): void;
}

export interface RuntimeNativeExtensionDiscoveryService {
  snapshot(): RuntimeNativeExtensionDiscoverySnapshot;
  subscribe(
    listener: RuntimeNativeExtensionDiscoveryListener,
  ): RuntimeNativeExtensionDiscoverySubscription;
  refresh(): Promise<RuntimeNativeExtensionDiscoverySnapshot>;
  dispose(): Promise<void>;
}

export interface RuntimeNativeExtensionDiscoveryServiceOptions {
  readonly roots: readonly string[];
  /** Filesystem events within this window collapse into one bounded rescan. */
  readonly debounceMs?: number;
  /** Disable watching while retaining explicit initial and refresh scans. */
  readonly watch?: boolean;
}

export function createRuntimeNativeExtensionDiscoveryCatalogSource(
  discovery: RuntimeNativeExtensionDiscoveryService,
): RuntimeExtensionCatalogSource {
  return Object.freeze({
    id: 'runtime.native-materialized',
    label: 'Materialized native extensions',
    order: 0,
    async list(_context: InvocationContext, signal?: RuntimeAbortSignal) {
      if (signal?.aborted) {
        throw new Error('Runtime native extension catalog discovery was cancelled.');
      }
      const snapshot = discovery.snapshot();
      if (signal?.aborted) {
        throw new Error('Runtime native extension catalog discovery was cancelled.');
      }
      return snapshot.entries;
    },
  });
}

export async function createRuntimeNativeExtensionDiscoveryService(
  options: RuntimeNativeExtensionDiscoveryServiceOptions,
): Promise<RuntimeNativeExtensionDiscoveryService> {
  if (!options || typeof options !== 'object' || !Array.isArray(options.roots)) {
    throw new TypeError('Runtime native extension discovery options are invalid.');
  }
  if (options.roots.length > MAX_ROOTS) {
    throw new Error('Runtime native extension roots exceed the configured bound.');
  }
  if (options.roots.some((root) => typeof root !== 'string' || !path.isAbsolute(root))) {
    throw new Error('Runtime native extension roots must be absolute.');
  }
  const roots = Object.freeze(uniquePaths(options.roots));
  const debounceMs = normalizeDebounceMs(options.debounceMs);
  const initial = await scanRuntimeNativeExtensions(roots);
  let current = readySnapshot(1, initial);
  let disposed = false;
  let revision = 1;
  let debounceTimer: NodeJS.Timeout | undefined;
  let maxDebounceTimer: NodeJS.Timeout | undefined;
  let scanInFlight: Promise<RuntimeNativeExtensionDiscoverySnapshot> | undefined;
  let pendingInvalidation = false;
  const listeners = new Set<RuntimeNativeExtensionDiscoveryListener>();
  const watchers = new Map<string, RootWatcher>();

  const publish = (
    snapshot: RuntimeNativeExtensionDiscoverySnapshot,
  ): RuntimeNativeExtensionDiscoverySnapshot => {
    current = snapshot;
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        listener(snapshot);
      } catch {
        // A faulty observer must not terminate the runtime or block other observers.
      }
    }
    return snapshot;
  };

  const nextRevision = (): number => {
    if (revision >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Runtime native extension discovery revision limit reached.');
    }
    revision += 1;
    return revision;
  };

  const publishFailure = (
    code: 'scan_failed' | 'watcher_failed',
    diagnosticPath: string,
    error: unknown,
  ): RuntimeNativeExtensionDiscoverySnapshot => publish(Object.freeze({
    revision: nextRevision(),
    status: 'error',
    scannedAt: new Date().toISOString(),
    roots: current.roots,
    candidates: current.candidates,
    entries: current.entries,
    diagnostics: Object.freeze([Object.freeze({
      code,
      path: diagnosticPath,
      message: boundedMessage(error),
    })]),
  }));

  const scheduleRefresh = (): void => {
    if (disposed) return;
    // Watch events are invalidation hints only; the callback can only queue a scan.
    pendingInvalidation = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (!maxDebounceTimer) {
      maxDebounceTimer = setTimeout(() => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = undefined;
        maxDebounceTimer = undefined;
        pendingInvalidation = false;
        void refreshFromScan();
      }, Math.min(debounceMs * 4, MAX_DEBOUNCE_MS));
      maxDebounceTimer.unref?.();
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      if (maxDebounceTimer) clearTimeout(maxDebounceTimer);
      maxDebounceTimer = undefined;
      pendingInvalidation = false;
      void refreshFromScan();
    }, debounceMs);
    debounceTimer.unref?.();
  };

  const reconcileWatchers = async (): Promise<boolean> => {
    if (disposed || options.watch === false) return false;
    const next = new Map<string, RootWatcher>();
    let changed = watchers.size !== roots.length;
    try {
      for (const root of roots) {
        const spec = await resolveRootWatchSpec(root);
        if (disposed) {
          closeProvisionalWatchers(next, watchers);
          return false;
        }
        const key = normalizePath(root);
        const existing = watchers.get(key);
        if (existing && sameWatchSpec(existing, spec)) {
          next.set(key, existing);
          continue;
        }
        changed = true;
        let registration!: RootWatcher;
        const fileWatchers = createRootWatchers(spec, scheduleRefresh, (error) => {
          if (disposed) return;
          closeRootWatcher(registration);
          if (watchers.get(key) === registration) watchers.delete(key);
          publishFailure('watcher_failed', root, error);
          scheduleRefresh();
        });
        registration = { ...spec, watchers: fileWatchers };
        next.set(key, registration);
      }
    } catch (error) {
      closeProvisionalWatchers(next, watchers);
      throw error;
    }
    if (disposed) {
      closeProvisionalWatchers(next, watchers);
      return false;
    }
    for (const [key, existing] of watchers) {
      if (next.get(key) !== existing) closeRootWatcher(existing);
    }
    watchers.clear();
    for (const [key, watcher] of next) watchers.set(key, watcher);
    return changed;
  };

  const scanAndReconcile = async (
    seed?: RuntimeNativeExtensionScanResult,
  ): Promise<RuntimeNativeExtensionScanResult> => {
    let result: RuntimeNativeExtensionScanResult;
    if (seed) {
      result = seed;
    } else {
      try {
        result = await scanRuntimeNativeExtensions(roots);
      } catch (error) {
        await reconcileWatchers();
        throw error;
      }
    }
    if (options.watch === false) return result;
    for (let attempt = 0; attempt < MAX_WATCH_RECONCILIATIONS; attempt += 1) {
      if (!await reconcileWatchers()) return result;
      result = await scanRuntimeNativeExtensions(roots);
    }
    throw new Error('Runtime native extension watcher topology did not stabilize.');
  };

  const refreshFromScan = (): Promise<RuntimeNativeExtensionDiscoverySnapshot> => {
    if (disposed) {
      return Promise.reject(new Error('Runtime native extension discovery service is disposed.'));
    }
    if (scanInFlight) {
      pendingInvalidation = true;
      return scanInFlight;
    }
    let operation!: Promise<RuntimeNativeExtensionDiscoverySnapshot>;
    operation = (async () => {
      try {
        const result = await scanAndReconcile();
        if (disposed) return current;
        return publish(readySnapshot(nextRevision(), result));
      } catch (error) {
        if (disposed) return current;
        return publishFailure('scan_failed', commonRoot(roots), error);
      } finally {
        if (scanInFlight === operation) scanInFlight = undefined;
        if (pendingInvalidation && !disposed && !debounceTimer) scheduleRefresh();
      }
    })();
    scanInFlight = operation;
    return operation;
  };

  if (options.watch !== false) {
    try {
      current = readySnapshot(1, await scanAndReconcile(initial));
      // The watched rescan already includes filesystem events raised while the
      // initial watcher topology was being installed. Do not replay those
      // startup invalidations as a redundant post-start scan.
      pendingInvalidation = false;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      if (maxDebounceTimer) {
        clearTimeout(maxDebounceTimer);
        maxDebounceTimer = undefined;
      }
    } catch (error) {
      for (const watcher of watchers.values()) closeRootWatcher(watcher);
      throw new Error('Runtime native extension watcher could not be started.', {
        cause: error,
      });
    }
  }

  return Object.freeze({
    snapshot: () => current,
    subscribe(listener: RuntimeNativeExtensionDiscoveryListener) {
      if (disposed) {
        throw new Error('Runtime native extension discovery service is disposed.');
      }
      if (typeof listener !== 'function') {
        throw new TypeError('Runtime native extension discovery listener must be a function.');
      }
      if (listeners.size >= MAX_SUBSCRIBERS) {
        throw new Error('Runtime native extension discovery subscriber limit reached.');
      }
      listeners.add(listener);
      let active = true;
      return Object.freeze({
        dispose() {
          if (!active) return;
          active = false;
          listeners.delete(listener);
        },
      });
    },
    refresh: refreshFromScan,
    async dispose() {
      if (disposed) return;
      disposed = true;
      pendingInvalidation = false;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      if (maxDebounceTimer) {
        clearTimeout(maxDebounceTimer);
        maxDebounceTimer = undefined;
      }
      for (const watcher of watchers.values()) closeRootWatcher(watcher);
      watchers.clear();
      listeners.clear();
      await scanInFlight;
      for (const watcher of watchers.values()) closeRootWatcher(watcher);
      watchers.clear();
    },
  });
}

type RootWatchSpec =
  | {
      readonly root: string;
      readonly kind: 'root';
      readonly directory: string;
      readonly device: number;
      readonly inode: number;
    }
  | {
      readonly root: string;
      readonly kind: 'sentinel';
      readonly directory: string;
      readonly expectedName: string;
      readonly expectedState: string;
    };

type RootWatcher = RootWatchSpec & {
  readonly watchers: readonly FSWatcher[];
};

async function resolveRootWatchSpec(root: string): Promise<RootWatchSpec> {
  const resolvedRoot = path.resolve(root);
  try {
    const stat = await lstat(resolvedRoot);
    if (!stat.isSymbolicLink() && stat.isDirectory()) {
      const canonical = await realpath(resolvedRoot);
      if (equalPath(resolvedRoot, canonical)) {
        return {
          root: resolvedRoot,
          kind: 'root',
          directory: canonical,
          device: stat.dev,
          inode: stat.ino,
        };
      }
    }
    return createSentinelWatchSpec(resolvedRoot, stat);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }

  let missing = resolvedRoot;
  while (true) {
    const parent = path.dirname(missing);
    if (equalPath(parent, missing)) {
      throw new Error('Runtime native extension root has no watchable ancestor.');
    }
    try {
      const stat = await lstat(parent);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(
          'Runtime native extension root ancestors must be real directories.',
        );
      }
      const canonical = await realpath(parent);
      if (!equalPath(parent, canonical)) {
        throw new Error(
          'Runtime native extension root ancestors cannot traverse a symbolic link or junction.',
        );
      }
      return {
        root: resolvedRoot,
        kind: 'sentinel',
        directory: canonical,
        expectedName: path.basename(missing),
        expectedState: await pathState(missing),
      };
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      missing = parent;
    }
  }
}

function createRootWatchers(
  spec: RootWatchSpec,
  invalidate: () => void,
  fail: (error: unknown) => void,
): readonly FSWatcher[] {
  if (spec.kind === 'sentinel') {
    return [watchExactChild(
      spec.directory,
      spec.expectedName,
      spec.expectedState,
      invalidate,
      fail,
    )];
  }
  const rootWatcher = watch(
    spec.directory,
    { persistent: false, recursive: true },
    invalidate,
  );
  rootWatcher.on('error', fail);
  const parent = path.dirname(spec.directory);
  if (equalPath(parent, spec.directory)) return [rootWatcher];
  return [
    rootWatcher,
    watchExactChild(
      parent,
      path.basename(spec.directory),
      directoryState(spec.device, spec.inode),
      invalidate,
      fail,
    ),
  ];
}

function watchExactChild(
  directory: string,
  expectedName: string,
  expectedState: string,
  invalidate: () => void,
  fail: (error: unknown) => void,
): FSWatcher {
  const watcher = watch(directory, { persistent: false }, (eventType, filename) => {
    if (filename !== null) {
      if (
        eventType === 'rename'
        && equalName(filename.toString(), expectedName)
      ) {
        invalidate();
      }
      return;
    }
    void pathState(path.join(directory, expectedName))
      .then((state) => {
        if (state !== expectedState) invalidate();
      })
      .catch(fail);
  });
  watcher.on('error', fail);
  return watcher;
}

function sameWatchSpec(left: RootWatcher, right: RootWatchSpec): boolean {
  return left.kind === right.kind
    && equalPath(left.directory, right.directory)
    && (left.kind === 'root' && right.kind === 'root'
      ? left.device === right.device && left.inode === right.inode
      : left.kind === 'sentinel'
        && right.kind === 'sentinel'
        && equalName(left.expectedName, right.expectedName)
        && left.expectedState === right.expectedState);
}

function closeProvisionalWatchers(
  next: ReadonlyMap<string, RootWatcher>,
  current: ReadonlyMap<string, RootWatcher>,
): void {
  const currentWatchers = new Set(
    [...current.values()].flatMap(({ watchers }) => watchers),
  );
  for (const candidate of next.values()) {
    for (const watcher of candidate.watchers) {
      if (!currentWatchers.has(watcher)) watcher.close();
    }
  }
}

function closeRootWatcher(registration: RootWatcher | undefined): void {
  for (const watcher of registration?.watchers ?? []) watcher.close();
}

async function createSentinelWatchSpec(
  resolvedRoot: string,
  stat: Awaited<ReturnType<typeof lstat>>,
): Promise<RootWatchSpec> {
  const parent = path.dirname(resolvedRoot);
  const parentStat = await lstat(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error('Runtime native extension root ancestors must be real directories.');
  }
  const canonical = await realpath(parent);
  if (!equalPath(parent, canonical)) {
    throw new Error(
      'Runtime native extension root ancestors cannot traverse a symbolic link or junction.',
    );
  }
  return {
    root: resolvedRoot,
    kind: 'sentinel',
    directory: canonical,
    expectedName: path.basename(resolvedRoot),
    expectedState: fileState(stat),
  };
}

async function pathState(candidate: string): Promise<string> {
  try {
    return fileState(await lstat(candidate));
  } catch (error) {
    if (isMissingPath(error)) return 'missing';
    throw error;
  }
}

function fileState(stat: Awaited<ReturnType<typeof lstat>>): string {
  const kind = stat.isSymbolicLink()
    ? 'symlink'
    : stat.isDirectory()
      ? 'directory'
      : stat.isFile()
        ? 'file'
        : 'other';
  return `${kind}:${stat.dev}:${stat.ino}`;
}

function directoryState(device: number, inode: number): string {
  return `directory:${device}:${inode}`;
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function uniquePaths(values: readonly string[]): string[] {
  const unique = new Map<string, string>();
  for (const value of values) {
    const key = normalizePath(value);
    if (!unique.has(key)) unique.set(key, value);
  }
  return [...unique.values()];
}

function equalPath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function equalName(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isMissingPath(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && Reflect.get(error, 'code') === 'ENOENT';
}

function readySnapshot(
  revision: number,
  result: RuntimeNativeExtensionScanResult,
): RuntimeNativeExtensionDiscoverySnapshot {
  return Object.freeze({
    revision,
    status: 'ready',
    scannedAt: new Date().toISOString(),
    roots: result.roots,
    candidates: result.candidates,
    entries: result.entries,
    diagnostics: Object.freeze([]),
  });
}

function normalizeDebounceMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_DEBOUNCE_MS;
  if (!Number.isInteger(value) || value < MIN_DEBOUNCE_MS || value > MAX_DEBOUNCE_MS) {
    throw new TypeError(
      `Runtime native extension discovery debounceMs must be an integer from ${MIN_DEBOUNCE_MS} to ${MAX_DEBOUNCE_MS}.`,
    );
  }
  return value;
}

function commonRoot(roots: readonly string[]): string {
  return roots.length === 1 ? roots[0]! : '<runtime-native-extension-roots>';
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : 'Runtime native extension discovery failed.';
  return message.slice(0, 1_024);
}
