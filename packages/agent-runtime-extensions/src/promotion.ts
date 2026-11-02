import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import type {
  CapabilityDescriptor,
  CapabilityInvocationResult,
  CapabilityProvider,
  InvocationContext,
  RuntimeAbortSignal,
} from '@marshal/agent-runtime-core';
import type {
  RuntimeResourceContent,
  RuntimeServiceAccessor,
} from '@marshal/agent-runtime-composer';
import {
  RUNTIME_AUTHORED_UI_STATE_SERVICE,
  stateScopeKey,
  type UiApplicationSnapshot,
} from '@marshal/agent-runtime-ui';
import {
  RUNTIME_EXTENSION_LIFECYCLE_SERVICE,
  RUNTIME_AUTHORED_UI_PROMOTION_SERVICE,
  type RuntimeAuthoredUiPromotionRequest,
  type RuntimeAuthoredUiPromotionResult,
  type RuntimeAuthoredUiPromotionService,
  type RuntimeExtensionCatalogSource,
  type RuntimeExtensionCatalogSourceEntry,
} from './services.js';
import { computeRuntimeExtensionIntegrity } from './loader.js';
import {
  RUNTIME_EXTENSION_MANIFEST_SCHEMA_VERSION,
  RUNTIME_EXTENSION_MODULE_FORMAT,
  type RuntimeExtensionInstallRequest,
  type RuntimeExtensionUiApplication,
} from './contracts.js';
import { requireRuntimeExtensionIdentity, requireRuntimeExtensionVersion } from './manifest.js';

const MAX_CONTENT = 4 * 1024 * 1024;
const MAX_SIDECAR = 32 * 1024;
const HEX64 = /^[a-f0-9]{64}$/;
const ENTRYPOINT = 'dist/index.cjs';
const SIDEcar = 'runtime-authored-ui.json';
const OPERATION = 'ui.authored.promote';
const MAX_URI = 4096;
const MAX_MIME = 256;
const MAX_CATALOG_DIRECTORIES = 4_096;
const MAX_PACKAGE_FILES = 4_096;
const MAX_PACKAGE_DIRECTORIES = 4_096;
const MAX_PACKAGE_DEPTH = 32;
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
const REQUEST_KEYS = [
  'applicationId',
  'snapshotDigest',
  'packageIdentity',
  'packageVersion',
  'catalogEntryId',
] as const;
const RESOURCE_KEYS = new Set(['uri', 'mimeType', 'text', 'blob']);
const SIDECAR_KEYS = new Set([
  'schemaVersion',
  'applicationId',
  'snapshotDigest',
  'packageIdentity',
  'packageVersion',
  'catalogEntryId',
  'owner',
  'resourceUri',
]);
const OWNER_KEYS = new Set(['principalId', 'scope', 'scopeId']);
const publicationStates = new Map<string, PublicationState>();

export interface RuntimeAuthoredUiPromotionResourceReader {
  read(snapshot: UiApplicationSnapshot, context: InvocationContext): Promise<RuntimeResourceContent>;
}

export interface RuntimeAuthoredUiPromotionOptions {
  readonly services: RuntimeServiceAccessor;
  readonly root: string;
  readonly resourceReader: RuntimeAuthoredUiPromotionResourceReader;
}

export interface RuntimeAuthoredUiPromotionBundle {
  readonly service: RuntimeAuthoredUiPromotionService;
  readonly provider: CapabilityProvider;
  readonly catalogSource: RuntimeExtensionCatalogSource;
  readonly dispose: () => Promise<void>;
}

interface Sidecar {
  readonly schemaVersion: 1;
  readonly applicationId: string;
  readonly snapshotDigest: string;
  readonly packageIdentity: string;
  readonly packageVersion: string;
  readonly catalogEntryId: string;
  readonly owner: UiApplicationSnapshot['owner'];
  readonly resourceUri: string;
}

interface PublicationState {
  users: number;
  created: boolean;
  retained: boolean;
}

interface PublicationLease {
  readonly packageRoot: string;
  readonly state: PublicationState;
  released: boolean;
}

interface MaterializedPromotion {
  readonly packageRoot: string;
  readonly publication: PublicationLease;
}

