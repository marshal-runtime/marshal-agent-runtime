import { isAbsolute, resolve } from 'node:path';
import type {
  InvocationContext,
  MaybePromise,
  RuntimeAbortSignal,
} from '@marshal/agent-runtime-core';
import {
  RUNTIME_EXTENSION_INTEGRITY_DOMAIN,
  type RuntimeExtensionConfiguration,
  type RuntimeExtensionInstallRequest,
  type RuntimeExtensionOperationOptions,
  type RuntimeExtensionRecord,
} from './contracts.js';
import {
  type RuntimeExtensionCatalogEntry,
  type RuntimeExtensionCatalogInstallationFilter,
  type RuntimeExtensionCatalogOrigin,
  type RuntimeExtensionCatalogSearchField,
  type RuntimeExtensionCatalogSearchMatch,
  type RuntimeExtensionCatalogSearchRequest,
  type RuntimeExtensionCatalogSearchResponse,
  type RuntimeExtensionCatalogService,
  type RuntimeExtensionCatalogSource,
  type RuntimeExtensionCatalogSourceEntry,
  type RuntimeExtensionLifecycleService,
  type RuntimeExtensionLifecycleRecord,
  type RuntimeExtensionContractRepairRequest,
  type RuntimeExtensionContractRepairResult,
} from './services.js';
import {
  requireRuntimeExtensionIdentity,
  requireRuntimeExtensionVersion,
} from './manifest.js';
import type { RuntimeServiceAccessor } from '@marshal/agent-runtime-composer';
import { RUNTIME_EXTENSION_LIFECYCLE_SERVICE } from './services.js';

const MAX_SOURCES = 64;
const MAX_SOURCE_ENTRIES = 1_024;
const MAX_ENTRIES = 4_096;
const MAX_SEARCH_LIMIT = 1_000;
const MAX_TAGS = 64;
const MAX_METADATA_VALUE_LENGTH = 8_192;
const MAX_METADATA_NODES = 4_096;
const MAX_METADATA_BYTES = 65_536;
const MAX_METADATA_DEPTH = 8;
const MAX_METADATA_COLLECTION = 128;
const MAX_PACKAGE_ROOT_LENGTH = 32_768;
const SHA256 = /^[0-9a-f]{64}$/;

export const RUNTIME_EXTENSION_CATALOG_ORIGIN_LABELS = Object.freeze({
  native: 'Native',
  dsh: 'DSH-compatible',
  'authored-typescript': 'Authored TypeScript',
} as const);

export type RuntimeExtensionCatalogErrorCode =
  | 'INVALID_SOURCE'
  | 'DUPLICATE_SOURCE'
  | 'INVALID_ENTRY'
  | 'DUPLICATE_ENTRY'
  | 'ENTRY_NOT_FOUND'
  | 'CANCELLED';

const messages: Readonly<Record<RuntimeExtensionCatalogErrorCode, string>> = {
  INVALID_SOURCE: 'The runtime extension catalog source is invalid.',
  DUPLICATE_SOURCE: 'The runtime extension catalog contains duplicate source IDs.',
  INVALID_ENTRY: 'The runtime extension catalog entry is invalid.',
  DUPLICATE_ENTRY: 'The runtime extension catalog contains duplicate entry IDs.',
  ENTRY_NOT_FOUND: 'The runtime extension catalog entry was not found.',
  CANCELLED: 'The runtime extension catalog operation was cancelled.',
};

export class RuntimeExtensionCatalogError extends Error {
  constructor(readonly code: RuntimeExtensionCatalogErrorCode, cause?: unknown) {
    super(messages[code], cause === undefined ? undefined : { cause });
    this.name = 'RuntimeExtensionCatalogError';
  }
}

interface NormalizedSource {
  readonly id: string;
  readonly label: string;
  readonly order: number;
  readonly list: RuntimeExtensionCatalogSource['list'];
}

interface CapturedCandidate {
  readonly entry: RuntimeExtensionCatalogSourceEntry;
  readonly source: NormalizedSource;
}

