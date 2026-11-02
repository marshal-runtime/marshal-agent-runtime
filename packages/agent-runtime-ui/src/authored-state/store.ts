import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { InvocationContext } from '@marshal/agent-runtime-core';
import { validateUiApplicationManifest } from '../applicationManifest.js';
import { assertContained, ensureContainedDirectory, readContainedFileStable } from '../pathSafety.js';
import { digest, stableStringify, stateScopeKey } from '../store.js';
import type {
  RuntimeAuthoredUiStateService, UiApplicationCreationRequest, UiApplicationIdentity,
  UiApplicationMetadata, UiApplicationOwner, UiApplicationScope, UiApplicationSnapshot,
  UiApplicationSourceProvenance, UiApplicationSummary, UiApplicationUpdateRequest,
} from './contracts.js';
import type { JsonObject } from '../types.js';

const MAX_ID = 256;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_RECORDS = 10_000;
const MAX_TAGS = 64;
const MAX_TAG_BYTES = 256;
const HEX64 = /^[a-f0-9]{64}$/;
const LEGACY_IDENTITY_KEYS = new Set([
  'id',
  'componentId',
  'renderId',
  'componentDigest',
  'renderDigest',
]);
const locks = new Map<string, Promise<void>>();
type InternalState = 'active' | 'tombstoned';

export interface ReactUiAuthoredStateStoreOptions {
  storageRoot: string;
  maxRecordsPerScope?: number;
  maxJsonBytes?: number;
}
interface HeadRecord {
  schemaVersion: 2; id: string; scopeKey: string; owner: UiApplicationOwner;
  tombstoned: boolean; version: number; snapshotDigest: string;
  createdAt: string; updatedAt: string;
}

export class ReactUiAuthoredStateStore implements RuntimeAuthoredUiStateService {
  private readonly root: string;
  private readonly maxRecords: number;
  private readonly maxJsonBytes: number;
  constructor(options: ReactUiAuthoredStateStoreOptions) {
    this.root = resolve(options.storageRoot);
    this.maxRecords = bounded(options.maxRecordsPerScope ?? MAX_RECORDS, 1, MAX_RECORDS, 'maxRecordsPerScope');
    this.maxJsonBytes = bounded(options.maxJsonBytes ?? MAX_JSON_BYTES, 1_024, MAX_JSON_BYTES, 'maxJsonBytes');
  }