export class RuntimeAuthoredUiPromotionManager implements RuntimeAuthoredUiPromotionService {
  readonly catalogSource: RuntimeExtensionCatalogSource;
  private readonly services: RuntimeServiceAccessor;
  private readonly root: string;
  private readonly reader: RuntimeAuthoredUiPromotionResourceReader;

  constructor(options: RuntimeAuthoredUiPromotionOptions) {
    if (!options || typeof options !== 'object' || !options.services || !options.root || !options.resourceReader) {
      throw new TypeError('Authored UI promotion options are invalid.');
    }
    this.services = options.services;
    this.root = resolve(options.root);
    this.reader = options.resourceReader;
    this.catalogSource = Object.freeze({
      id: 'runtime.authored-ui-promotion',
      label: 'Authored UI promotions',
      order: 200,
      list: (context: InvocationContext, signal?: RuntimeAbortSignal) =>
        this.listCatalog(context, signal),
    });
  }

  async promote(
    request: RuntimeAuthoredUiPromotionRequest,
    context: InvocationContext,
    options: { readonly signal?: { readonly aborted: boolean } } = {},
  ): Promise<RuntimeAuthoredUiPromotionResult> {
    const input = validateRequest(request);
    const capturedContext = captureContext(context);
    validateContext(capturedContext);
    if (options.signal?.aborted || capturedContext.signal?.aborted) throw new Error('Promotion cancelled.');
    const state = this.services.get(RUNTIME_AUTHORED_UI_STATE_SERVICE);
    const snapshot = await state.readSnapshot(input.applicationId, input.snapshotDigest, capturedContext);
    if (!snapshot || snapshot.snapshotDigest !== input.snapshotDigest) throw new Error('Authored UI snapshot was not found.');
    if (snapshot.identity.id !== input.applicationId) throw new Error('Authored UI snapshot identity mismatch.');
    const detachedSnapshot = deepFreeze(structuredClone(snapshot));
    if (!ownerMatches(detachedSnapshot.owner, capturedContext)) {
      throw new Error('Authored UI snapshot is outside the invocation scope.');
    }
    const lifecycle = this.services.get(RUNTIME_EXTENSION_LIFECYCLE_SERVICE);
    const current = lifecycle.get(input.packageIdentity);
    if (current && !await ownsPromotion(this.root, current, capturedContext, input.applicationId)) {
      throw new Error('Cannot replace an extension not owned by this authored UI promotion.');
    }
    const content = validateContent(await this.reader.read(detachedSnapshot, capturedContext));
    assertNotCancelled(options.signal ?? capturedContext.signal);
    const materialized = await this.materialize(input, detachedSnapshot, content);
    let materializedIntegrity: string | undefined;
    try {
      await validatePackageTree(materialized.packageRoot);
      const installRequest: RuntimeExtensionInstallRequest = {
        packageRoot: materialized.packageRoot,
        integrity: computeRuntimeExtensionIntegrity(materialized.packageRoot),
      };
      materializedIntegrity = installRequest.integrity.value;
      if (current?.version === input.packageVersion &&
        current.integrity.value === installRequest.integrity.value) {
        await releasePublication(materialized.publication, true);
        return result(input, 'unchanged');
      }
      if (current) await lifecycle.update(input.packageIdentity, installRequest, { signal: options.signal ?? capturedContext.signal });
      else await lifecycle.install(installRequest, { signal: options.signal ?? capturedContext.signal });
      await releasePublication(materialized.publication, true);
      return result(input, current ? 'updated' : 'installed');
    } catch (error) {
      const adopted = materializedIntegrity !== undefined
        && lifecycle.get(input.packageIdentity)?.integrity.value === materializedIntegrity;
      try {
        await releasePublication(materialized.publication, adopted);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Authored UI promotion failed and package cleanup also failed.',
        );
      }
      throw error;
    }
  }

  private async listCatalog(
    context: InvocationContext,
    signal?: RuntimeAbortSignal,
  ): Promise<readonly RuntimeExtensionCatalogSourceEntry[]> {
    const capturedContext = captureContext(context);
    const effectiveSignal = signal ?? capturedContext.signal;
    assertNotCancelled(effectiveSignal);
    const lifecycle = this.services.get(RUNTIME_EXTENSION_LIFECYCLE_SERVICE);
    let names: string[] = [];
    try { names = await readdir(this.root); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (names.length > MAX_CATALOG_DIRECTORIES) {
      throw new Error('Authored UI promotion catalog exceeds its directory limit.');
    }
    const entries: RuntimeExtensionCatalogSourceEntry[] = [];
    for (const name of names.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      assertNotCancelled(effectiveSignal);
      if (!HEX64.test(name)) continue;
      const packageRoot = join(this.root, name);
      if (!await isSafeChild(this.root, packageRoot)) continue;
      try {
        if (!await validatePackageTree(packageRoot, true)) continue;
      } catch {
        continue;
      }
      const sidecar = await readSidecar(packageRoot);
      if (!sidecar || !ownerMatches(sidecar.owner, capturedContext)) continue;
      const active = lifecycle.get(sidecar.packageIdentity);
      if (!active || active.version !== sidecar.packageVersion) continue;
      let integrity: ReturnType<typeof computeRuntimeExtensionIntegrity>;
      try { integrity = computeRuntimeExtensionIntegrity(packageRoot); } catch { continue; }
      if (integrity.value !== name || active.integrity.value !== integrity.value) continue;
      entries.push({
        id: sidecar.catalogEntryId,
        identity: sidecar.packageIdentity,
        version: sidecar.packageVersion,
        origin: 'native',
        title: sidecar.packageIdentity,
        description: 'Authored UI promotion.',
        metadata: { provenance: { kind: 'authored-ui-promotion' }, applicationId: sidecar.applicationId, snapshotDigest: sidecar.snapshotDigest },
        request: { packageRoot, integrity },
      });
    }
    return entries;
  }

  private async materialize(
    input: RuntimeAuthoredUiPromotionRequest,
    snapshot: UiApplicationSnapshot,
    content: RuntimeResourceContent,
  ): Promise<MaterializedPromotion> {
    await mkdir(this.root, { recursive: true });
    await assertCanonicalRoot(this.root);
    const staging = join(this.root, `.${input.packageIdentity}.${Date.now()}.${Math.random().toString(16).slice(2)}`);
    await mkdir(join(staging, 'dist'), { recursive: true });
    let packageRoot = '';
    let created = false;
    try {
      const app: RuntimeExtensionUiApplication = {
        id: snapshot.identity.id,
        title: snapshot.title ?? snapshot.identity.id,
        description: snapshot.description ?? '',
        renderId: snapshot.provenance.renderId,
        resource: content,
        application: snapshot.application,
        tags: snapshot.tags,
        metadata: { ...snapshot.metadata, provenance: { kind: 'authored-ui-promotion' } },
      };
      await atomic(join(staging, 'package.json'), JSON.stringify({
        name: input.packageIdentity, version: input.packageVersion, private: true,
        type: 'commonjs', main: ENTRYPOINT, description: snapshot.description?.trim() || 'Authored UI promotion',
      }));
      await atomic(join(staging, 'runtime-extension.json'), JSON.stringify({
        schemaVersion: RUNTIME_EXTENSION_MANIFEST_SCHEMA_VERSION,
        identity: input.packageIdentity,
        version: input.packageVersion,
        entrypoint: ENTRYPOINT,
        moduleFormat: RUNTIME_EXTENSION_MODULE_FORMAT,
      }));
      const code = `module.exports={activate(){return {uiApplications:[${JSON.stringify(app)}]}}};`;
      await atomic(join(staging, ENTRYPOINT), code);
      await atomic(join(staging, SIDEcar), JSON.stringify({
        schemaVersion: 1, applicationId: input.applicationId, snapshotDigest: input.snapshotDigest,
        packageIdentity: input.packageIdentity, packageVersion: input.packageVersion,
        catalogEntryId: input.catalogEntryId, owner: snapshot.owner, resourceUri: content.uri,
      } satisfies Sidecar));
      await validatePackageTree(staging);
      const integrity = computeRuntimeExtensionIntegrity(staging);
      packageRoot = join(this.root, integrity.value);
      try {
        await rename(staging, packageRoot);
        created = true;
        await validatePackageTree(packageRoot);
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        if (!await exists(packageRoot)) throw error;
        await safeRemoveTree(staging);
        if (!await validPublishedPackage(
          packageRoot,
          input,
          snapshot.owner,
          content.uri,
          integrity.value,
        )) {
          throw new Error('Promotion package collision integrity mismatch.');
        }
      }
      return {
        packageRoot,
        publication: acquirePublication(packageRoot, created),
      }
    } catch (error) {
      if (created) await safeRemoveTree(packageRoot);
      await safeRemoveTree(staging);
      throw error;
    }
  }
}