export interface RuntimeExtensionCatalogOptions {
  readonly lifecycle?: RuntimeExtensionLifecycleService;
  readonly services?: RuntimeServiceAccessor;
  readonly sources: readonly RuntimeExtensionCatalogSource[];
  readonly projectInstalledEntry?: (
    entry: RuntimeExtensionCatalogEntry,
  ) => RuntimeExtensionCatalogEntry;
}

export class RuntimeExtensionCatalog implements RuntimeExtensionCatalogService {
  private readonly lifecycle?: RuntimeExtensionLifecycleService;
  private readonly services?: RuntimeServiceAccessor;
  private readonly projectInstalledEntry?: RuntimeExtensionCatalogOptions['projectInstalledEntry'];
  private readonly sources: readonly NormalizedSource[];

  constructor(options: RuntimeExtensionCatalogOptions) {
    if (!options || typeof options !== 'object' || !Array.isArray(options.sources)
      || options.sources.length > MAX_SOURCES || (!options.lifecycle && !options.services)) {
      throw invalidSource('Catalog options are invalid.');
    }
    const sources = options.sources.map(normalizeSource).sort(compareSources);
    if (new Set(sources.map((source) => source.id)).size !== sources.length) {
      throw new RuntimeExtensionCatalogError('DUPLICATE_SOURCE');
    }
    this.lifecycle = options.lifecycle;
    this.services = options.services;
    this.projectInstalledEntry = options.projectInstalledEntry;
    this.sources = Object.freeze(sources);
  }

  async discover(
    context: InvocationContext,
    options: RuntimeExtensionOperationOptions = {},
  ): Promise<readonly RuntimeExtensionCatalogEntry[]> {
    assertContext(context);
    const snapshot = snapshotContext(context);
    const signal = options.signal ?? context.signal;
    assertNotCancelled(signal);
    const entries: RuntimeExtensionCatalogEntry[] = [];
    const discoveredEntries: CapturedCandidate[] = [];
    for (const source of this.sources) {
      assertNotCancelled(signal);
      const discovered = await source.list(snapshot, signal);
      assertNotCancelled(signal);
      if (!Array.isArray(discovered) || discovered.length > MAX_SOURCE_ENTRIES) {
        throw invalidSource(`Catalog source "${source.id}" returned too many entries.`);
      }
      for (const candidate of discovered) {
        discoveredEntries.push(captureCandidate(candidate, source));
        if (discoveredEntries.length > MAX_ENTRIES) {
          throw invalidSource('Catalog sources returned too many entries.');
        }
      }
    }
    assertNotCancelled(signal);
    const installations = new Map(
      this.lifecycleService().list().map((record) => [record.identity, detachedRecord(record)] as const),
    );
    const uniqueEntries = new Map<string, RuntimeExtensionCatalogEntry>();
    for (const candidate of discoveredEntries) {
     const normalized = normalizeEntry(candidate.entry, candidate.source, installations);
     const previous = uniqueEntries.get(normalized.id);
     if (!previous) {
      uniqueEntries.set(normalized.id, normalized);
      continue;
     }
     if (!sameCatalogCandidate(previous, normalized)) {
       throw new RuntimeExtensionCatalogError(
         'DUPLICATE_ENTRY',
         new TypeError(`Conflicting catalog entry: ${normalized.id}`),
       );
     }
    }
    for (const lifecycle of installations.values()) {
     const installedContentPresent = [...uniqueEntries.values()].some((entry) =>
       entry.identity === lifecycle.identity
       && entry.version === lifecycle.version
       && entry.request.integrity.algorithm === lifecycle.integrity.algorithm
       && entry.request.integrity.domain === lifecycle.integrity.domain
       && entry.request.integrity.value === lifecycle.integrity.value);
     if (installedContentPresent) continue;
     if (!lifecycle.request) continue;
     const baseId = `${lifecycle.identity}@${lifecycle.version}`;
     const source: NormalizedSource = {
       id: 'runtime.installed-lifecycle',
       label: 'Installed runtime extensions',
       order: Number.MAX_SAFE_INTEGER,
       list: async () => [],
     };
     const synthetic: RuntimeExtensionCatalogSourceEntry = {
       id: uniqueEntries.has(baseId)
         ? `${baseId}#${lifecycle.integrity.value}`
         : baseId,
       identity: lifecycle.identity,
       version: lifecycle.version,
       origin: lifecycle.origin ?? 'native',
       title: lifecycle.title ?? lifecycle.identity,
       description: lifecycle.description ?? lifecycle.identity,
       ...(lifecycle.tags ? { tags: lifecycle.tags } : {}),
       ...(lifecycle.publisher ? { publisher: lifecycle.publisher } : {}),
       ...(lifecycle.metadata ? { metadata: lifecycle.metadata } : {}),
       request: lifecycle.request,
     };
     const normalized = normalizeEntry(synthetic, source, installations);
     uniqueEntries.set(normalized.id, normalized);
    }
    entries.push(...Array.from(uniqueEntries.values()).map((entry) =>
      entry.isCurrentVersion && this.projectInstalledEntry
        ? this.projectInstalledEntry(entry)
        : entry));
    return Object.freeze(entries.sort(compareEntries));
  }