  async create(request: UiApplicationCreationRequest, context: InvocationContext): Promise<UiApplicationSnapshot> {
    const normalized = normalizeCreation(request, this.maxJsonBytes);
    const owner = ownerFromContext(context, normalized.scope);
    const id = normalized.identity?.id ?? digest(`${owner.principalId}\0${stableStringify(normalized)}`);
    assertId(id, 'application id');
    const scopeDir = await this.scopeDirectory(context, normalized.scope);
    return this.mutate(join(scopeDir, id), async () => {
      const current = await this.readHead(scopeDir, id);
      if (current && !current.tombstoned) throw new Error(`Authored UI application ${id} already exists`);
      if (!current && (await this.ids(scopeDir)).length >= this.maxRecords) throw new Error('Authored UI application scope limit reached');
      const now = new Date().toISOString();
      const snapshot = this.makeSnapshot(id, owner, normalized, 1, now, now);
      await this.publish(scopeDir, snapshot, false);
      return clone(snapshot);
    });
  }
  async migrate(request: UiApplicationCreationRequest, context: InvocationContext): Promise<UiApplicationSnapshot> {
    return this.create(request, context);
  }
  async read(id: string, context: InvocationContext): Promise<UiApplicationSnapshot | undefined> {
    assertId(id, 'application id');
    const found = await this.findHead(id, context);
    return found && !found.head.tombstoned ? clone(await this.readSnapshotFile(found.scopeDir, found.head.snapshotDigest)) : undefined;
  }
  async list(context: InvocationContext): Promise<readonly UiApplicationSummary[]> {
    const result: UiApplicationSummary[] = [];
    for (const scope of ['session', 'project', 'workspace'] as const) {
      const dir = await this.scopeDirectory(context, scope);
      for (const id of await this.ids(dir)) {
        const head = await this.readHead(dir, id);
        if (!head || head.tombstoned || head.scopeKey !== stateScopeKey(context, scope)) continue;
        const snap = await this.readSnapshotFile(dir, head.snapshotDigest);
        result.push({ identity: snap.identity, owner: clone(head.owner), ...(snap.title ? { title: snap.title } : {}),
          ...(snap.description ? { description: snap.description } : {}), tags: clone(snap.tags), metadata: clone(snap.metadata),
          version: head.version, snapshotDigest: head.snapshotDigest, createdAt: head.createdAt, updatedAt: head.updatedAt });
      }
    }
    return result.sort((a, b) => a.identity.id.localeCompare(b.identity.id));
  }
  async update(id: string, request: UiApplicationUpdateRequest, context: InvocationContext): Promise<UiApplicationSnapshot> {
    assertId(id, 'application id');
    return this.mutateForId(id, context, async (dir, head, current) => {
      assertVersion(head, request.expectedVersion);
      const hasRevision = request.application !== undefined || request.props !== undefined || request.provenance !== undefined;
      if (hasRevision && (!request.application || !request.props || !request.provenance)) throw new Error('Revision updates must include application, props, and provenance');
      const hasPresentationUpdate = request.title !== undefined || request.description !== undefined || request.tags !== undefined || request.metadata !== undefined;
      if (hasRevision && hasPresentationUpdate) throw new Error('Revision updates cannot include title, description, tags, or metadata');
      if (!hasRevision && !hasPresentationUpdate) throw new Error('Update must change metadata or provide a complete revision');
      const next = { ...current, version: head.version + 1, updatedAt: new Date().toISOString(), snapshotDigest: '' } as { -readonly [K in keyof UiApplicationSnapshot]: UiApplicationSnapshot[K] };
      if (request.title !== undefined) request.title === null ? delete next.title : next.title = boundedText(request.title, 'title');
      if (request.description !== undefined) request.description === null ? delete next.description : next.description = boundedText(request.description, 'description');
      if (request.tags !== undefined) next.tags = request.tags === null ? [] : normalizeTags(request.tags);
      if (request.metadata !== undefined) next.metadata = request.metadata === null ? {} : normalizeJson(request.metadata, this.maxJsonBytes, 'metadata');
      if (hasRevision) {
        next.application = validateUiApplicationManifest(request.application);
        next.props = normalizeJson(request.props!, this.maxJsonBytes, 'props');
        next.provenance = normalizeProvenance(request.provenance!);
      }
      next.snapshotDigest = snapshotDigest(next);
      await this.publish(dir, next, false);
      return clone(next);
    });
  }
  async changeState(id: string, state: JsonObject, expectedVersion: number, context: InvocationContext): Promise<UiApplicationSnapshot> {
    assertId(id, 'application id');
    return this.mutateForId(id, context, async (dir, head, current) => {
      assertVersion(head, expectedVersion);
      const next = { ...current, state: normalizeJson(state, this.maxJsonBytes, 'state'), version: head.version + 1,
        updatedAt: new Date().toISOString(), snapshotDigest: '' } as { -readonly [K in keyof UiApplicationSnapshot]: UiApplicationSnapshot[K] };
      next.snapshotDigest = snapshotDigest(next);
      await this.publish(dir, next, false);
      return clone(next);
    });
  }
  async remove(id: string, expectedVersion: number, context: InvocationContext): Promise<boolean> {
    assertId(id, 'application id');
    return this.mutateForId(id, context, async (dir, head) => {
      assertVersion(head, expectedVersion);
      const next = { ...head, tombstoned: true, version: head.version + 1, updatedAt: new Date().toISOString() };
      await this.atomicJson(join(dir, 'heads', `${id}.json`), next);
      return true;
    });
  }
  async readSnapshot(id: string, snapshotDigestValue: string, context: InvocationContext): Promise<UiApplicationSnapshot | undefined> {
    assertId(id, 'application id'); assertDigest(snapshotDigestValue, 'snapshot digest');
    const found = await this.findHead(id, context);
    if (!found) return undefined;
    try {
      const snapshot = await this.readSnapshotFile(found.scopeDir, snapshotDigestValue);
      return snapshot.identity.id === id ? clone(snapshot) : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  private async mutateForId<T>(id: string, context: InvocationContext, op: (dir: string, head: HeadRecord, current: UiApplicationSnapshot) => Promise<T>): Promise<T> {
    const found = await this.findHead(id, context);
    if (!found || found.head.tombstoned) throw new Error(`Authored UI application ${id} was not found in this scope`);
    return this.mutate(join(found.scopeDir, id), async () => {
      const head = await this.readHead(found.scopeDir, id);
      if (!head || head.tombstoned || head.scopeKey !== found.head.scopeKey) {
        throw new Error(`Authored UI application ${id} was not found in this scope`);
      }
      return op(
        found.scopeDir,
        head,
        await this.readSnapshotFile(found.scopeDir, head.snapshotDigest),
      );
    });
  }
  private async findHead(id: string, context: InvocationContext): Promise<{scopeDir: string; head: HeadRecord} | undefined> {
    for (const scope of ['session', 'project', 'workspace'] as const) {
      const dir = await this.scopeDirectory(context, scope); const head = await this.readHead(dir, id);
      if (head?.scopeKey === stateScopeKey(context, scope)) return { scopeDir: dir, head };
    }
    return undefined;
  }
  private async scopeDirectory(context: InvocationContext, scope: UiApplicationScope): Promise<string> {
    await mkdir(this.root, { recursive: true }); const dir = join(this.root, 'scopes', stateScopeKey(context, scope));
    await ensureContainedDirectory(this.root, dir, 'authored UI state scope'); return dir;
  }
  private async publish(dir: string, snapshot: UiApplicationSnapshot, tombstoned: boolean): Promise<void> {
    const head: HeadRecord = { schemaVersion: 2, id: snapshot.identity.id, scopeKey: stateScopeKeyFromOwner(snapshot.owner),
      owner: snapshot.owner, tombstoned, version: snapshot.version, snapshotDigest: snapshot.snapshotDigest,
      createdAt: snapshot.createdAt, updatedAt: snapshot.updatedAt };
    const snapshots = join(dir, 'snapshots', snapshot.identity.id);
    await ensureContainedDirectory(this.root, snapshots, 'authored UI snapshots');
    await this.atomicJson(join(snapshots, `${snapshot.snapshotDigest}.json`), snapshot);
    await this.atomicJson(join(dir, 'heads', `${snapshot.identity.id}.json`), head);
  }
  private async readHead(dir: string, id: string): Promise<HeadRecord | undefined> {
    try {
      const content = await readContainedFileStable(
        this.root,
        join(dir, 'heads', `${id}.json`),
        'authored UI head',
        this.maxJsonBytes,
      );
      if (content === undefined) return undefined;
      const value = JSON.parse(content) as HeadRecord;
      if (value.schemaVersion !== 2 || value.id !== id || !HEX64.test(value.snapshotDigest) || !Number.isSafeInteger(value.version)) throw new Error('Invalid authored UI head');
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  private async readSnapshotFile(dir: string, wanted: string): Promise<UiApplicationSnapshot> {
    const ids = await this.safeDirectoryEntries(join(dir, 'snapshots'), 'authored UI snapshots');
    let path: string | undefined;
    for (const id of ids) {
      const candidate = join(dir, 'snapshots', id, `${wanted}.json`);
      if (await readContainedFileStable(this.root, candidate, 'authored UI snapshot', this.maxJsonBytes) !== undefined) {
        path = candidate;
        break;
      }
    }
    if (!path) throw Object.assign(new Error('Snapshot not found'), { code: 'ENOENT' });
    const content = await readContainedFileStable(this.root, path, 'authored UI snapshot', this.maxJsonBytes);
    if (content === undefined) throw Object.assign(new Error('Snapshot not found'), { code: 'ENOENT' });
    const raw = JSON.parse(content) as UiApplicationSnapshot;
    const legacyIdentity = hasLegacyIdentity(raw.identity);
    const value = normalizeSnapshot(raw, this.maxJsonBytes);
    const validDigest = snapshotDigest(value) === wanted
      || (legacyIdentity && snapshotDigest(raw) === wanted);
    if (value.snapshotDigest !== wanted || !validDigest) {
      throw new Error('Authored UI snapshot digest mismatch');
    }
    return value;
  }
  private async atomicJson(path: string, value: unknown): Promise<void> {
    assertContained(this.root, path, 'authored UI state file');
    await ensureContainedDirectory(this.root, dirname(path), 'authored UI state file');
    const data = JSON.stringify(value); if (Buffer.byteLength(data) > this.maxJsonBytes) throw new Error('Authored UI state record exceeds size limit');
    const temp = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      const existing = await lstat(path);
      if (existing.isSymbolicLink() || isReparsePoint(existing)) {
        throw new Error('Authored UI state target may not be a symbolic link or reparse point');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    }
    await rename(temp, path);
  }
  private async mutate<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve(); let release!: () => void;
    const current = new Promise<void>((resolveRelease) => { release = resolveRelease; }); const queued = previous.then(() => current); locks.set(key, queued); await previous;
    const lockPath = `${key}.lock`; let acquired = false;
    try { for (let i = 0; i < 2000; i++) { try { await mkdir(lockPath); acquired = true; break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await new Promise((r) => setTimeout(r, 5)); } }
      if (!acquired) throw new Error('Authored UI mutation lock timed out'); return await operation();
    } finally { if (acquired) await rm(lockPath, { recursive: true, force: true }); release(); if (locks.get(key) === queued) locks.delete(key); }
  }
  private async ids(dir: string): Promise<string[]> {
    try {
      const entries = await this.safeDirectoryEntries(join(dir, 'heads'), 'authored UI heads');
      const ids = entries.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5));
      if (ids.length > this.maxRecords) throw new Error('Authored UI application scope limit exceeded');
      return ids;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  private async safeDirectoryEntries(directory: string, field: string): Promise<string[]> {
    await ensureContainedDirectory(this.root, directory, field);
    const entries = await readdir(directory);
    if (entries.length > this.maxRecords) throw new Error(`${field} exceeds the record limit`);
    for (const entry of entries) {
      const info = await lstat(join(directory, entry));
      if (info.isSymbolicLink() || isReparsePoint(info)) {
        throw new Error(`${field} contains a symbolic link or reparse point`);
      }
    }
    return entries;
  }
  private makeSnapshot(id: string, owner: UiApplicationOwner, request: NormalizedCreation, version: number, createdAt: string, updatedAt: string): UiApplicationSnapshot {
    const identity: UiApplicationIdentity = { id };
    const snapshot: UiApplicationSnapshot = { identity, owner, ...(request.title ? { title: request.title } : {}),
      ...(request.description ? { description: request.description } : {}), tags: request.tags, metadata: request.metadata,
      application: request.application, props: request.props, provenance: request.provenance, state: request.initialState,
      version, createdAt, updatedAt, snapshotDigest: '' };
    const withDigest = { ...snapshot, snapshotDigest: snapshotDigest(snapshot) };
    return withDigest;
  }
}
type NormalizedCreation = { identity?: Partial<UiApplicationIdentity>; title?: string; description?: string; tags: readonly string[]; metadata: UiApplicationMetadata; scope: UiApplicationScope; application: ReturnType<typeof validateUiApplicationManifest>; props: JsonObject; provenance: UiApplicationSourceProvenance; initialState: JsonObject };
function normalizeCreation(request: UiApplicationCreationRequest, max: number): NormalizedCreation {
  const application = validateUiApplicationManifest(request.application); const scope = application.localState?.scope ?? 'project';
  return { ...(request.identity ? { identity: normalizeIdentity(request.identity) } : {}), ...(request.title ? { title: boundedText(request.title, 'title') } : {}),
    ...(request.description ? { description: boundedText(request.description, 'description') } : {}), tags: request.tags ? normalizeTags(request.tags) : [],
    metadata: request.metadata ? normalizeJson(request.metadata, max, 'metadata') : {}, scope, application, props: normalizeJson(request.props ?? {}, max, 'props'),
    provenance: normalizeProvenance(request.provenance), initialState: normalizeJson(request.initialState ?? {}, max, 'state') };
}
function normalizeSnapshot(value: UiApplicationSnapshot, max: number): UiApplicationSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Invalid authored UI snapshot');
  const identity = normalizePersistedIdentity(value.identity);
  return { ...value, owner: normalizeOwner(value.owner), identity,
    ...(value.title === undefined ? {} : { title: boundedText(value.title, 'title') }),
    ...(value.description === undefined ? {} : { description: boundedText(value.description, 'description') }),
    tags: normalizeTags(value.tags), metadata: normalizeJson(value.metadata, max, 'metadata'), application: validateUiApplicationManifest(value.application),
    props: normalizeJson(value.props, max, 'props'), provenance: normalizeProvenance(value.provenance), state: normalizeJson(value.state, max, 'state') };
}
function normalizePersistedIdentity(value: UiApplicationIdentity): UiApplicationIdentity {
  if (!value || typeof value !== 'object' || Object.keys(value).some((key) => !LEGACY_IDENTITY_KEYS.has(key))) {
    throw new Error('identity may contain only id or legacy revision fields');
  }
  assertId(value.id, 'identity.id');
  for (const key of ['componentId', 'renderId', 'componentDigest', 'renderDigest'] as const) {
    const legacyValue = (value as UiApplicationIdentity & Partial<Record<typeof key, string>>)[key];
    if (legacyValue !== undefined) assertDigest(legacyValue, `identity.${key}`);
  }
  return { id: value.id };
}
function hasLegacyIdentity(value: UiApplicationIdentity): boolean {
  return !!value && typeof value === 'object'
    && Object.keys(value).some((key) => key !== 'id');
}
function normalizeIdentity(value: Partial<UiApplicationIdentity>): UiApplicationIdentity {
  if (!value || typeof value !== 'object' || Object.keys(value).some((key) => key !== 'id')) {
    throw new Error('identity may contain only id');
  }
  if (value.id !== undefined) assertId(value.id, 'identity.id');
  return { ...(value.id === undefined ? {} : { id: value.id }) } as UiApplicationIdentity;
}
function normalizeProvenance(value: UiApplicationSourceProvenance): UiApplicationSourceProvenance { if (!value || typeof value !== 'object' || !['workspace_file', 'registered_component', 'authored_typescript', 'snapshot'].includes(value.kind)) throw new Error('Invalid authored UI provenance'); assertDigest(value.sourceDigest, 'provenance.sourceDigest'); assertDigest(value.componentId, 'provenance.componentId'); assertDigest(value.renderId, 'provenance.renderId'); assertDigest(value.componentDigest, 'provenance.componentDigest'); assertDigest(value.renderDigest, 'provenance.renderDigest'); if (value.path !== undefined) boundedText(value.path, 'provenance.path'); return clone(value); }
function normalizeOwner(value: UiApplicationOwner): UiApplicationOwner { if (!value || typeof value.principalId !== 'string' || !['workspace', 'project', 'session'].includes(value.scope) || typeof value.scopeId !== 'string' || !value.scopeId) throw new Error('Invalid authored UI owner'); assertId(value.principalId, 'owner.principalId'); assertId(value.scopeId, 'owner.scopeId'); return clone(value); }
function normalizeJson(value: JsonObject, max: number, label: string): JsonObject { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`); const copy = clone(value); if (Buffer.byteLength(JSON.stringify(copy)) > max) throw new Error(`${label} exceeds size limit`); return copy; }
function normalizeTags(value: readonly string[]): readonly string[] { if (!Array.isArray(value) || value.length > MAX_TAGS) throw new Error('tags are out of bounds'); const tags = value.map((tag) => boundedText(tag, 'tag')); if (Buffer.byteLength(JSON.stringify(tags)) > MAX_TAG_BYTES) throw new Error('tags exceed size limit'); return [...new Set(tags)]; }
function ownerFromContext(context: InvocationContext, scope: UiApplicationScope): UiApplicationOwner {
  const source = context.scope ?? {};
  const hasScope = scope === 'workspace' ? source.workspaceId ?? source.workspacePath
    : scope === 'project' ? source.projectId && (source.workspaceId ?? source.workspacePath)
      : source.sessionId && (source.projectId ?? source.workspaceId ?? source.workspacePath);
  if (!hasScope) throw new Error(`Missing ${scope} scope in invocation context`);
  return normalizeOwner({ principalId: context.principal.id, scope, scopeId: stateScopeKey(context, scope) });
}
function stateScopeKeyFromOwner(owner: UiApplicationOwner): string { return owner.scopeId; }
function snapshotDigest(value: UiApplicationSnapshot): string { const { snapshotDigest: _ignored, ...content } = value; return digest(stableStringify(content)); }
function assertVersion(head: HeadRecord, expected: number): void { if (!Number.isSafeInteger(expected) || expected !== head.version) throw new Error(`Authored UI version conflict: expected ${expected}, current ${head.version}`); }
function assertId(value: string, label: string): void { if (typeof value !== 'string' || !value || value.length > MAX_ID || !/^[A-Za-z0-9_.:-]+$/.test(value)) throw new Error(`${label} is invalid`); }
function assertDigest(value: string, label: string): void { if (typeof value !== 'string' || !HEX64.test(value)) throw new Error(`${label} must be a SHA-256 digest`); }
function boundedText(value: string, label: string): string { if (typeof value !== 'string' || !value.trim() || value.length > MAX_ID) throw new Error(`${label} is invalid`); return value; }
function bounded(value: number, min: number, max: number, label: string): number { if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} is out of bounds`); return value; }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function isReparsePoint(info: object): boolean {
  return Boolean((((info as { attributes?: number }).attributes ?? 0) & 0x400));
}