export function createRuntimeAuthoredUiPromotionBundle(
  options: RuntimeAuthoredUiPromotionOptions,
): RuntimeAuthoredUiPromotionBundle {
  const service = new RuntimeAuthoredUiPromotionManager(options);
  const provider: CapabilityProvider = {
    id: 'runtime.authored-ui-promotion',
    version: '1.0.0',
    list: () => [descriptor()],
    get: (name) => name === OPERATION ? descriptor() : undefined,
    invoke: async (name, input, context): Promise<CapabilityInvocationResult> => {
      if (name !== OPERATION) throw new Error(`Unknown authored UI promotion capability: ${name}`);
      return { output: await service.promote(input as RuntimeAuthoredUiPromotionRequest, context) };
    },
  };
  return { service, provider, catalogSource: service.catalogSource, dispose: async () => {} };
}

function descriptor(): CapabilityDescriptor {
  const requestProperties = {
    applicationId: { type: 'string', minLength: 1, maxLength: 256 },
    snapshotDigest: {
      type: 'string',
      minLength: 64,
      maxLength: 64,
      pattern: '^[a-f0-9]{64}$',
    },
    packageIdentity: { type: 'string', minLength: 1, maxLength: 214 },
    packageVersion: { type: 'string', minLength: 1, maxLength: 96 },
    catalogEntryId: { type: 'string', minLength: 1, maxLength: 512 },
  };
  return {
    protocolVersion: '1.0.0', name: OPERATION, version: '1.0.0',
    title: 'Promote authored UI', description: 'Promote one immutable authored UI snapshot.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      required: REQUEST_KEYS,
      properties: requestProperties,
    },
    outputSchema: {
      type: 'object', additionalProperties: false,
      required: [...REQUEST_KEYS, 'action'],
      properties: {
        ...requestProperties,
        action: { type: 'string', enum: ['installed', 'updated', 'unchanged'] },
      },
    },
    permissions: [{ permission: 'runtime.authored-ui.promotion', reason: 'Installs or updates an authored UI extension.', scope: 'workspace/project/session', risk: 'high' }],
  };
}
function validateRequest(value: RuntimeAuthoredUiPromotionRequest): RuntimeAuthoredUiPromotionRequest {
  const record = strictDataRecord(value, new Set(REQUEST_KEYS), 'Promotion request');
  const applicationId = readRequiredString(record, 'applicationId');
  const snapshotDigest = readRequiredString(record, 'snapshotDigest');
  const packageIdentity = readRequiredString(record, 'packageIdentity');
  const packageVersion = readRequiredString(record, 'packageVersion');
  const catalogEntryId = readRequiredString(record, 'catalogEntryId');
  if (!HEX64.test(snapshotDigest)) throw new TypeError('snapshotDigest must be a SHA-256 digest.');
  if (applicationId.length > 256 || catalogEntryId.length > 512) throw new TypeError('Promotion request is invalid.');
  requireRuntimeExtensionIdentity(packageIdentity);
  requireRuntimeExtensionVersion(packageVersion);
  return Object.freeze({
    applicationId,
    snapshotDigest,
    packageIdentity,
    packageVersion,
    catalogEntryId,
  });
}
function validateContext(context: InvocationContext): void { if (!context?.principal?.id) throw new TypeError('Invocation context is invalid.'); }
function captureContext(context: InvocationContext): InvocationContext {
  validateContext(context);
  const captured = {
    principal: detachRecord(context.principal),
    ...(context.identity ? { identity: detachRecord(context.identity) } : {}),
    ...(context.scope ? { scope: detachRecord(context.scope) } : {}),
    ...(context.executionId ? { executionId: context.executionId } : {}),
    ...(context.lineage ? { lineage: detachRecord(context.lineage) } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
    ...(context.approval ? { approval: detachRecord(context.approval) } : {}),
    ...(context.receiptCorrelationContext
      ? { receiptCorrelationContext: context.receiptCorrelationContext }
      : {}),
    ...(context.metadata ? { metadata: detachRecord(context.metadata) } : {}),
  } satisfies InvocationContext;
  return Object.freeze(captured);
}
function validateContent(value: RuntimeResourceContent): RuntimeResourceContent {
  const record = strictDataRecord(value, RESOURCE_KEYS, 'Promotion resource content');
  const uri = readRequiredString(record, 'uri');
  const mimeType = readOptionalString(record, 'mimeType');
  const text = readOptionalString(record, 'text');
  const blob = readOptionalString(record, 'blob');
  if (uri.length > MAX_URI || (mimeType !== undefined && mimeType.length > MAX_MIME)
    || (text !== undefined && blob !== undefined)
    || (text === undefined && blob === undefined)) {
    throw new TypeError('Promotion resource content is invalid.');
  }
  if (blob !== undefined && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(blob)
    || Buffer.byteLength(blob, 'base64') > MAX_CONTENT)) throw new TypeError('Promotion resource blob is invalid.');
  if (text !== undefined && Buffer.byteLength(text) > MAX_CONTENT) throw new Error('Promotion resource content exceeds size limit.');
  return Object.freeze({
    uri,
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(text === undefined ? {} : { text }),
    ...(blob === undefined ? {} : { blob }),
  });
}
function result(input: RuntimeAuthoredUiPromotionRequest, action: RuntimeAuthoredUiPromotionResult['action']): RuntimeAuthoredUiPromotionResult { return { ...input, action }; }
async function atomic(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await assertNoFollowPath(dirname(path));
  const temp = `${path}.tmp`;
  await assertNoFollowEntry(path);
  await assertNoFollowEntry(temp);
  await writeFile(temp, value, 'utf8');
  await assertNoFollowFile(temp);
  await rename(temp, path);
}
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
function ownerMatches(owner: UiApplicationSnapshot['owner'], context: InvocationContext): boolean {
  if (owner.principalId !== context.principal.id) return false;
  const scope = context.scope ?? {};
  if (owner.scope === 'session' && !scope.sessionId) return false;
  if (owner.scope === 'project' && !scope.projectId) return false;
  if (owner.scope === 'workspace' && !(scope.workspaceId ?? scope.workspacePath)) return false;
  return owner.scopeId === stateScopeKey(context, owner.scope);
}