  async get(
    id: string,
    context: InvocationContext,
    options: RuntimeExtensionOperationOptions = {},
  ): Promise<RuntimeExtensionCatalogEntry | undefined> {
    const normalizedId = text(id, 'entry ID', 512);
    return (await this.discover(context, options)).find((entry) => entry.id === normalizedId);
  }

  async search(
    request: RuntimeExtensionCatalogSearchRequest = {},
    context: InvocationContext,
    options: RuntimeExtensionOperationOptions = {},
  ): Promise<RuntimeExtensionCatalogSearchResponse> {
    const normalized = normalizeSearch(request);
    const matches = (await this.discover(context, options))
      .filter((entry) => matchesFilters(entry, normalized))
      .flatMap((entry) => {
        const match = matchEntry(entry, normalized.terms);
        return match ? [match] : [];
      })
      .sort((left, right) => right.score - left.score || compareEntries(left.entry, right.entry))
      .slice(0, normalized.limit);
    return Object.freeze({ query: normalized.query, matches: Object.freeze(matches) });
  }

  async install(
    catalogEntryId: string,
    context: InvocationContext,
    options: RuntimeExtensionOperationOptions = {},
  ): Promise<RuntimeExtensionRecord> {
    const snapshot = snapshotContext(context);
    const entry = await this.resolveForMutation(catalogEntryId, snapshot, options);
    return this.lifecycleService().install(entry.request, effectiveOptions(snapshot, options));
  }

  async update(
    identity: string,
    catalogEntryId: string,
    context: InvocationContext,
    options: RuntimeExtensionOperationOptions = {},
  ): Promise<RuntimeExtensionRecord> {
    const snapshot = snapshotContext(context);
    const normalizedIdentity = requireRuntimeExtensionIdentity(identity);
    const entry = await this.resolveForMutation(catalogEntryId, snapshot, options);
    if (entry.identity !== normalizedIdentity) {
      throw new RuntimeExtensionCatalogError('INVALID_ENTRY');
    }
    return this.lifecycleService().update(normalizedIdentity, entry.request, effectiveOptions(snapshot, options));
  }

  enable(identity: string, context: InvocationContext, options: RuntimeExtensionOperationOptions = {}) {
    assertContext(context);
    const snapshot = snapshotContext(context);
    assertNotCancelled(options.signal ?? snapshot.signal);
    return this.lifecycleService().enable(requireRuntimeExtensionIdentity(identity), effectiveOptions(snapshot, options));
  }

  disable(identity: string, context: InvocationContext, options: RuntimeExtensionOperationOptions = {}) {
    assertContext(context);
    const snapshot = snapshotContext(context);
    assertNotCancelled(options.signal ?? snapshot.signal);
    return this.lifecycleService().disable(requireRuntimeExtensionIdentity(identity), effectiveOptions(snapshot, options));
  }

  remove(identity: string, context: InvocationContext, options: RuntimeExtensionOperationOptions = {}) {
    assertContext(context);
    const snapshot = snapshotContext(context);
    assertNotCancelled(options.signal ?? snapshot.signal);
    return this.lifecycleService().remove(requireRuntimeExtensionIdentity(identity), effectiveOptions(snapshot, options));
  }

