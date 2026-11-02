import type { InvocationContext, MaybePromise } from '@marshal/agent-runtime-core';
import type { RuntimeResourceContent } from '@marshal/agent-runtime-composer';
import { validateUiApplicationManifest } from '@marshal/agent-runtime-ui';
import { requireRuntimeExtensionIdentity } from './manifest.js';
import type {
  RuntimeExtensionUiApplication,
  RuntimeExtensionUiPlacement,
} from './contracts.js';
import type {
  RuntimeExtensionUiPublicationRevision,
  RuntimeExtensionUiPublicationService,
  RuntimeExtensionUiPublishedApplication,
  RuntimeExtensionUiPublishedPlacement,
} from './services.js';
import type { RuntimeExtensionOperationOptions } from './contracts.js';
import {
  RuntimeExtensionUiPlacementRegistry,
  type ResolvedRuntimeExtensionUiPlacement,
  type RuntimeExtensionUiHostPlacement,
  type RuntimeExtensionUiPlacementDiagnostic,
  type RuntimeExtensionUiPlacementRegistration,
} from './uiPlacement.js';

export interface RuntimeExtensionUiPublicationRegistryNotification {
  readonly type: 'committed' | 'revoked';
  readonly ownerId: string;
  readonly revisionId: string;
  readonly resolution: RuntimeExtensionUiPublicationRegistryResolution;
}
export interface RuntimeExtensionUiPublicationRegistryOptions {
  readonly notify?: (notification: RuntimeExtensionUiPublicationRegistryNotification) => MaybePromise<void>;
}
export interface RuntimeExtensionUiPublicationRegistryResolution {
  readonly applications: readonly RuntimeExtensionUiPublishedApplication[];
  readonly placements: readonly ResolvedRuntimeExtensionUiPlacement[];
  readonly diagnostics: readonly RuntimeExtensionUiPlacementDiagnostic[];
}
interface Record {
  readonly ownerId: string;
  readonly revisionId: string;
  readonly applications: readonly RuntimeExtensionUiPublishedApplication[];
  readonly placements: readonly RuntimeExtensionUiPublishedPlacement[];
}

const MAX_APPLICATIONS = 128;
const MAX_PLACEMENTS = 128;
const MAX_TAGS = 32;
const MAX_METADATA_KEYS = 64;
const MAX_METADATA_BYTES = 32_768;

export class RuntimeExtensionUiPublicationRegistry implements RuntimeExtensionUiPublicationService {
  readonly #placementRegistry: RuntimeExtensionUiPlacementRegistry;
  readonly #notify?: RuntimeExtensionUiPublicationRegistryOptions['notify'];
  readonly #records = new Map<string, Record>();
  readonly #previous = new Map<string, Record | undefined>();
  #queue: Promise<void> = Promise.resolve();

  constructor(
    hostPlacements: readonly RuntimeExtensionUiHostPlacement[],
    options: RuntimeExtensionUiPublicationRegistryOptions = {},
  ) {
    this.#placementRegistry = new RuntimeExtensionUiPlacementRegistry(hostPlacements);
    this.#notify = options.notify;
  }

  preparePublicationRevision(
    ownerId: string,
    revisionId: string,
    revision: { readonly applications?: readonly RuntimeExtensionUiApplication[]; readonly placements?: readonly RuntimeExtensionUiPlacement[] },
    context: InvocationContext,
    _options?: RuntimeExtensionOperationOptions,
  ): Promise<RuntimeExtensionUiPublicationRevision> {
    assertOwner(ownerId, context);
    const normalizedOwner = requireRuntimeExtensionIdentity(ownerId);
    const normalizedRevision = requireRevisionId(revisionId);
    const normalized = normalizeRevision(normalizedOwner, normalizedRevision, revision);
    return this.exclusive(async () => {
      const previous = this.#records.get(normalizedOwner);
      this.validate(normalized, normalizedOwner);
      this.#records.set(normalizedOwner, normalized);
      this.#previous.set(normalizedOwner, previous);
      const visible = this.resolveInternal();
      try {
        await this.#notify?.({ type: 'committed', ownerId: normalizedOwner, revisionId: normalizedRevision, resolution: visible });
      } catch (error) {
        previous ? this.#records.set(normalizedOwner, previous) : this.#records.delete(normalizedOwner);
        throw error;
      }
      return Object.freeze({
        ownerId: normalizedOwner,
        revisionId: normalizedRevision,
        applications: normalized.applications,
        placements: normalized.placements,
      });
    });
  }