function assertNotCancelled(signal: { readonly aborted: boolean } | undefined): void {
  if (signal?.aborted) throw new Error('Promotion cancelled.');
}
async function assertCanonicalRoot(root: string): Promise<void> {
  const stat = await lstat(root);
  if (!stat.isDirectory() || await realpath(root) !== resolve(root)) throw new Error('Promotion root must be canonical and non-symlinked.');
}
async function isSafeChild(root: string, child: string): Promise<boolean> {
  try { return (await realpath(child)) === resolve(child) && (relative(root, child) === '' || !relative(root, child).startsWith(`..${sep}`)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function validatePackageTree(root: string, missingOk = false): Promise<boolean> {
  try {
    await assertNoFollowPath(root);
    let files = 0;
    let directories = 0;
    let bytes = 0;
    const visit = async (directory: string, depth: number): Promise<void> => {
      const directoryStat = await stableDirectory(directory);
      if (depth > MAX_PACKAGE_DEPTH) {
        throw new Error('Promotion package tree exceeds its depth limit.');
      }
      directories += 1;
      if (directories > MAX_PACKAGE_DIRECTORIES) {
        throw new Error('Promotion package tree exceeds its directory limit.');
      }
      for (const name of await readdir(directory)) {
        const child = join(directory, name);
        const stat = await lstat(child);
        if (stat.isSymbolicLink()) {
          throw new Error('Promotion path contains a link or reparse point.');
        } else if (stat.isDirectory()) {
          await visit(child, depth + 1);
        } else if (stat.isFile()) {
          const file = await stableFile(child);
          files += 1;
          bytes += file.size;
          if (files > MAX_PACKAGE_FILES || bytes > MAX_PACKAGE_BYTES) {
            throw new Error('Promotion package tree exceeds its inventory limit.');
          }
        } else {
          throw new Error('Promotion package tree contains an unsupported filesystem entry.');
        }
      }
      await stableDirectory(directory);
    };
    await visit(resolve(root), 0);
    return true;
  } catch (error) {
    if (missingOk && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function stableDirectory(path: string): Promise<import('node:fs').Stats> {
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink() || (await realpath(path)) !== resolve(path)) {
    throw new Error('Promotion path contains a link or reparse point.');
  }
  const after = await lstat(path);
  if (!after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino) {
    throw new Error('Promotion directory changed during validation.');
  }
  return after;
}

async function stableFile(path: string): Promise<import('node:fs').Stats> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || (await realpath(path)) !== resolve(path)) {
    throw new Error('Promotion path contains a link or reparse point.');
  }
  const handle = await open(path, 'r');
  try {
    const first = await handle.stat();
    const second = await handle.stat();
    if (!first.isFile() || !sameFileIdentity(before, first) || !sameFileSnapshot(first, second)) {
      throw new Error('Promotion file changed during validation.');
    }
    return second;
  } finally {
    await handle.close();
  }
}

function sameFileIdentity(left: import('node:fs').Stats, right: import('node:fs').Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left: import('node:fs').Stats, right: import('node:fs').Stats): boolean {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function assertNoFollowPath(path: string): Promise<void> {
  const resolved = resolve(path);
  const root = parse(resolved).root;
  let current = root;
  const remainder = relative(root, resolved);
  for (const component of remainder ? remainder.split(sep) : []) {
    current = join(current, component);
    await stableDirectory(current);
  }
}

async function assertNoFollowFile(path: string): Promise<void> {
  await stableFile(path);
}

async function assertNoFollowEntry(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isDirectory()) await stableDirectory(path);
    else await stableFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function safeRemoveTree(path: string): Promise<void> {
  if (!await validatePackageTree(path, true)) return;
  await assertNoFollowPath(path);
  await rm(path, { recursive: true, force: true });
}
async function validPublishedPackage(
  root: string,
  input: RuntimeAuthoredUiPromotionRequest,
  owner: UiApplicationSnapshot['owner'],
  resourceUri: string,
  expectedIntegrity: string,
): Promise<boolean> {
  if (!await isSafeChild(dirname(root), root)) return false;
  if (!await validatePackageTree(root, true)) return false;
  const sidecar = await readSidecar(root);
  if (!sidecar || sidecar.applicationId !== input.applicationId
    || sidecar.snapshotDigest !== input.snapshotDigest
    || sidecar.packageIdentity !== input.packageIdentity
    || sidecar.packageVersion !== input.packageVersion
    || sidecar.catalogEntryId !== input.catalogEntryId
    || sidecar.resourceUri !== resourceUri
    || !sameOwner(sidecar.owner, owner)
    || !await exists(join(root, ENTRYPOINT))) {
    return false;
  }
  try {
    return computeRuntimeExtensionIntegrity(root).value === expectedIntegrity;
  } catch {
    return false;
  }
}
async function ownsPromotion(
  root: string,
  current: {
    readonly identity: string;
    readonly version: string;
    readonly integrity: { readonly value: string };
  },
  context: InvocationContext,
  applicationId: string,
): Promise<boolean> {
  if (!HEX64.test(current.integrity.value)) return false;
  const packageRoot = join(root, current.integrity.value);
  if (!await isSafeChild(root, packageRoot)) return false;
  if (!await validatePackageTree(packageRoot, true)) return false;
  const sidecar = await readSidecar(packageRoot);
  if (!sidecar || sidecar.applicationId !== applicationId
    || sidecar.packageIdentity !== current.identity
    || sidecar.packageVersion !== current.version
    || !ownerMatches(sidecar.owner, context)) {
    return false;
  }
  try {
    return computeRuntimeExtensionIntegrity(packageRoot).value === current.integrity.value;
  } catch {
    return false;
  }
}

async function readSidecar(root: string): Promise<Sidecar | undefined> {
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
      || (await realpath(root)) !== resolve(root)) return undefined;
    const sidecarPath = join(root, SIDEcar);
    const sidecarStat = await lstat(sidecarPath);
    if (!sidecarStat.isFile() || sidecarStat.isSymbolicLink()
      || sidecarStat.size > MAX_SIDECAR) return undefined;
    const text = await readFile(sidecarPath, 'utf8');
    if (Buffer.byteLength(text) > MAX_SIDECAR) return undefined;
    return normalizeSidecar(JSON.parse(text) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

function normalizeSidecar(value: unknown): Sidecar | undefined {
  try {
    const record = strictDataRecord(value, SIDECAR_KEYS, 'Promotion sidecar');
    const ownerRecord = strictDataRecord(record.owner, OWNER_KEYS, 'Promotion owner');
    const owner = {
      principalId: readRequiredString(ownerRecord, 'principalId'),
      scope: readRequiredString(ownerRecord, 'scope'),
      scopeId: readRequiredString(ownerRecord, 'scopeId'),
    };
    const applicationId = readRequiredString(record, 'applicationId');
    const snapshotDigest = readRequiredString(record, 'snapshotDigest');
    const packageIdentity = readRequiredString(record, 'packageIdentity');
    const packageVersion = readRequiredString(record, 'packageVersion');
    const catalogEntryId = readRequiredString(record, 'catalogEntryId');
    const resourceUri = readRequiredString(record, 'resourceUri');
    if (record.schemaVersion !== 1 || !HEX64.test(snapshotDigest)
      || applicationId.length > 256 || catalogEntryId.length > 512
      || resourceUri.length > MAX_URI || owner.principalId.length > 256
      || owner.scopeId.length > 256
      || !['workspace', 'project', 'session'].includes(owner.scope)) {
      return undefined;
    }
    requireRuntimeExtensionIdentity(packageIdentity);
    requireRuntimeExtensionVersion(packageVersion);
    return Object.freeze({
      schemaVersion: 1,
      applicationId,
      snapshotDigest,
      packageIdentity,
      packageVersion,
      catalogEntryId,
      owner: Object.freeze({
        principalId: owner.principalId,
        scope: owner.scope as Sidecar['owner']['scope'],
        scopeId: owner.scopeId,
      }),
      resourceUri,
    });
  } catch {
    return undefined;
  }
}

function strictDataRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} is invalid.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some((key) => !allowedKeys.has(key))
    || Object.values(descriptors).some((descriptor) => !('value' in descriptor))) {
    throw new TypeError(`${label} is invalid.`);
  }
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
  );
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value) throw new TypeError(`${key} is invalid.`);
  return value;
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError(`${key} is invalid.`);
  return value;
}