  listInstalled(context: InvocationContext): readonly RuntimeExtensionRecord[] {
    assertContext(context);
    assertNotCancelled(context.signal);
    return Object.freeze(this.lifecycleService().list().map(detachedRecord));
  }

  repairContractConflict(
    request: RuntimeExtensionContractRepairRequest,
    context: InvocationContext,
    options: RuntimeExtensionOperationOptions = {},
  ): Promise<RuntimeExtensionContractRepairResult> {
    assertContext(context);
    const snapshot = snapshotContext(context);
    assertNotCancelled(options.signal ?? snapshot.signal);
    const service = this.lifecycleService();
    if (!service.repairContractConflict) {
      throw new Error('Runtime extension contract repair is unavailable.');
    }
    return Promise.resolve(service.repairContractConflict(request, effectiveOptions(snapshot, options)));
  }

  private lifecycleService(): RuntimeExtensionLifecycleService {
    return this.services?.get(RUNTIME_EXTENSION_LIFECYCLE_SERVICE) ?? this.lifecycle
      ?? (() => { throw new Error('Runtime extension lifecycle service is unavailable.'); })();
  }

  private async resolveForMutation(
    id: string,
    context: InvocationContext,
    options: RuntimeExtensionOperationOptions,
  ): Promise<RuntimeExtensionCatalogEntry> {
    const normalizedId = text(id, 'entry ID', 512);
    const snapshot = snapshotContext(context);
    const first = await this.get(normalizedId, snapshot, options);
    if (!first) throw new RuntimeExtensionCatalogError('ENTRY_NOT_FOUND');
    const second = await this.get(normalizedId, snapshot, options);
    if (!second || !sameCandidate(first, second)) {
      throw new RuntimeExtensionCatalogError('INVALID_ENTRY');
    }
    return second;
  }
}

function normalizeSource(source: RuntimeExtensionCatalogSource): NormalizedSource {
  if (!source || typeof source !== 'object' || typeof source.list !== 'function') {
    throw invalidSource('Source must provide list.');
  }
  return Object.freeze({
    id: text(source.id, 'source ID', 256, invalidSource),
    label: text(source.label, 'source label', 256, invalidSource),
    order: orderValue(source.order, invalidSource),
    list: source.list.bind(source),
  });
}

function normalizeEntry(
  entry: RuntimeExtensionCatalogSourceEntry,
  source: NormalizedSource,
  installations: ReadonlyMap<string, RuntimeExtensionRecord>,
): RuntimeExtensionCatalogEntry {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw invalidEntry('Entry must be an object.');
  }

  let identity: string;
  let version: string;
  try {
    identity = requireRuntimeExtensionIdentity(entry.identity);
    version = requireRuntimeExtensionVersion(entry.version);
  } catch (error) {
    throw new RuntimeExtensionCatalogError('INVALID_ENTRY', error);
  }
  if (!isOrigin(entry.origin)) throw invalidEntry('Entry origin is invalid.');
  const id = text(entry.id, 'entry ID', 512, invalidEntry);
  const title = text(entry.title, 'entry title', 512, invalidEntry);
  const description = text(entry.description, 'entry description', 4_096, invalidEntry);
  const tags = normalizeTags(entry.tags);
  const publisher = entry.publisher === undefined
    ? undefined : text(entry.publisher, 'publisher', 512, invalidEntry);
  const metadata = entry.metadata === undefined ? undefined : normalizeMetadata(entry.metadata);
  const request = normalizeRequest(entry.request);
  const order = orderValue(entry.order, invalidEntry);
  const installation = installations.get(identity);
  const matchesInstallation = installation !== undefined
    && installation.version === version
    && installation.integrity.algorithm === request.integrity.algorithm
    && installation.integrity.domain === request.integrity.domain
    && installation.integrity.value === request.integrity.value;
  const lifecycle = installation as RuntimeExtensionLifecycleRecord | undefined;
  return Object.freeze({
    id, identity, version, origin: entry.origin,
    originLabel: RUNTIME_EXTENSION_CATALOG_ORIGIN_LABELS[entry.origin],
    title, description,
    ...(tags ? { tags } : {}),
    ...(publisher ? { publisher } : {}),
    ...(metadata ? { metadata } : {}),
    order, request, sourceId: source.id, sourceLabel: source.label, sourceOrder: source.order,
    ...(matchesInstallation ? { installation } : {}),
    ...(matchesInstallation && lifecycle ? {
      health: lifecycle.health,
      blockReasons: lifecycle.blockReasons,
      dependencies: lifecycle.dependencies,
      providedServices: lifecycle.providedServices,
      requiredServices: lifecycle.requiredServices,
      providerSelections: lifecycle.providerSelections,
      contractConflicts: lifecycle.contractConflicts,
      contracts: lifecycle.contracts,
      configurationSchema: lifecycle.configurationSchema,
      configurationValues: lifecycle.configurationValues,
      docs: lifecycle.docs,
      resources: lifecycle.resources,
      examples: lifecycle.examples,
      appServices: lifecycle.appServices,
      appServicesSnippet: lifecycle.appServicesSnippet,
    } : {}),
    isCurrentVersion: matchesInstallation,
  });
}