  listApplications(context: InvocationContext): Promise<readonly RuntimeExtensionUiPublishedApplication[]>;
  listApplications(ownerId: string | undefined, context: InvocationContext, options?: RuntimeExtensionOperationOptions): Promise<readonly RuntimeExtensionUiPublishedApplication[]>;
  listApplications(ownerOrContext: string | InvocationContext | undefined, context?: InvocationContext): Promise<readonly RuntimeExtensionUiPublishedApplication[]> {
    const owner = typeof ownerOrContext === 'string' || ownerOrContext === undefined ? ownerOrContext : undefined;
    const actualContext = typeof ownerOrContext === 'object' ? ownerOrContext : context;
    if (!actualContext) throw new TypeError('Invocation context is required.');
    if (owner !== undefined) assertOwner(owner, actualContext);
    return Promise.resolve(Object.freeze([...this.#records.values()]
      .filter((record) => owner === undefined || record.ownerId === requireRuntimeExtensionIdentity(owner))
      .flatMap((record) => record.applications)
      .sort((a, b) => a.ownerId.localeCompare(b.ownerId) || a.revisionId.localeCompare(b.revisionId) || a.id.localeCompare(b.id))));
  }

  resolvePlacementState(context: InvocationContext): Promise<{ readonly placements: readonly RuntimeExtensionUiPlacement[] }> {
    assertContext(context);
    this.resolveInternal();
    return Promise.resolve(Object.freeze({
      placements: Object.freeze([...this.#records.values()].flatMap((record) => record.placements)),
    }));
  }

  revoke(ownerId: string, revisionId: string, context: InvocationContext): Promise<void> {
    assertOwner(ownerId, context);
    const owner = requireRuntimeExtensionIdentity(ownerId);
    const revision = requireRevisionId(revisionId);
    return this.exclusive(async () => {
      if (this.#records.get(owner)?.revisionId !== revision) return;
      const current = this.#records.get(owner)!;
      this.#records.delete(owner);
      try {
        await this.#notify?.({ type: 'revoked', ownerId: owner, revisionId: revision, resolution: this.resolveInternal() });
      } catch (error) {
        this.#records.set(owner, current);
        throw error;
      }
    });
  }

  rollback(ownerId: string, revisionId: string, context: InvocationContext): Promise<void> {
    assertOwner(ownerId, context);
    const owner = requireRuntimeExtensionIdentity(ownerId);
    const revision = requireRevisionId(revisionId);
    return this.exclusive(async () => {
      if (this.#records.get(owner)?.revisionId !== revision) return;
      const previous = this.#previous.get(owner);
      previous ? this.#records.set(owner, previous) : this.#records.delete(owner);
      this.#previous.delete(owner);
    });
  }

  private validate(revision: Record, ownerId: string): void {
    const other = [...this.#records.values()].filter((record) => record.ownerId !== ownerId);
    const apps = [...other.flatMap((record) => record.applications), ...revision.applications];
    const ids = new Set<string>();
    const uris = new Set<string>();
    for (const app of apps) {
      if (ids.has(app.id) || (uris.has(app.resource.uri) && app.ownerId !== ownerId)) {
        throw new TypeError('Published UI application or resource collides with an existing owner.');
      }
      ids.add(app.id); uris.add(app.resource.uri);
    }
    const placements = [...other.flatMap((record) => record.placements), ...revision.placements]
      .map((p) => ({ ...p, extensionId: p.ownerId }));
    const resolved = this.#placementRegistry.resolve(placements as readonly RuntimeExtensionUiPlacementRegistration[]);
    if (resolved.diagnostics.length) throw new RuntimeExtensionUiPublicationRegistryError(resolved.diagnostics);
  }
  private resolveInternal(): RuntimeExtensionUiPublicationRegistryResolution {
    const applications = [...this.#records.values()].flatMap((record) => record.applications)
      .sort((a, b) => a.ownerId.localeCompare(b.ownerId) || a.revisionId.localeCompare(b.revisionId) || a.id.localeCompare(b.id));
    const placements = this.#placementRegistry.resolve([...this.#records.values()].flatMap((record) =>
      record.placements.map((p) => ({ ...p, extensionId: p.ownerId })) as RuntimeExtensionUiPlacementRegistration[]));
    return Object.freeze({ applications: Object.freeze(applications), placements: placements.placements, diagnostics: placements.diagnostics });
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(fn, fn); this.#queue = result.then(() => undefined, () => undefined); return result;
  }
}

export class RuntimeExtensionUiPublicationRegistryError extends Error {
  constructor(readonly diagnostics: readonly RuntimeExtensionUiPlacementDiagnostic[]) {
    super('Runtime extension UI publication revision failed validation.');
    this.name = 'RuntimeExtensionUiPublicationRegistryError';
  }
}

function assertContext(context: InvocationContext): void {
  if (!context?.principal?.id) throw new TypeError('Invocation context principal is required.');
}
function assertOwner(owner: string, context: InvocationContext): void {
  assertContext(context);
  if (context.principal.id !== owner) throw new Error('UI publication owner does not match invocation principal.');
}
function requireRevisionId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256 || value !== value.trim() || value !== value.normalize('NFC')) {
    throw new TypeError('Runtime extension UI publication revision ID is invalid.');
  }
  return value;
}
function normalizeRevision(ownerId: string, revisionId: string, input: {
  readonly applications?: readonly RuntimeExtensionUiApplication[];
  readonly placements?: readonly RuntimeExtensionUiPlacement[];
}): Record {
  if (!input || typeof input !== 'object') throw new TypeError('UI publication revision is invalid.');
  if (input.applications !== undefined && !Array.isArray(input.applications)) {
    throw new TypeError('UI applications must be an array.');
  }
  if (input.placements !== undefined && !Array.isArray(input.placements)) {
    throw new TypeError('UI placements must be an array.');
  }
  const applications = (input.applications ?? []).map((value) => normalizeApplication(ownerId, revisionId, value));
  if (applications.length > MAX_APPLICATIONS) throw new TypeError('Too many UI applications.');
  const ids = new Set(applications.map((app) => app.id));
  if (ids.size !== applications.length) throw new TypeError('UI application IDs must be unique within a revision.');
  const placements = (input.placements ?? []).map((value) => {
    if (!value || typeof value !== 'object') throw new TypeError('UI placement is invalid.');
    if (!ids.has(value.applicationId)) throw new TypeError('UI placement references an unknown application.');
    if (!value.placementId || value.placementId.length > 256 || value.placementId !== value.placementId.trim()) {
      throw new TypeError('UI placement ID is invalid.');
    }
    return Object.freeze({ ...value, ownerId, revisionId });
  });
  if (placements.length > MAX_PLACEMENTS) throw new TypeError('Too many UI placements.');
  return Object.freeze({ ownerId, revisionId, applications: Object.freeze(applications), placements: Object.freeze(placements) });
}
function normalizeApplication(ownerId: string, revisionId: string, value: RuntimeExtensionUiApplication): RuntimeExtensionUiPublishedApplication {
  if (!value || typeof value !== 'object') throw new TypeError('UI application is invalid.');
  for (const field of [value.id, value.title, value.description, value.renderId]) {
    if (typeof field !== 'string' || !field.trim() || field.length > 1024 || field !== field.normalize('NFC')) {
      throw new TypeError('UI application text is invalid.');
    }
  }
  const id = value.id.trim();
  if (id.length > 256) throw new TypeError('UI application ID is invalid.');
  const resource = value.resource as RuntimeResourceContent;
  if (!resource || typeof resource !== 'object' || typeof resource.uri !== 'string'
    || !resource.uri.trim() || resource.uri.length > 4096
    || (resource.text === undefined && resource.blob === undefined)
    || (resource.text !== undefined && typeof resource.text !== 'string')
    || (resource.blob !== undefined && typeof resource.blob !== 'string')) {
    throw new TypeError('UI resource is invalid.');
  }
  if (value.tags && (!Array.isArray(value.tags) || value.tags.length > MAX_TAGS
    || value.tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 128))) {
    throw new TypeError('UI tags are invalid.');
  }
  const metadata = value.metadata ? Object.freeze({ ...value.metadata }) : undefined;
  if (metadata && (typeof value.metadata !== 'object' || Array.isArray(value.metadata)
    || Object.keys(metadata).length > MAX_METADATA_KEYS || JSON.stringify(metadata).length > MAX_METADATA_BYTES)) {
    throw new TypeError('UI metadata is invalid.');
  }
  return Object.freeze({ ...value, id, ownerId, revisionId, resource: Object.freeze({ ...resource, uri: resource.uri.trim() }), application: Object.freeze(validateUiApplicationManifest(value.application)), ...(metadata ? { metadata } : {}) });
}