function detachRecord<T extends object>(value: T): Readonly<T> {
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      throw new TypeError(`Invocation context property "${key}" is invalid.`);
    }
    result[key] = detachValue(descriptor.value);
  }
  return Object.freeze(result) as Readonly<T>;
}

function detachValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(detachValue));
  return detachRecord(value);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function sameOwner(
  left: UiApplicationSnapshot['owner'],
  right: UiApplicationSnapshot['owner'],
): boolean {
  return left.principalId === right.principalId
    && left.scope === right.scope
    && left.scopeId === right.scopeId;
}

function acquirePublication(packageRoot: string, created: boolean): PublicationLease {
  let state = publicationStates.get(packageRoot);
  if (!state) {
    state = { users: 0, created, retained: false };
    publicationStates.set(packageRoot, state);
  } else if (created) {
    state.created = true;
  }
  state.users += 1;
  return { packageRoot, state, released: false };
}

async function releasePublication(
  publication: PublicationLease,
  retain: boolean,
): Promise<void> {
  if (publication.released) return;
  publication.released = true;
  publication.state.retained ||= retain;
  publication.state.users -= 1;
  if (publication.state.users > 0) return;
  publicationStates.delete(publication.packageRoot);
  if (publication.state.created && !publication.state.retained) {
    await safeRemoveTree(publication.packageRoot);
  }
}