function normalizeRequest(request: unknown): RuntimeExtensionInstallRequest {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw invalidEntry('Install request is invalid.');
  }
  const packageRoot = readOwnData(request, 'packageRoot', true);
  const integrity = readOwnData(request, 'integrity', true);
  if (typeof packageRoot !== 'string' || !isAbsolute(packageRoot)
    || packageRoot !== packageRoot.trim() || packageRoot !== packageRoot.normalize('NFC')
    || packageRoot.length > MAX_PACKAGE_ROOT_LENGTH
    || !integrity || typeof integrity !== 'object' || Array.isArray(integrity)) {
    throw invalidEntry('Install request is invalid.');
  }
  const algorithm = readOwnData(integrity, 'algorithm', true);
  const domain = readOwnData(integrity, 'domain', true);
  const value = readOwnData(integrity, 'value', true);
  if (algorithm !== 'sha256' || domain !== RUNTIME_EXTENSION_INTEGRITY_DOMAIN
    || typeof value !== 'string' || !SHA256.test(value)) throw invalidEntry('Install request is invalid.');
  return Object.freeze({
    packageRoot,
    integrity: Object.freeze({
      algorithm: 'sha256',
      domain: RUNTIME_EXTENSION_INTEGRITY_DOMAIN,
      value,
    }),
  });
}

function normalizeTags(value: readonly string[] | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_TAGS) throw invalidEntry('Tags are invalid.');
  const tags = value.map((tag) => text(tag, 'tag', 128, invalidEntry));
  if (new Set(tags).size !== tags.length) throw invalidEntry('Tags must be unique.');
  return Object.freeze([...tags].sort(ordinal));
}

function normalizeMetadata(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidEntry('Metadata is invalid.');
  const state = { nodes: 0, bytes: 0 };
  const cloned = cloneJson(value, state, 0);
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) throw invalidEntry('Metadata is invalid.');
  return cloned as Readonly<Record<string, unknown>>;
}

function cloneJson(value: unknown, state: { nodes: number; bytes: number }, depth: number): unknown {
  if (++state.nodes > MAX_METADATA_NODES || depth > MAX_METADATA_DEPTH) {
    throw invalidEntry('Metadata exceeds bounds.');
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > MAX_METADATA_VALUE_LENGTH) throw invalidEntry('Metadata value is too long.');
    state.bytes += value.length * 2;
    if (state.bytes > MAX_METADATA_BYTES) throw invalidEntry('Metadata exceeds byte bounds.');
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > MAX_METADATA_COLLECTION) throw invalidEntry('Metadata collection is too large.');
    const result = value.map((item) => cloneJson(item, state, depth + 1));
    return Object.freeze(result);
  }
  if (typeof value === 'object') {
    const keys = ownDataKeys(value);
    if (keys.length > MAX_METADATA_COLLECTION) throw invalidEntry('Metadata collection is too large.');
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (key.length > 256) throw invalidEntry('Metadata key is too long.');
      state.bytes += key.length * 2;
      result[key] = cloneJson(readOwnData(value, key, true), state, depth + 1);
    }
    return Object.freeze(result);
  }
  throw invalidEntry('Metadata contains a non-JSON value.');
}

