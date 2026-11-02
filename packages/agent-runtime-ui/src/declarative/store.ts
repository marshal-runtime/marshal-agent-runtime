import { createHash, randomUUID } from 'node:crypto';
import { link, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { InvocationContext } from '../coreTypes.js';
import type { UiStateScope } from '../applicationTypes.js';
import {
  assertContainedFileTarget,
  ensureContainedDirectory,
  initializeSafeDirectory,
  resolveContainedExistingPath,
  resolveContainedPath,
  safeSegment,
} from '../pathSafety.js';
import { ReactUiStore } from '../store.js';
import type { DeclarativeUiDocument, UiArtifact, UiArtifactSummary } from './types.js';
import { validateUiDocument, type UiValidationLimits } from './validation.js';

export interface DeclarativeUiStoreOptions extends UiValidationLimits {
  storageRoot: string;
  maxArtifactsPerScope?: number;
  maxRevisionsPerArtifact?: number;
  maxActionResultsPerScope?: number;
  maxActionResultBytes?: number;
}

const MUTATION_LOCK_LEASE_MS = 30_000;
const MUTATION_LOCK_WAIT_MS = 30_000;

export class DeclarativeUiStore {
  private rootPromise?: Promise<string>;
  readonly actionIdempotencyStore: ReactUiStore;
  private readonly mutationStore: ReactUiStore;

  constructor(private readonly options: DeclarativeUiStoreOptions) {
    this.actionIdempotencyStore = new ReactUiStore({
      storageRoot: resolve(options.storageRoot, 'action-runtime'),
      ...(options.maxActionResultsPerScope === undefined
        ? {}
        : { maxActionResultsPerScope: options.maxActionResultsPerScope }),
      ...(options.maxActionResultBytes === undefined
        ? {}
        : { maxActionResultBytes: options.maxActionResultBytes }),
    });
    this.mutationStore = new ReactUiStore({
      storageRoot: resolve(options.storageRoot, 'mutation-runtime'),
    });
  }

  async create(documentValue: unknown, context: InvocationContext): Promise<UiArtifact> {
    const document = canonicalDocument(documentValue, this.options);
    return this.withMutationLock(context, async () => {
      const current = await this.list(context);
      if (current.length >= (this.options.maxArtifactsPerScope ?? 100))
        throw new Error('UI artifact scope limit reached');
      const id = randomUUID();
      const now = new Date().toISOString();
      const documentDigest = uiDocumentDigest(document);
      const artifact: UiArtifact = {
        id,
        scopeKey: scopeKey(context),
        revision: 1,
        documentDigest,
        createdAt: now,
        updatedAt: now,
        document,
        resourceUri: resourceUri(id, documentDigest, 1),
      };
      const persisted = await this.writeRevision(artifact, context);
      await this.writeLatest(persisted, context);
      return persisted;
    });
  }

  async update(
    idValue: string,
    documentValue: unknown,
    context: InvocationContext,
    expectedRevision?: number,
  ): Promise<UiArtifact> {
    const id = safeSegment(idValue, 'artifactId');
    const document = canonicalDocument(documentValue, this.options);
    return this.withMutationLock(context, async () => {
      const existing = await this.get(id, context);
      if (expectedRevision !== undefined && existing.revision !== expectedRevision)
        throw new Error(
          `UI artifact revision conflict: expected ${expectedRevision}, found ${existing.revision}`,
        );
      const revision = existing.revision + 1;
      const documentDigest = uiDocumentDigest(document);
      const artifact: UiArtifact = {
        ...existing,
        revision,
        documentDigest,
        updatedAt: new Date().toISOString(),
        document,
        resourceUri: resourceUri(id, documentDigest, revision),
      };
      const persisted = await this.writeRevision(artifact, context);
      await this.writeLatest(persisted, context);
      return persisted;
    });
  }

  async get(idValue: string, context: InvocationContext): Promise<UiArtifact> {
    const id = safeSegment(idValue, 'artifactId');
    const root = await this.root();
    const path = this.artifactPath(root, context, id);
    const latest = await this.readArtifact(root, path, id, context, 'UI artifact');
    const reconciled = await this.reconcileLatest(root, id, latest, context);
    return this.getRevision(
      id,
      reconciled.revision,
      reconciled.documentDigest,
      context,
    );
  }

  async getRevision(
    idValue: string,
    revisionValue: number,
    documentDigestValue: string,
    context: InvocationContext,
  ): Promise<UiArtifact> {
    const id = safeSegment(idValue, 'artifactId');
    const revision = positiveRevision(revisionValue);
    const documentDigest = digestId(documentDigestValue, 'documentDigest');
    const root = await this.root();
    const path = this.artifactRevisionPath(root, context, id, revision);
    const artifact = await this.readArtifact(
      root,
      path,
      id,
      context,
      `UI artifact revision ${revision}`,
    );
    if (artifact.revision !== revision) {
      throw new Error(
        `UI artifact revision validation failed: expected ${revision}, found ${artifact.revision}`,
      );
    }
    if (artifact.documentDigest !== documentDigest) {
      throw new Error('UI artifact document digest does not match the requested revision');
    }
    return artifact;
  }

  private async readArtifact(
    root: string,
    path: string,
    id: string,
    context: InvocationContext,
    label: string,
  ): Promise<UiArtifact> {
    const artifact = await this.tryReadArtifact(root, path, id, context, label);
    if (!artifact) throw new Error(`${label} for ${id} was not found in this scope`);
    return artifact;
  }

  private async tryReadArtifact(
    root: string,
    path: string,
    id: string,
    context: InvocationContext,
    label: string,
  ): Promise<UiArtifact | undefined> {
    let text: string;
    try {
      const safePath = await resolveContainedExistingPath(root, path, label, 'file');
      text = await readFile(safePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const artifact = JSON.parse(text) as Partial<UiArtifact>;
    if (artifact.id !== id || artifact.scopeKey !== scopeKey(context))
      throw new Error('UI artifact scope validation failed');
    if (!Number.isSafeInteger(artifact.revision) || (artifact.revision ?? 0) < 1)
      throw new Error('UI artifact revision validation failed');
    const document = validateUiDocument(artifact.document, this.options);
    const documentDigest = uiDocumentDigest(document);
    if (artifact.documentDigest !== documentDigest)
      throw new Error('UI artifact document digest validation failed');
    if (artifact.resourceUri !== resourceUri(id, documentDigest, artifact.revision!))
      throw new Error('UI artifact resource URI validation failed');
    if (
      typeof artifact.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(artifact.createdAt)) ||
      typeof artifact.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(artifact.updatedAt))
    ) {
      throw new Error('UI artifact timestamp validation failed');
    }
    return {
      id,
      scopeKey: artifact.scopeKey,
      revision: artifact.revision!,
      documentDigest,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
      document,
      resourceUri: artifact.resourceUri,
    };
  }

  async list(context: InvocationContext): Promise<UiArtifactSummary[]> {
    const root = await this.root();
    const directory = this.scopeDirectory(root, context);
    let files: string[];
    try {
      const safeDirectory = await resolveContainedExistingPath(
        root,
        directory,
        'UI artifact directory',
        'directory',
      );
      files = await readdir(safeDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const artifactFiles = files.filter((file) => file.endsWith('.json'));
    if (artifactFiles.length > (this.options.maxArtifactsPerScope ?? 100))
      throw new Error('UI artifact scope exceeds its configured limit');
    const artifacts = await Promise.all(
      artifactFiles.map(
        async (file) => this.get(file.slice(0, -5), context),
      ),
    );
    return artifacts
      .map(summary)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async delete(idValue: string, context: InvocationContext): Promise<boolean> {
    const id = safeSegment(idValue, 'artifactId');
    return this.withMutationLock(context, async () => {
      const root = await this.root();
      const path = this.artifactPath(root, context, id);
      let deleted = false;
      try {
        const safePath = await resolveContainedExistingPath(root, path, 'UI artifact', 'file');
        await rm(safePath);
        deleted = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const revisionDirectory = this.artifactRevisionDirectory(root, context, id);
      try {
        const safeDirectory = await resolveContainedExistingPath(
          root,
          revisionDirectory,
          'UI artifact revision directory',
          'directory',
        );
        await rm(safeDirectory, { recursive: true });
        deleted = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return deleted;
    });
  }

  private async writeLatest(artifact: UiArtifact, context: InvocationContext): Promise<void> {
    const root = await this.root();
    const path = this.artifactPath(root, context, artifact.id);
    await this.writeAtomic(root, path, artifact, 'UI artifact');
  }

  private async writeRevision(
    artifact: UiArtifact,
    context: InvocationContext,
  ): Promise<UiArtifact> {
    const root = await this.root();
    const path = this.artifactRevisionPath(root, context, artifact.id, artifact.revision);
    if (artifact.revision > (this.options.maxRevisionsPerArtifact ?? 10_000)) {
      throw new Error('UI artifact revision history limit reached');
    }
    const directory = dirname(path);
    await ensureContainedDirectory(root, directory, 'UI artifact revision directory');
    await assertContainedFileTarget(root, path, 'UI artifact revision');
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await assertContainedFileTarget(root, temporary, 'UI artifact revision temporary file');
    let persisted = artifact;
    try {
      await writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      await resolveContainedExistingPath(
        root,
        temporary,
        'UI artifact revision temporary file',
        'file',
      );
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await this.readArtifact(
        root,
        path,
        artifact.id,
        context,
        `UI artifact revision ${artifact.revision}`,
      );
      if (!sameImmutableRevision(existing, artifact)) {
        throw new Error(`UI artifact revision ${artifact.revision} already exists`);
      }
      persisted = existing;
    } finally {
      try {
        const safeTemporary = await resolveContainedExistingPath(
          root,
          temporary,
          'UI artifact revision temporary file',
          'file',
        );
        await rm(safeTemporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await resolveContainedExistingPath(root, path, 'UI artifact revision', 'file');
    return persisted;
  }

  private async reconcileLatest(
    root: string,
    id: string,
    latest: UiArtifact,
    context: InvocationContext,
  ): Promise<UiArtifact> {
    const revisionDirectory = await resolveContainedExistingPath(
      root,
      this.artifactRevisionDirectory(root, context, id),
      'UI artifact revision directory',
      'directory',
    );
    const files = await readdir(revisionDirectory);
    const revisionFiles = files.filter((file) => /^[1-9][0-9]*\.json$/.test(file));
    if (revisionFiles.length > (this.options.maxRevisionsPerArtifact ?? 10_000)) {
      throw new Error('UI artifact revision history exceeds its configured limit');
    }
    const revisions = revisionFiles
      .map((file) => Number(file.slice(0, -5)))
      .filter((revision) => Number.isSafeInteger(revision))
      .sort((left, right) => left - right);
    let current = latest;
    for (const revision of revisions) {
      if (revision <= current.revision) continue;
      if (revision !== current.revision + 1) {
        throw new Error('UI artifact revision history is not contiguous');
      }
      const next = await this.readArtifact(
        root,
        this.artifactRevisionPath(root, context, id, revision),
        id,
        context,
        `UI artifact revision ${revision}`,
      );
      if (next.revision !== revision || next.createdAt !== current.createdAt) {
        throw new Error('UI artifact revision history validation failed');
      }
      current = next;
    }
    return current;
  }

  private async withMutationLock<T>(
    context: InvocationContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = createHash('sha256')
      .update(`marshal.declarative-ui.scope-mutation.v1\0${scopeKey(context)}`)
      .digest('hex');
    const requestDigest = createHash('sha256')
      .update(`marshal.declarative-ui.scope-mutation-request.v1\0${scopeKey(context)}`)
      .digest('hex');
    const scope = mutationLockScope(context);
    const deadline = Date.now() + MUTATION_LOCK_WAIT_MS;
    while (true) {
      if (context.signal?.aborted) throw new Error('UI artifact mutation was cancelled');
      const claim = await this.mutationStore.claim(
        key,
        scope,
        requestDigest,
        MUTATION_LOCK_LEASE_MS,
        context,
      );
      if (claim.status === 'acquired') {
        try {
          return await operation();
        } finally {
          await this.mutationStore.release(key, scope, claim.lease, context);
        }
      }
      if (claim.status === 'replay') {
        throw new Error('UI artifact mutation lock contained an unexpected completed result');
      }
      if (Date.now() >= deadline) throw new Error('UI artifact mutation lock timed out');
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, Math.max(1, Math.min(25, claim.retryAfterMs))),
      );
    }
  }

  private async writeAtomic(
    root: string,
    path: string,
    artifact: UiArtifact,
    label: string,
  ): Promise<void> {
    const directory = dirname(path);
    await ensureContainedDirectory(root, directory, `${label} directory`);
    await assertContainedFileTarget(root, path, label);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await assertContainedFileTarget(root, temporary, `${label} temporary file`);
    try {
      await writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      await resolveContainedExistingPath(root, temporary, `${label} temporary file`, 'file');
      await ensureContainedDirectory(root, directory, `${label} directory`);
      await assertContainedFileTarget(root, path, label);
      await rename(temporary, path);
    } finally {
      try {
        const safeTemporary = await resolveContainedExistingPath(
          root,
          temporary,
          `${label} temporary file`,
          'file',
        );
        await rm(safeTemporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  private artifactPath(root: string, context: InvocationContext, id: string): string {
    return resolveContainedPath(
      root,
      resolve(this.scopeDirectory(root, context), `${id}.json`),
      'artifact path',
    );
  }

  private artifactRevisionPath(
    root: string,
    context: InvocationContext,
    id: string,
    revision: number,
  ): string {
    return resolveContainedPath(
      root,
      resolve(this.artifactRevisionDirectory(root, context, id), `${revision}.json`),
      'artifact revision path',
    );
  }

  private artifactRevisionDirectory(
    root: string,
    context: InvocationContext,
    id: string,
  ): string {
    return resolveContainedPath(
      root,
      resolve(root, 'scopes', scopeKey(context), 'ui-revisions', id),
      'artifact revision storage',
    );
  }

  private scopeDirectory(root: string, context: InvocationContext): string {
    return resolveContainedPath(
      root,
      resolve(root, 'scopes', scopeKey(context), 'ui'),
      'scope storage',
    );
  }

  private root(): Promise<string> {
    return (this.rootPromise ??= initializeSafeDirectory(
      resolve(this.options.storageRoot),
      'Declarative UI storage root',
    ));
  }
}

export function scopeKey(context: InvocationContext): string {
  const scope = context.scope ?? {};
  const stable = JSON.stringify({
    workspaceId: scope.workspaceId ?? scope.workspacePath ?? '',
    projectId: scope.projectId ?? '',
    sessionId: scope.sessionId ?? '',
    principalId: context.principal.id,
  });
  return createHash('sha256').update(stable).digest('hex').slice(0, 32);
}

export function uiDocumentDigest(document: DeclarativeUiDocument): string {
  return createHash('sha256')
    .update(canonicalJson(jsonRoundTrip(document)))
    .digest('hex');
}

export function resourceUri(id: string, documentDigest: string, revision: number): string {
  return `ui://marshal-declarative/${id}/d/${documentDigest}/r/${revision}`;
}

export function parseDeclarativeUiResourceUri(
  uri: string,
): { id: string; revision: number; documentDigest: string } {
  const match =
    /^ui:\/\/marshal-declarative\/([A-Za-z0-9._-]+)\/d\/([a-f0-9]{64})\/r\/([1-9][0-9]*)$/.exec(
      uri,
    );
  if (!match) throw new Error('Invalid declarative UI resource URI');
  return { id: match[1], documentDigest: match[2], revision: Number(match[3]) };
}

function summary(artifact: UiArtifact): UiArtifactSummary {
  return {
    id: artifact.id,
    revision: artifact.revision,
    documentDigest: artifact.documentDigest,
    title: artifact.document.title,
    description: artifact.document.description,
    updatedAt: artifact.updatedAt,
    resourceUri: artifact.resourceUri,
  };
}

function positiveRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error('revision must be a positive integer');
  return value;
}

function digestId(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field} must be a SHA-256 digest`);
  return value;
}

function canonicalDocument(
  value: unknown,
  limits: UiValidationLimits,
): DeclarativeUiDocument {
  return validateUiDocument(
    jsonRoundTrip(validateUiDocument(value, limits)),
    limits,
  );
}

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sameImmutableRevision(left: UiArtifact, right: UiArtifact): boolean {
  return (
    left.id === right.id &&
    left.scopeKey === right.scopeKey &&
    left.revision === right.revision &&
    left.documentDigest === right.documentDigest &&
    left.createdAt === right.createdAt &&
    left.resourceUri === right.resourceUri &&
    canonicalJson(left.document) === canonicalJson(right.document)
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('UI document contains a non-JSON value');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) =>
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
    )
    .join(',')}}`;
}

function mutationLockScope(context: InvocationContext): UiStateScope {
  if (context.scope?.sessionId) return 'session';
  if (context.scope?.projectId) return 'project';
  return 'workspace';
}