function normalizeSearch(request: RuntimeExtensionCatalogSearchRequest) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Search request must be an object.');
  }
  const query = request.query === undefined ? '' : text(request.query, 'search query', 2_048);
  const terms = Object.freeze([...new Set(fold(query).split(/\s+/).filter(Boolean))]);
  let origins: ReadonlySet<RuntimeExtensionCatalogOrigin> | undefined;
  if (request.origins !== undefined) {
    if (!Array.isArray(request.origins) || request.origins.length > 3
      || request.origins.some((origin) => !isOrigin(origin))) throw new TypeError('Origins are invalid.');
    origins = new Set(request.origins);
  }
  const tags = request.tags === undefined ? undefined : normalizeTags(request.tags)?.map((tag) => fold(tag));
  if (request.installation !== undefined && !isInstallationFilter(request.installation)) {
    throw new TypeError('Installation filter is invalid.');
  }
  const limit = request.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    throw new TypeError('Search limit must be between 1 and 1000.');
  }
  return { query, terms, origins, tags, installation: request.installation, limit };
}

function matchesFilters(entry: RuntimeExtensionCatalogEntry, request: ReturnType<typeof normalizeSearch>) {
  if (request.origins && !request.origins.has(entry.origin)) return false;
  if (request.tags && request.tags.some((tag) => !(entry.tags ?? []).some((item) => fold(item) === tag))) return false;
  if (request.installation === 'not-installed') return entry.installation === undefined;
  return request.installation === undefined || entry.installation?.status === request.installation;
}

function matchEntry(entry: RuntimeExtensionCatalogEntry, terms: readonly string[]): RuntimeExtensionCatalogSearchMatch | undefined {
  if (!terms.length) return Object.freeze({ entry, score: 0, matchedTerms: Object.freeze([]), matchedFields: Object.freeze([]) });
  const fields: readonly [RuntimeExtensionCatalogSearchField, readonly string[], number][] = [
    ['id', [entry.id], 8], ['identity', [entry.identity], 8],
    ['origin', [entry.origin, entry.originLabel], 5], ['source', [entry.sourceId, entry.sourceLabel], 4],
    ['title', [entry.title], 7], ['description', [entry.description], 2],
    ['publisher', entry.publisher ? [entry.publisher] : [], 3], ['tags', entry.tags ?? [], 5],
  ];
  const matchedFields = new Set<RuntimeExtensionCatalogSearchField>();
  let score = 0;
  for (const term of terms) {
    let matched = false;
    for (const [field, values, weight] of fields) {
      const normalized = values.map(fold);
      if (!normalized.some((value) => value.includes(term))) continue;
      matched = true; matchedFields.add(field); score += weight;
      if (normalized.some((value) => value === term)) score += weight;
    }
    if (!matched) return undefined;
  }
  return Object.freeze({
    entry, score, matchedTerms: Object.freeze([...terms]),
    matchedFields: Object.freeze([...matchedFields]),
  });
}

function sameCandidate(a: RuntimeExtensionCatalogEntry, b: RuntimeExtensionCatalogEntry): boolean {
  return a.id === b.id && a.identity === b.identity && a.version === b.version
    && a.origin === b.origin && a.request.packageRoot === b.request.packageRoot
    && a.request.integrity.value === b.request.integrity.value && a.sourceId === b.sourceId;
}

function sameCatalogCandidate(a: RuntimeExtensionCatalogEntry, b: RuntimeExtensionCatalogEntry): boolean {
  return a.identity === b.identity && a.version === b.version
    && a.request.integrity.algorithm === b.request.integrity.algorithm
    && a.request.integrity.domain === b.request.integrity.domain
    && a.request.integrity.value === b.request.integrity.value
    && canonicalRootKey(a.request.packageRoot) === canonicalRootKey(b.request.packageRoot);
}

function canonicalRootKey(root: string): string {
  const normalized = resolve(root).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function compareSources(a: NormalizedSource, b: NormalizedSource) { return a.order - b.order || ordinal(a.id, b.id); }
function compareEntries(a: RuntimeExtensionCatalogEntry, b: RuntimeExtensionCatalogEntry) {
  return a.sourceOrder - b.sourceOrder || ordinal(a.sourceId, b.sourceId)
    || a.order - b.order || ordinal(a.identity, b.identity)
    || ordinal(a.version, b.version) || ordinal(a.id, b.id);
}
function orderValue(value: number | undefined, factory: (detail: string) => Error): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < -1_000_000 || value > 1_000_000) {
    throw factory('Order is invalid.');
  }
  return value;
}
function text(value: unknown, label: string, max: number, factory: (detail: string) => Error = (detail) => new TypeError(detail)): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value !== value.normalize('NFC') || value.length > max) {
    throw factory(`Catalog ${label} is invalid.`);
  }

  return value;
}

function fold(value: string): string { return value.toLowerCase(); }
function ordinal(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = a.charCodeAt(index) - b.charCodeAt(index);
    if (difference) return difference;
  }
  return a.length - b.length;
}

function readOwnData(value: object, key: string, required: boolean): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !('value' in descriptor)) {
    if (required) throw invalidEntry(`Catalog property "${key}" is invalid.`);
    return undefined;
  }
  return descriptor.value;
}

function ownDataKeys(value: object): string[] {
  const keys = Object.getOwnPropertyNames(value);
  for (const key of keys) readOwnData(value, key, true);
  return keys;
}

function captureCandidate(
  entry: RuntimeExtensionCatalogSourceEntry,
  source: NormalizedSource,
): CapturedCandidate {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalidEntry('Entry must be an object.');
  const captured = {
    id: readOwnData(entry, 'id', true),
    identity: readOwnData(entry, 'identity', true),
    version: readOwnData(entry, 'version', true),
    origin: readOwnData(entry, 'origin', true),
    title: readOwnData(entry, 'title', true),
    description: readOwnData(entry, 'description', true),
    tags: detachValue(readOwnData(entry, 'tags', false)),
    publisher: readOwnData(entry, 'publisher', false),
    metadata: detachValue(readOwnData(entry, 'metadata', false)),
    order: readOwnData(entry, 'order', false),
    request: detachValue(readOwnData(entry, 'request', true)),
  };
  return { source, entry: Object.freeze(captured as RuntimeExtensionCatalogSourceEntry) };
}

function snapshotContext(context: InvocationContext): InvocationContext {
  const principal = readContextRecord<InvocationContext['principal']>(context, 'principal', true);
  const identity = readContextRecord<NonNullable<InvocationContext['identity']>>(context, 'identity', false);
  const scope = readContextRecord<NonNullable<InvocationContext['scope']>>(context, 'scope', false);
  const lineage = readContextRecord<NonNullable<InvocationContext['lineage']>>(context, 'lineage', false);
  const approval = readContextRecord<NonNullable<InvocationContext['approval']>>(context, 'approval', false);
  const metadata = readContextRecord<NonNullable<InvocationContext['metadata']>>(context, 'metadata', false);
  const executionId = readOwnData(context, 'executionId', false);
  const signal = readOwnData(context, 'signal', false);
  const receiptCorrelationContext =
    readOwnData(context, 'receiptCorrelationContext', false) as InvocationContext['receiptCorrelationContext'];
  return Object.freeze({
    principal: detachRecord(principal!),
    ...(identity ? { identity: detachRecord(identity) } : {}),
    ...(scope ? { scope: detachRecord(scope) } : {}),
    ...(typeof executionId === 'string' ? { executionId } : {}),
    ...(lineage ? { lineage: detachRecord(lineage) } : {}),
    signal: signal as InvocationContext['signal'],
    ...(approval ? { approval: detachRecord(approval) } : {}),
    ...(receiptCorrelationContext !== undefined
      ? {
        receiptCorrelationContext: (
          detachValue(receiptCorrelationContext) as InvocationContext['receiptCorrelationContext']
        ),
      } : {}),
    ...(metadata ? { metadata: detachRecord(metadata) } : {}),
  });
}

function readContextRecord<T extends object>(context: InvocationContext, key: string, required: boolean): T | undefined {
  const value = readOwnData(context, key, required);
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Invocation context ${key} is invalid.`);
  }
  return value as T;
}

function detachRecord<T extends object>(value: T): Readonly<T> {
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of ownDataKeys(value)) result[key] = detachValue(readOwnData(value, key, true));
  return Object.freeze(result) as Readonly<T>;
}

function detachValue<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(detachValue)) as T;
  return detachRecord(value) as T;
}

type DetachedRuntimeExtensionLifecycleRecord = Omit<RuntimeExtensionLifecycleRecord, 'request'> & {
  readonly request?: RuntimeExtensionLifecycleRecord['request'];
};

function detachedRecord(record: RuntimeExtensionLifecycleRecord): DetachedRuntimeExtensionLifecycleRecord {
  const requestValue = readOwnData(record, 'request', false);
  const request = requestValue === undefined ? undefined : normalizeRequest(requestValue);
  return Object.freeze({
    identity: record.identity,
    version: record.version,
    integrity: Object.freeze({
      algorithm: record.integrity.algorithm,
      domain: record.integrity.domain,
      value: record.integrity.value,
    }),
    entrypoint: record.entrypoint,
    status: record.status,
    activationOrder: record.activationOrder,
    configuration: detachRecord(record.configuration),
    ...(request !== undefined ? { request: detachValue(request) } : {}),
    ...(record.origin !== undefined ? { origin: record.origin } : {}),
    ...(record.title !== undefined ? { title: record.title } : {}),
    ...(record.description !== undefined ? { description: record.description } : {}),
    ...(record.tags !== undefined ? { tags: detachValue(record.tags) } : {}),
    ...(record.publisher !== undefined ? { publisher: record.publisher } : {}),
    ...(record.metadata !== undefined ? { metadata: detachValue(record.metadata) } : {}),
    health: record.health,
    blockReasons: detachValue(record.blockReasons),
    dependencies: detachValue(record.dependencies),
    providedServices: detachValue(record.providedServices),
    requiredServices: detachValue(record.requiredServices),
    providerSelections: detachValue(record.providerSelections),
    contractConflicts: detachValue(record.contractConflicts),
    contracts: detachValue(record.contracts),
    configurationSchema: detachValue(record.configurationSchema),
    configurationValues: detachRecord(record.configurationValues),
    docs: detachValue(record.docs),
    resources: detachValue(record.resources),
    examples: detachValue(record.examples),
    appServices: detachValue(record.appServices),
    appServicesSnippet: record.appServicesSnippet,
    providerOverrides: detachRecord(record.providerOverrides),
    capabilityProviderIds: detachValue(record.capabilityProviderIds),
  });
}

function effectiveOptions(
  context: InvocationContext,
  options: RuntimeExtensionOperationOptions,
): RuntimeExtensionOperationOptions {
  return { ...options, signal: options.signal ?? context.signal };
}

function assertContext(context: InvocationContext): void {
  if (!context || typeof context !== 'object') throw new TypeError('Invocation context is required.');
}
function assertNotCancelled(signal: RuntimeAbortSignal | undefined): void {
  if (signal?.aborted) throw new RuntimeExtensionCatalogError('CANCELLED');
}
function isOrigin(value: unknown): value is RuntimeExtensionCatalogOrigin {
  return value === 'native' || value === 'dsh' || value === 'authored-typescript';
}
function isInstallationFilter(value: unknown): value is RuntimeExtensionCatalogInstallationFilter {
  return value === 'enabled' || value === 'disabled' || value === 'not-installed';
}
function invalidSource(detail: string) { return new RuntimeExtensionCatalogError('INVALID_SOURCE', new TypeError(detail)); }
function invalidEntry(detail: string) { return new RuntimeExtensionCatalogError('INVALID_ENTRY', new TypeError(detail)); }
