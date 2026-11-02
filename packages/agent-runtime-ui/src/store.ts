import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  truncate,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { InvocationContext, RuntimeExecutionReceipt } from '@marshal/agent-runtime-core';
import {
  assertContained,
  assertContainedFileTarget,
  ensureContainedDirectory,
  initializeSafeDirectory,
  readContainedFileStable,
  resolveContainedExistingPath,
} from './pathSafety.js';
import type { CompiledReactComponent, ReactUiRender, ReactUiWorkspaceBinding } from './types.js';
import type { ReactUiRecordAuthenticator, ReactUiRecordSeal } from './recordAuthority.js';
import type {
  UiActionIdempotencyRecord,
  UiActionIdempotencyClaim,
  UiActionIdempotencyLease,
  UiActionIdempotencyStore,
  UiActionJournalAttempt,
  UiActionJournalStore,
  UiActionResult,
  UiApplicationStateSnapshot,
  UiStateScope,
} from './applicationTypes.js';

export interface ReactUiStoreOptions {
  storageRoot: string;
  maxComponentsPerScope?: number;
  maxRendersPerScope?: number;
  maxActionResultsPerScope?: number;
  maxActionResultBytes?: number;
  maxActionJournalBytes?: number;
  maxActionAttemptsPerKey?: number;
  /** Bound waiting for a cross-process action transaction lock. */
  actionTransactionTimeoutMs?: number;
  /** Heartbeat staleness threshold for a cross-process action transaction owner. */
  actionTransactionStaleMs?: number;
  /**
   * Recover records written by the pre-1.0 session-scoped store. This is intended
   * for a harness adapter whose state root is already isolated to one workspace
   * and principal (for example the Codex adapter).
   */
  recoverLegacySessionScopes?: boolean;
  /** Harness-owned authenticity for executable component and render records. */
  recordAuthenticator?: ReactUiRecordAuthenticator;
  /**
   * Unsigned records predate authenticity support. Secure harness adapters must
   * keep the default reject policy and require recompilation instead of silently
   * trusting agent-writable legacy state.
   */
  unsignedRecordPolicy?: 'reject' | 'content-only';
}

type ReactUiExecutableRecordKind = 'component' | 'render' | 'workspace-head';

interface ReactUiAuthenticatedRecord<T> {
  schemaVersion: 1;
  kind: ReactUiExecutableRecordKind;
  record: T;
  seal: ReactUiRecordSeal;
}

export type ReactUiStorageMutation =
  | { operation: 'set'; key: string; value: string; expectedVersion?: number }
  | { operation: 'remove'; key: string; expectedVersion?: number }
  | { operation: 'clear'; expectedVersion?: number };

interface ReactUiStoredState {
  scopeKey: string;
  renderId: string;
  scope: UiStateScope;
  schemaVersion: string;
  version: number;
  values: Record<string, string>;
  updatedAt: string;
}

interface ReactUiStoredActionResult extends UiActionIdempotencyRecord {
  scopeKey: string;
  key: string;
  scope: UiStateScope;
  createdAt: string;
}

interface ReactUiStoredActionLease extends UiActionIdempotencyLease {
  scopeKey: string;
  key: string;
  scope: UiStateScope;
  createdAt: string;
  leaseDurationMs?: number;
  ownerPid?: number;
}

interface ReactUiStoredActionJournal {
  schemaVersion: 1;
  scopeKey: string;
  key: string;
  scope: UiStateScope;
  requestDigest: string;
  attempts: UiActionJournalAttempt[];
  activeReceiptId?: string;
}

type ReactUiStoredActionJournalEvent =
  | {
      schemaVersion: 1;
      type: 'begin';
      scopeKey: string;
      key: string;
      scope: UiStateScope;
      requestDigest: string;
      at: string;
      attempt: UiActionJournalAttempt;
    }
  | {
      schemaVersion: 1;
      type: 'resume';
      scopeKey: string;
      key: string;
      scope: UiStateScope;
      requestDigest: string;
      at: string;
      receiptId: string;
      ownerId?: string;
      ownerPid: number;
      leaseExpiresAt?: string;
    }
  | {
      schemaVersion: 1;
      type: 'lease_lost';
      scopeKey: string;
      key: string;
      scope: UiStateScope;
      requestDigest: string;
      at: string;
      receiptId: string;
      error: { code: string; message: string };
    }
  | {
      schemaVersion: 1;
      type: 'complete';
      scopeKey: string;
      key: string;
      scope: UiStateScope;
      requestDigest: string;
      at: string;
      receiptId: string;
      result: UiActionResult;
    }
  | {
      schemaVersion: 1;
      type: 'close';
      scopeKey: string;
      key: string;
      scope: UiStateScope;
      requestDigest: string;
      at: string;
      receiptId: string;
    };

interface ReactUiWorkspaceHead {
  schemaVersion: 1;
  id: string;
  scopeKey: string;
  renderId: string;
  componentId: string;
  activatedAt: string;
}

interface ReactUiActionTransactionOwner {
  ownerId: string;
  pid: number;
  createdAt: string;
}

interface ReactUiActionTransactionObservation {
  owner: ReactUiActionTransactionOwner;
  modifiedAt: number;
  kind: 'directory' | 'incomplete-directory' | 'legacy-file';
}

interface ReactUiActionTransactionQueueEntry {
  deadline: number;
  sequence: number;
  resolve(release: () => void): void;
}

interface ReactUiActionTransactionQueue {
  nextSequence: number;
  waiting: ReactUiActionTransactionQueueEntry[];
}

interface ReactUiActiveActionLease {
  ownerId: string;
  requestDigest: string;
  expiresAt: string;
}

interface ReactUiActionTransactionLock {
  assertHealthy(): Promise<void>;
  release(): Promise<void>;
}

const ACTION_TRANSACTION_POLL_MS = 5;
const ACTION_TRANSACTION_OWNER_PREFIX = 'owner-';
const ACTION_TRANSACTION_OWNER_SUFFIX = '.json';
const ACTION_TRANSACTION_QUEUES = new Map<string, ReactUiActionTransactionQueue>();
const ACTIVE_ACTION_ATTEMPTS = new Set<string>();
const ACTIVE_ACTION_LEASES = new Map<string, ReactUiActiveActionLease>();
const SCOPE_EXECUTABLE_MUTATION_KEY = digest('marshal.react-ui.scope-executable-mutation.v1');
const ACTION_CAPACITY_TRANSACTION_KEY = digest('marshal.react-ui.action-capacity.v1');

export class ReactUiStore implements UiActionIdempotencyStore, UiActionJournalStore {
  private rootPromise?: Promise<string>;
  private readonly stateWrites = new Map<string, Promise<ReactUiStoredState>>();
  private readonly actionWrites = new Map<string, Promise<void>>();

  constructor(private readonly options: ReactUiStoreOptions) {}

  async putComponent(
    component: Omit<CompiledReactComponent, 'scopeKey'>,
    context: InvocationContext,
  ): Promise<CompiledReactComponent> {
    const value = { ...component, scopeKey: scopeKey(context) };
    const existing = await this.tryReadComponent(value.id, context);
    if (existing) return existing;
    return this.withScopeExecutableMutation(context, (root) =>
      this.putComponentUnlocked(root, value, context));
  }

  async getComponent(id: string, context: InvocationContext): Promise<CompiledReactComponent> {
    assertDigestId(id, 'componentId');
    const value = await this.tryReadComponent(id, context);
    if (!value) throw new Error(`Compiled UI component ${id} was not found in this scope`);
    return value;
  }

  async listComponents(context: InvocationContext): Promise<CompiledReactComponent[]> {
    const root = await this.root();
    return this.listJson(root, this.directory(root, context, 'components'), (id) =>
      this.getComponent(id, context),
    );
  }

  /** Recovery enumeration isolates unrelated corrupt records; callers still authenticate every result. */
  async listComponentsBestEffort(context: InvocationContext): Promise<CompiledReactComponent[]> {
    const root = await this.root();
    const files = await this.listFileNames(root, this.directory(root, context, 'components'));
    const values = await Promise.all(files.map(async (file) => {
      try {
        return await this.getComponent(file.slice(0, -5), context);
      } catch {
        return undefined;
      }
    }));
    return values.filter((value): value is CompiledReactComponent => value !== undefined);
  }

  async getWorkspaceHead(renderId: string, context: InvocationContext): Promise<string | undefined> {
    assertDigestId(renderId, 'renderId');
    const root = await this.root();
    const render = await this.getRender(renderId, context);
    return this.readCurrentWorkspaceHeadUnlocked(root, render, context);
  }

  private async readCurrentWorkspaceHeadUnlocked(
    root: string,
    render: ReactUiRender,
    context: InvocationContext,
  ): Promise<string | undefined> {
    const renderId = render.id;
    try {
      const path = await resolveContainedExistingPath(
        root, this.workspaceHeadPath(root, renderId, context), 'React UI workspace head', 'file',
      );
      const encoded = JSON.parse(await readFile(path, 'utf8')) as ReactUiWorkspaceHead | ReactUiAuthenticatedRecord<ReactUiWorkspaceHead>;
      const value = await this.openExecutableRecord(encoded, 'workspace-head');
      if (value.schemaVersion !== 1 || value.scopeKey !== scopeKey(context) ||
        value.id !== renderId || value.renderId !== renderId || !isDigest(value.componentId) || !isIsoTimestamp(value.activatedAt)) {
        throw new Error('React UI workspace head validation failed');
      }
      const component = await this.readCurrentComponentUnlocked(root, value.componentId, context);
      if (!component) throw new Error('React UI workspace head component is not published');
      if (!componentMatchesWorkspaceRender(component, render)) {
        throw new Error('React UI workspace head does not match its render recipe');
      }
      return value.componentId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async putWorkspaceHead(
    renderId: string,
    componentId: string,
    context: InvocationContext,
  ): Promise<void> {
    await this.withScopeExecutableMutation(context, async (root) => {
      const render = await this.readCurrentRenderUnlocked(root, renderId, context);
      const component = await this.readCurrentComponentUnlocked(root, componentId, context);
      if (!render || !component) {
        throw new Error('React UI workspace head requires published render and component records');
      }
      if (!componentMatchesWorkspaceRender(component, render)) {
        throw new Error('React UI workspace head does not match its render recipe');
      }
      const value: ReactUiWorkspaceHead = {
        schemaVersion: 1, id: renderId, scopeKey: scopeKey(context), renderId, componentId,
        activatedAt: new Date().toISOString(),
      };
      await this.replaceJson(
        root,
        this.workspaceHeadPath(root, renderId, context),
        await this.sealExecutableRecord('workspace-head', value),
      );
    });
  }

  async putRender(
    render: Omit<ReactUiRender, 'scopeKey'>,
    context: InvocationContext,
  ): Promise<ReactUiRender> {
    const value = { ...render, scopeKey: scopeKey(context) };
    const existing = await this.tryReadRender(value.id, context);
    if (existing) return existing;
    return this.withScopeExecutableMutation(context, (root) =>
      this.putRenderUnlocked(root, value, context));
  }

  async getRender(id: string, context: InvocationContext): Promise<ReactUiRender> {
    assertDigestId(id, 'renderId');
    const value = await this.tryReadRender(id, context);
    if (!value) throw new Error(`React UI render ${id} was not found in this scope`);
    return value;
  }

  async listRenders(context: InvocationContext): Promise<ReactUiRender[]> {
    const root = await this.root();
    return this.listJson(root, this.directory(root, context, 'renders'), (id) =>
      this.getRender(id, context),
    );
  }

  async findRenderByToolName(
    toolName: string,
    context: InvocationContext,
  ): Promise<ReactUiRender | undefined> {
    const renders = await this.listRenders(context);
    return renders.find((render) => render.toolName === toolName);
  }

  async get(
    key: string,
    scope: UiStateScope,
    context: InvocationContext,
  ): Promise<UiActionIdempotencyRecord | undefined> {
    assertDigestId(key, 'UI action idempotency key');
    const root = await this.root();
    try {
      const safePath = await resolveContainedExistingPath(
        root,
        this.actionResultPath(root, key, scope, context),
        'React UI action result',
        'file',
      );
      const raw = await readFile(safePath, 'utf8');
      if (Buffer.byteLength(raw) > (this.options.maxActionResultBytes ?? 1_048_576)) {
        throw new Error('React UI action result exceeds its configured byte limit');
      }
      const value = JSON.parse(raw) as Partial<ReactUiStoredActionResult>;
      if (
        value.key !== key ||
        value.scope !== scope ||
        value.scopeKey !== stateScopeKey(context, scope) ||
        !/^[a-f0-9]{64}$/.test(value.requestDigest ?? '') ||
        !value.result ||
        typeof value.result !== 'object'
      ) {
        throw new Error('React UI action result validation failed');
      }
      // Pre-atomic releases could persist terminal failures. They are not
      // replayable and must not permanently poison the operation key.
      if (value.result.status !== 'success') {
        await unlink(safePath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
        return undefined;
      }
      return { requestDigest: value.requestDigest!, result: value.result };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async put(
    key: string,
    scope: UiStateScope,
    record: UiActionIdempotencyRecord,
    context: InvocationContext,
  ): Promise<void> {
    assertDigestId(key, 'UI action idempotency key');
    assertDigestId(record.requestDigest, 'UI action request digest');
    const root = await this.root();
    const path = this.actionResultPath(root, key, scope, context);
    const previousWrite = this.actionWrites.get(path) ?? Promise.resolve();
    const next = previousWrite.then(async () => {
      const existing = await this.get(key, scope, context);
      if (existing) {
        if (existing.requestDigest !== record.requestDigest) {
          throw new Error('UI action idempotency key was reused with a different request');
        }
        return;
      }
      const directory = dirname(path);
      const entries = await this.listFileNames(root, directory);
      if (entries.length >= (this.options.maxActionResultsPerScope ?? 1_000)) {
        throw new Error('React UI action result scope limit reached');
      }
      const value: ReactUiStoredActionResult = {
        scopeKey: stateScopeKey(context, scope),
        key,
        scope,
        requestDigest: record.requestDigest,
        result: record.result,
        createdAt: new Date().toISOString(),
      };
      const encoded = `${JSON.stringify(value, null, 2)}\n`;
      if (Buffer.byteLength(encoded) > (this.options.maxActionResultBytes ?? 1_048_576)) {
        throw new Error('React UI action result exceeds its configured byte limit');
      }
      await ensureContainedDirectory(root, directory, 'React UI action result directory');
      await assertContainedFileTarget(root, path, 'React UI action result');
      try {
        await writeFile(path, encoded, { encoding: 'utf8', flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const raced = await this.get(key, scope, context);
        if (!raced || raced.requestDigest !== record.requestDigest) {
          throw new Error('UI action idempotency key was reused with a different request');
        }
      }
    });
    this.actionWrites.set(path, next);
    try {
      await next;
    } finally {
      if (this.actionWrites.get(path) === next) this.actionWrites.delete(path);
    }
  }

  async claim(
    key: string,
    scope: UiStateScope,
    requestDigest: string,
    leaseMs: number,
    context: InvocationContext,
  ): Promise<UiActionIdempotencyClaim> {
    assertDigestId(key, 'UI action idempotency key');
    assertDigestId(requestDigest, 'UI action request digest');
    assertLeaseDuration(leaseMs);
    const root = await this.root();
    const activeLease = ACTIVE_ACTION_LEASES.get(actionLeaseToken(root, key, scope, context));
    if (activeLease) {
      if (activeLease.requestDigest !== requestDigest) {
        throw new Error('UI action idempotency key was reused with a different request');
      }
      return {
        status: 'busy',
        retryAfterMs: Math.max(
          ACTION_TRANSACTION_POLL_MS,
          Math.max(0, Date.parse(activeLease.expiresAt) - Date.now()),
        ),
      };
    }
    const capacityKey =
      key === ACTION_CAPACITY_TRANSACTION_KEY
        ? digest(`${ACTION_CAPACITY_TRANSACTION_KEY}\0alternate`)
        : ACTION_CAPACITY_TRANSACTION_KEY;
    return this.withActionTransaction(capacityKey, scope, context, () =>
      this.withActionTransaction(key, scope, context, async (root) => {
        const path = this.actionLeasePath(root, key, scope, context);
        const completed = await this.get(key, scope, context);
        if (completed) {
          await this.removeLease(path);
          if (completed.requestDigest !== requestDigest) {
            throw new Error('UI action idempotency key was reused with a different request');
          }
          return { status: 'replay', record: completed };
        }

        const journal = await this.readActionJournal(root, key, scope, context);
        if (journal && journal.requestDigest !== requestDigest) {
          throw new Error('UI action idempotency key was reused with a different request');
        }
        const activeAttempt = journal?.activeReceiptId
          ? journal.attempts.find((attempt) => attempt.receiptId === journal.activeReceiptId)
          : undefined;
        if (activeAttempt) {
          const activeInThisProcess = activeAttempt.ownerPid === process.pid &&
            ACTIVE_ACTION_ATTEMPTS.has(actionAttemptToken(root, key, scope, context, activeAttempt.receiptId));
          if (activeInThisProcess) {
            return {
              status: 'busy',
              retryAfterMs: Math.max(
                ACTION_TRANSACTION_POLL_MS,
                activeAttempt.leaseExpiresAt
                  ? Math.max(0, Date.parse(activeAttempt.leaseExpiresAt) - Date.now())
                  : 25,
              ),
            };
          }
        }

        const current = await this.readLease(root, path, key, scope, context);
        if (current) {
          if (current.requestDigest !== requestDigest) {
            throw new Error('UI action idempotency key was reused with a different request');
          }
          const expiresIn = Date.parse(current.expiresAt) - Date.now();
          if (expiresIn > 0) return { status: 'busy', retryAfterMs: expiresIn };
          const legacyGrace = staleTakeoverAt(current) - Date.now();
          if (current.ownerPid === undefined && legacyGrace > 0) {
            return { status: 'busy', retryAfterMs: legacyGrace };
          }
        }

        const resultDirectory = dirname(this.actionResultPath(root, key, scope, context));
        const leaseDirectory = dirname(path);
        const [results, leases, journals] = await Promise.all([
          this.listFileNames(root, resultDirectory),
          this.listFileNames(root, leaseDirectory),
          this.listActionJournalNames(root, this.actionJournalDirectory(root, scope, context)),
        ]);
        const reserved =
          results.length +
          leases.length +
          journals.length -
          (current ? 1 : 0) -
          (journal ? 1 : 0);
        if (reserved >= (this.options.maxActionResultsPerScope ?? 1_000)) {
          throw new Error('React UI action result scope limit reached before execution');
        }

        const now = Date.now();
        const lease: ReactUiStoredActionLease = {
          scopeKey: stateScopeKey(context, scope),
          key,
          scope,
          ownerId: randomUUID(),
          requestDigest,
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + leaseMs).toISOString(),
          leaseDurationMs: leaseMs,
          ownerPid: process.pid,
        };
        await this.replaceLease(root, path, lease);
        return { status: 'acquired', lease };
      }),
    );
  }

  async renew(
    key: string,
    scope: UiStateScope,
    lease: UiActionIdempotencyLease,
    leaseMs: number,
    context: InvocationContext,
  ): Promise<UiActionIdempotencyLease | undefined> {
    assertLeaseDuration(leaseMs);
    const renewalDeadline = Date.parse(lease.expiresAt);
    if (!Number.isFinite(renewalDeadline)) {
      throw new Error('UI action idempotency lease expiration validation failed');
    }
    return this.withActionTransaction(key, scope, context, async (root) => {
      const path = this.actionLeasePath(root, key, scope, context);
      const current = await this.readLease(root, path, key, scope, context);
      if (
        !current ||
        current.ownerId !== lease.ownerId ||
        current.requestDigest !== lease.requestDigest
      ) return undefined;
      const renewed: ReactUiStoredActionLease = {
        ...current,
        expiresAt: new Date(Date.now() + leaseMs).toISOString(),
        leaseDurationMs: leaseMs,
      };
      await this.replaceLease(root, path, renewed);
      const token = actionLeaseToken(root, key, scope, context);
      const activeLease = ACTIVE_ACTION_LEASES.get(token);
      if (
        activeLease?.ownerId === renewed.ownerId &&
        activeLease.requestDigest === renewed.requestDigest
      ) {
        ACTIVE_ACTION_LEASES.set(token, {
          ownerId: renewed.ownerId,
          requestDigest: renewed.requestDigest,
          expiresAt: renewed.expiresAt,
        });
      }
      return renewed;
    }, renewalDeadline);
  }

  async complete(
    key: string,
    scope: UiStateScope,
    lease: UiActionIdempotencyLease,
    record: UiActionIdempotencyRecord,
    context: InvocationContext,
  ): Promise<UiActionIdempotencyRecord> {
    if (record.result.status !== 'success') {
      throw new Error('Only successful UI action results may be completed');
    }
    if (record.requestDigest !== lease.requestDigest) {
      throw new Error('UI action completion digest does not match its lease');
    }
    return this.withActionTransaction(key, scope, context, async (root) => {
      const path = this.actionLeasePath(root, key, scope, context);
      const current = await this.readLease(root, path, key, scope, context);
      if (
        !current ||
        current.ownerId !== lease.ownerId ||
        current.requestDigest !== lease.requestDigest
      ) {
        throw new Error('UI action idempotency lease was lost before completion');
      }
      await this.putActionResult(key, scope, record, context);
      const completed = await this.get(key, scope, context);
      if (!completed) throw new Error('UI action idempotency completion was not persisted');
      await this.removeLease(path);
      const token = actionLeaseToken(root, key, scope, context);
      const activeLease = ACTIVE_ACTION_LEASES.get(token);
      if (
        activeLease?.ownerId === lease.ownerId &&
        activeLease.requestDigest === lease.requestDigest
      ) {
        ACTIVE_ACTION_LEASES.delete(token);
      }
      return completed;
    });
  }

  async release(
    key: string,
    scope: UiStateScope,
    lease: UiActionIdempotencyLease,
    context: InvocationContext,
  ): Promise<void> {
    await this.withActionTransaction(key, scope, context, async (root) => {
      const path = this.actionLeasePath(root, key, scope, context);
      const journal = await this.readActionJournal(root, key, scope, context);
      const active = journal?.activeReceiptId
        ? journal.attempts.find((attempt) => attempt.receiptId === journal.activeReceiptId)
        : undefined;
      if (active?.ownerId === lease.ownerId) {
        ACTIVE_ACTION_ATTEMPTS.delete(
          actionAttemptToken(root, key, scope, context, active.receiptId),
        );
      }
      const token = actionLeaseToken(root, key, scope, context);
      const activeLease = ACTIVE_ACTION_LEASES.get(token);
      if (
        activeLease?.ownerId === lease.ownerId &&
        activeLease.requestDigest === lease.requestDigest
      ) {
        ACTIVE_ACTION_LEASES.delete(token);
      }
      const current = await this.readLease(root, path, key, scope, context);
      if (
        !current ||
        current.ownerId !== lease.ownerId ||
        current.requestDigest !== lease.requestDigest
      ) return;
      await this.removeLease(path);
    });
  }

  async begin(
    key: string,
    scope: UiStateScope,
    attempt: UiActionJournalAttempt,
    context: InvocationContext,
  ): Promise<UiActionJournalAttempt> {
    assertDigestId(key, 'UI action journal key');
    assertActionJournalAttempt(attempt, scope, context);
    if (attempt.phase !== 'pending' || attempt.result) {
      throw new Error('UI action journal begin requires a pending attempt');
    }
    return this.withActionTransaction(key, scope, context, async (root) => {
      const journal = await this.readActionJournal(root, key, scope, context);
      if (journal && journal.requestDigest !== attempt.requestDigest) {
        throw new Error('UI action idempotency key was reused with a different request');
      }
      const active = journal?.activeReceiptId
        ? journal.attempts.find((candidate) => candidate.receiptId === journal.activeReceiptId)
        : undefined;
      if (active?.phase === 'terminal' && active.result?.status === 'success') {
        return active;
      }
      if (active?.phase === 'pending') {
        const resumed: UiActionJournalAttempt = {
          ...active,
          ...(attempt.ownerId ? { ownerId: attempt.ownerId } : {}),
          ownerPid: process.pid,
          ...(attempt.leaseExpiresAt ? { leaseExpiresAt: attempt.leaseExpiresAt } : {}),
        };
        await this.appendActionJournalEvent(root, key, scope, {
          ...actionJournalEventBase(key, scope, active.requestDigest, context),
          type: 'resume',
          receiptId: active.receiptId,
          ...(resumed.ownerId ? { ownerId: resumed.ownerId } : {}),
          ownerPid: resumed.ownerPid,
          ...(resumed.leaseExpiresAt ? { leaseExpiresAt: resumed.leaseExpiresAt } : {}),
        }, context);
        ACTIVE_ACTION_ATTEMPTS.add(actionAttemptToken(root, key, scope, context, active.receiptId));
        rememberActiveActionLease(root, key, scope, context, resumed);
        return resumed;
      }

      if ((journal?.attempts.length ?? 0) >= (this.options.maxActionAttemptsPerKey ?? 32)) {
        throw new Error('UI action journal attempt limit reached');
      }
      if (!journal) {
        const journals = await this.listActionJournalNames(
          root,
          this.actionJournalDirectory(root, scope, context),
        );
        if (journals.length >= (this.options.maxActionResultsPerScope ?? 1_000)) {
          throw new Error('UI action journal scope limit reached');
        }
      }
      const started: UiActionJournalAttempt = { ...attempt, ownerPid: process.pid };
      await this.appendActionJournalEvent(root, key, scope, {
        ...actionJournalEventBase(key, scope, started.requestDigest, context),
        type: 'begin',
        attempt: started,
      }, context);
      ACTIVE_ACTION_ATTEMPTS.add(actionAttemptToken(root, key, scope, context, started.receiptId));
      rememberActiveActionLease(root, key, scope, context, started);
      return started;
    });
  }

  async markLeaseLost(
    key: string,
    scope: UiStateScope,
    receiptId: string,
    error: { code: string; message: string },
    context: InvocationContext,
  ): Promise<void> {
    assertDigestId(key, 'UI action journal key');
    await this.withActionTransaction(key, scope, context, async (root) => {
      const journal = await this.readActionJournal(root, key, scope, context);
      if (!journal) return;
      const attempt = requireActionJournalAttempt(journal, receiptId);
      if (attempt.phase !== 'pending') return;
      await this.appendActionJournalEvent(root, key, scope, {
        ...actionJournalEventBase(key, scope, journal.requestDigest, context),
        type: 'lease_lost',
        receiptId,
        error: boundedJournalError(error),
      }, context);
    });
  }

  async terminalize(
    key: string,
    scope: UiStateScope,
    receiptId: string,
    result: UiActionResult,
    context: InvocationContext,
  ): Promise<void> {
    assertDigestId(key, 'UI action journal key');
    try {
      await this.withActionTransaction(key, scope, context, async (root) => {
        const journal = await this.requireActionJournal(root, key, scope, context);
        const attempt = requireActionJournalAttempt(journal, receiptId);
        if (attempt.phase === 'terminal') {
          if (stableStringify(attempt.result) !== stableStringify(result)) {
            throw new Error('UI action journal terminal result does not match');
          }
          return;
        }
        if (
          result.receipt.receiptId !== receiptId ||
          result.receipt.requestDigest !== journal.requestDigest
        ) {
          throw new Error('UI action journal completion does not match its pending root');
        }
        await this.appendActionJournalEvent(root, key, scope, {
          ...actionJournalEventBase(key, scope, journal.requestDigest, context),
          type: 'complete',
          receiptId,
          result,
        }, context);
      });
    } finally {
      if (result.status !== 'success') {
        const root = await this.root();
        ACTIVE_ACTION_ATTEMPTS.delete(actionAttemptToken(root, key, scope, context, receiptId));
      }
    }
  }

  async close(
    key: string,
    scope: UiStateScope,
    receiptId: string,
    context: InvocationContext,
  ): Promise<void> {
    assertDigestId(key, 'UI action journal key');
    await this.withActionTransaction(key, scope, context, async (root) => {
      const journal = await this.readActionJournal(root, key, scope, context);
      if (!journal) return;
      const attempt = requireActionJournalAttempt(journal, receiptId);
      if (attempt.phase !== 'terminal' || attempt.result?.status !== 'success') {
        throw new Error('Only a terminal successful UI action root may be closed');
      }
      if (journal.activeReceiptId !== receiptId) return;
      await this.appendActionJournalEvent(root, key, scope, {
        ...actionJournalEventBase(key, scope, journal.requestDigest, context),
        type: 'close',
        receiptId,
      }, context);
      ACTIVE_ACTION_ATTEMPTS.delete(actionAttemptToken(root, key, scope, context, receiptId));
    });
  }

  async listReceipts(
    scope: UiStateScope,
    context: InvocationContext,
  ): Promise<readonly RuntimeExecutionReceipt[]> {
    const root = await this.root();
    const directory = this.actionJournalDirectory(root, scope, context);
    const names = await this.listActionJournalNames(root, directory);
    const receipts: RuntimeExecutionReceipt[] = [];
    for (const name of names) {
      const key = name.slice(0, -'.jsonl'.length);
      let journal = await this.readActionJournal(root, key, scope, context);
      if (!journal) continue;
      const currentJournal = journal;
      const active = currentJournal.activeReceiptId
        ? currentJournal.attempts.find((attempt) => attempt.receiptId === currentJournal.activeReceiptId)
        : undefined;
      if (active?.phase === 'pending' && !active.idempotencyKey) {
        await this.reconcileInterruptedUnkeyedAttempt(key, scope, active.receiptId, context);
        journal = await this.readActionJournal(root, key, scope, context);
        if (!journal) continue;
      }
      for (const attempt of journal.attempts) {
        if (attempt.phase !== 'terminal' || !attempt.result) continue;
        receipts.push(actionRootExecutionReceipt(attempt.result));
        if (attempt.result.receipt.targetReceipt) {
          receipts.push(attempt.result.receipt.targetReceipt);
        }
      }
    }
    return receipts.sort(
      (left, right) =>
        left.startedAt.localeCompare(right.startedAt) ||
        left.executionId.localeCompare(right.executionId),
    );
  }

  private async reconcileInterruptedUnkeyedAttempt(
    key: string,
    scope: UiStateScope,
    receiptId: string,
    context: InvocationContext,
  ): Promise<void> {
    await this.withActionTransaction(key, scope, context, async (root) => {
      const journal = await this.readActionJournal(root, key, scope, context);
      if (!journal) return;
      const active = journal.activeReceiptId === receiptId
        ? journal.attempts.find((attempt) => attempt.receiptId === receiptId)
        : undefined;
      if (!active || active.phase !== 'pending' || active.idempotencyKey) return;
      const activeInThisProcess = active.ownerPid === process.pid &&
        ACTIVE_ACTION_ATTEMPTS.has(actionAttemptToken(root, key, scope, context, active.receiptId));
      const leasePath = this.actionLeasePath(root, key, scope, context);
      const lease = await this.readLease(root, leasePath, key, scope, context);
      if (lease && lease.requestDigest !== active.requestDigest) {
        throw new Error('UI action journal ownership lease does not match its pending root');
      }
      if (activeInThisProcess || (lease && Date.parse(lease.expiresAt) > Date.now())) return;
      const interrupted = interruptedActionResult(active);
      await this.appendActionJournalEvent(root, key, scope, {
        ...actionJournalEventBase(key, scope, journal.requestDigest, context),
        type: 'complete',
        receiptId,
        result: interrupted,
      }, context);
      ACTIVE_ACTION_ATTEMPTS.delete(
        actionAttemptToken(root, key, scope, context, active.receiptId),
      );
      await this.removeLease(leasePath);
    });
  }

  async getRenderState(
    renderId: string,
    context: InvocationContext,
  ): Promise<Record<string, string>> {
    return { ...(await this.getApplicationState(renderId, context)).local.values };
  }

  async getApplicationState(
    renderId: string,
    context: InvocationContext,
  ): Promise<UiApplicationStateSnapshot> {
    const render = await this.getRender(renderId, context);
    const root = await this.root();
    const scope = render.application?.localState?.scope ?? 'project';
    const schemaVersion = render.application?.localState?.schemaVersion ?? '1.0.0';
    const state = await this.tryReadState(root, render, context);
    return {
      local: state
        ? { scope: state.scope, schemaVersion: state.schemaVersion, version: state.version, values: { ...state.values }, updatedAt: state.updatedAt }
        : { scope, schemaVersion, version: 0, values: {} },
      ...(render.application?.authoritativeState
        ? { authoritative: { ...render.application.authoritativeState } }
        : {}),
    };
  }

  async mutateRenderState(
    renderId: string,
    mutation: ReactUiStorageMutation,
    context: InvocationContext,
  ): Promise<Record<string, string>> {
    const render = await this.getRender(renderId, context);
    const root = await this.root();
    const scope = render.application?.localState?.scope ?? 'project';
    const schemaVersion = render.application?.localState?.schemaVersion ?? '1.0.0';
    const path = this.statePath(root, renderId, context, scope);
    const previous = this.stateWrites.get(path) ?? Promise.resolve(undefined);
    const next = previous.then(async () => {
      const current = await this.tryReadState(root, render, context);
      if (mutation.expectedVersion !== undefined && mutation.expectedVersion !== (current?.version ?? 0)) {
        throw new Error(`React UI state version conflict: expected ${mutation.expectedVersion}, found ${current?.version ?? 0}`);
      }
      const values = { ...(current?.values ?? {}) };
      if (mutation.operation === 'clear') {
        for (const key of Object.keys(values)) delete values[key];
      } else {
        assertStorageKey(mutation.key);
        if (mutation.operation === 'remove') delete values[mutation.key];
        else values[mutation.key] = boundedStorageValue(mutation.value);
      }
      assertStorageSize(values);
      const state: ReactUiStoredState = {
        scopeKey: stateScopeKey(context, scope),
        renderId,
        scope,
        schemaVersion,
        version: (current?.version ?? 0) + 1,
        values,
        updatedAt: new Date().toISOString(),
      };
      await ensureContainedDirectory(root, dirname(path), 'React UI state directory');
      await assertContainedFileTarget(root, path, 'React UI state record');
      await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      return state;
    });
    this.stateWrites.set(path, next);
    try {
      return { ...(await next).values };
    } finally {
      if (this.stateWrites.get(path) === next) this.stateWrites.delete(path);
    }
  }

  private async tryReadComponent(
    id: string,
    context: InvocationContext,
  ): Promise<CompiledReactComponent | undefined> {
    const root = await this.root();
    const current = await this.readCurrentComponentUnlocked(root, id, context);
    if (current) return current;
    const legacy = await this.findLegacyRecord<CompiledReactComponent>(
      root,
      'components',
      id,
      (value) => {
        assertStoredComponent(value, id, value.scopeKey);
        return true;
      },
    );
    if (!legacy) return undefined;
    const migrated = { ...legacy, scopeKey: scopeKey(context) };
    assertStoredComponent(migrated, id, scopeKey(context));
    return this.withScopeExecutableMutation(context, (lockedRoot) =>
      this.putComponentUnlocked(lockedRoot, migrated, context));
  }

  private async tryReadRender(
    id: string,
    context: InvocationContext,
  ): Promise<ReactUiRender | undefined> {
    const root = await this.root();
    const current = await this.readCurrentRenderUnlocked(root, id, context);
    if (current) return current;
    const legacy = await this.findLegacyRecord<ReactUiRender>(
      root,
      'renders',
      id,
      (value) => {
        assertStoredRender(value, id, value.scopeKey);
        return true;
      },
    );
    if (!legacy) return undefined;
    const migrated = { ...legacy, scopeKey: scopeKey(context) };
    assertStoredRender(migrated, id, scopeKey(context));
    return this.withScopeExecutableMutation(context, (lockedRoot) =>
      this.putRenderUnlocked(lockedRoot, migrated, context));
  }

  private async putComponentUnlocked(
    root: string,
    value: CompiledReactComponent,
    context: InvocationContext,
  ): Promise<CompiledReactComponent> {
    const current = await this.readCurrentComponentUnlocked(root, value.id, context);
    if (current) return current;
    const limit = this.options.maxComponentsPerScope ?? 100;
    let count = (await this.listFileNames(root, this.directory(root, context, 'components'))).length;
    if (count >= limit) {
      await this.reclaimWorkspaceComponentsUnlocked(root, context, Math.max(0, limit - 1));
      count = (await this.listFileNames(root, this.directory(root, context, 'components'))).length;
    }
    if (count >= limit) throw new Error('Compiled UI component scope limit reached');
    assertStoredComponent(value, value.id, scopeKey(context));
    await this.writeExecutableRecord(root, this.componentPath(root, value.id, context), 'component', value);
    const stored = await this.readCurrentComponentUnlocked(root, value.id, context);
    if (!stored) throw new Error('Compiled React UI component publication failed');
    return stored;
  }

  private async putRenderUnlocked(
    root: string,
    value: ReactUiRender,
    context: InvocationContext,
  ): Promise<ReactUiRender> {
    const current = await this.readCurrentRenderUnlocked(root, value.id, context);
    if (current) return current;
    const count = (await this.listFileNames(root, this.directory(root, context, 'renders'))).length;
    if (count >= (this.options.maxRendersPerScope ?? 200)) {
      throw new Error('React UI render scope limit reached');
    }
    let component = await this.readCurrentComponentUnlocked(root, value.componentId, context);
    if (!component) {
      const legacy = await this.findLegacyRecord<CompiledReactComponent>(
        root, 'components', value.componentId,
        (candidate) => {
          assertStoredComponent(candidate, value.componentId, candidate.scopeKey);
          return true;
        },
      );
      if (legacy) {
        component = await this.putComponentUnlocked(
          root,
          { ...legacy, scopeKey: scopeKey(context) },
          context,
        );
      }
    }
    if (!component) throw new Error(`Compiled UI component ${value.componentId} was not found in this scope`);
    assertStoredRender(value, value.id, scopeKey(context));
    await this.writeExecutableRecord(root, this.renderPath(root, value.id, context), 'render', value);
    const stored = await this.readCurrentRenderUnlocked(root, value.id, context);
    if (!stored) throw new Error('React UI render publication failed');
    return stored;
  }

  private async readCurrentComponentUnlocked(
    root: string,
    id: string,
    context: InvocationContext,
  ): Promise<CompiledReactComponent | undefined> {
    const current = await this.tryRead<CompiledReactComponent>(
      root, this.componentPath(root, id, context), context, 'component',
    );
    if (current) assertStoredComponent(current, id, scopeKey(context));
    return current;
  }

  private async readCurrentRenderUnlocked(
    root: string,
    id: string,
    context: InvocationContext,
  ): Promise<ReactUiRender | undefined> {
    const current = await this.tryRead<ReactUiRender>(
      root, this.renderPath(root, id, context), context, 'render',
    );
    if (current) assertStoredRender(current, id, scopeKey(context));
    return current;
  }

  private async tryReadState(
    root: string,
    render: ReactUiRender,
    context: InvocationContext,
  ): Promise<ReactUiStoredState | undefined> {
    const renderId = render.id;
    const scope = render.application?.localState?.scope ?? 'project';
    const schemaVersion = render.application?.localState?.schemaVersion ?? '1.0.0';
    let state: ReactUiStoredState | undefined;
    try {
      const safePath = await resolveContainedExistingPath(
        root,
        this.statePath(root, renderId, context, scope),
        'React UI state record',
        'file',
      );
      const raw = JSON.parse(await readFile(safePath, 'utf8')) as Partial<ReactUiStoredState>;
      state = normalizeStoredState(raw, renderId, scope, schemaVersion, context);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!state) {
      const legacy = await this.findLegacyRecord<ReactUiStoredState>(
        root,
        'state',
        renderId,
        (value) => value.renderId === renderId && isStringRecord(value.values),
        (left, right) => right.updatedAt.localeCompare(left.updatedAt),
      );
      if (legacy) {
        state = normalizeStoredState(legacy, renderId, scope, schemaVersion, context);
        await this.writeImmutable(root, this.statePath(root, renderId, context, scope), state);
      }
    }
    if (!state) return undefined;
    if (state.renderId !== renderId || state.scopeKey !== stateScopeKey(context, scope) || !isStringRecord(state.values)) {
      throw new Error('React UI state validation failed');
    }
    assertStorageSize(state.values);
    return state;
  }

  private async findLegacyRecord<T extends { scopeKey: string }>(
    root: string,
    kind: 'components' | 'renders' | 'state',
    id: string,
    validate: (value: T) => boolean,
    order?: (left: T, right: T) => number,
  ): Promise<T | undefined> {
    if (!this.options.recoverLegacySessionScopes) return undefined;
    if (this.options.recordAuthenticator && this.options.unsignedRecordPolicy !== 'content-only') {
      return undefined;
    }
    const scopesDirectory = resolve(root, 'scopes');
    let scopeEntries: Dirent[];
    try {
      const safeScopesDirectory = await resolveContainedExistingPath(
        root,
        scopesDirectory,
        'React UI scopes directory',
        'directory',
      );
      scopeEntries = await readdir(safeScopesDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }

    const candidates: T[] = [];
    for (const entry of scopeEntries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
      const target = resolve(scopesDirectory, entry.name, kind, `${id}.json`);
      try {
        const safePath = await resolveContainedExistingPath(
          root,
          target,
          'Legacy React UI record',
          'file',
        );
        const value = JSON.parse(await readFile(safePath, 'utf8')) as T;
        if (value.scopeKey !== entry.name || !validate(value)) {
          throw new Error('Legacy React UI record validation failed');
        }
        candidates.push(value);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    candidates.sort(order);
    return candidates[0];
  }

  private async tryRead<T extends { id: string; scopeKey: string }>(
    root: string,
    path: string,
    context: InvocationContext,
    kind: ReactUiExecutableRecordKind,
  ): Promise<T | undefined> {
    try {
      const safePath = await resolveContainedExistingPath(root, path, 'React UI record', 'file');
      const stored = JSON.parse(await readFile(safePath, 'utf8')) as T | ReactUiAuthenticatedRecord<T>;
      const value = await this.openExecutableRecord(stored, kind);
      if (value.scopeKey !== scopeKey(context)) throw new Error('React UI scope validation failed');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async listJson<T>(
    root: string,
    directory: string,
    load: (id: string) => Promise<T>,
  ): Promise<T[]> {
    let files: string[];
    try {
      const safeDirectory = await resolveContainedExistingPath(
        root,
        directory,
        'React UI record directory',
        'directory',
      );
      files = await readdir(safeDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return Promise.all(
      files.filter((file) => /^[a-f0-9]{64}\.json$/.test(file)).map((file) => load(file.slice(0, -5))),
    );
  }

  private async listFileNames(root: string, directory: string): Promise<string[]> {
    try {
      const safeDirectory = await resolveContainedExistingPath(
        root,
        directory,
        'React UI record directory',
        'directory',
      );
      return (await readdir(safeDirectory)).filter((file) => /^[a-f0-9]{64}\.json$/.test(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async listActionJournalNames(root: string, directory: string): Promise<string[]> {
    try {
      const safeDirectory = await resolveContainedExistingPath(
        root,
        directory,
        'React UI action journal directory',
        'directory',
      );
      return (await readdir(safeDirectory)).filter((file) => /^[a-f0-9]{64}\.jsonl$/.test(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async requireActionJournal(
    root: string,
    key: string,
    scope: UiStateScope,
    context: InvocationContext,
  ): Promise<ReactUiStoredActionJournal> {
    const journal = await this.readActionJournal(root, key, scope, context);
    if (!journal) throw new Error('UI action journal root was not found');
    return journal;
  }

  private async readActionJournal(
    root: string,
    key: string,
    scope: UiStateScope,
    context: InvocationContext,
  ): Promise<ReactUiStoredActionJournal | undefined> {
    const path = this.actionJournalPath(root, key, scope, context);
    let raw: string;
    try {
      const safePath = await resolveContainedExistingPath(
        root,
        path,
        'React UI action journal',
        'file',
      );
      raw = await readFile(safePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (Buffer.byteLength(raw) > (this.options.maxActionJournalBytes ?? 16_777_216)) {
      throw new Error('React UI action journal exceeds its configured byte limit');
    }
    const lines = raw.split('\n');
    const events: ReactUiStoredActionJournalEvent[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!.trim();
      if (!line) continue;
      try {
        const event = JSON.parse(line) as ReactUiStoredActionJournalEvent;
        assertActionJournalEvent(event, key, scope, context);
        events.push(event);
      } catch (error) {
        if (index === lines.length - 1 && !raw.endsWith('\n')) break;
        throw error;
      }
    }
    if (events.length === 0) return undefined;
    return replayActionJournal(events);
  }

  private async appendActionJournalEvent(
    root: string,
    key: string,
    scope: UiStateScope,
    event: ReactUiStoredActionJournalEvent,
    context: InvocationContext,
  ): Promise<void> {
    assertActionJournalEvent(event, key, scope, context);
    const path = this.actionJournalPath(root, key, scope, context);
    const directory = dirname(path);
    await ensureContainedDirectory(root, directory, 'React UI action journal directory');
    await assertContainedFileTarget(root, path, 'React UI action journal');
    let previous = '';
    try {
      previous = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (previous && !previous.endsWith('\n')) {
      const lastComplete = previous.lastIndexOf('\n');
      await truncate(path, lastComplete < 0 ? 0 : lastComplete + 1);
      previous = lastComplete < 0 ? '' : previous.slice(0, lastComplete + 1);
    }
    const encoded = `${JSON.stringify(event)}\n`;
    if (
      Buffer.byteLength(previous) + Buffer.byteLength(encoded) >
      (this.options.maxActionJournalBytes ?? 16_777_216)
    ) {
      throw new Error('React UI action journal exceeds its configured byte limit');
    }
    await writeFile(path, encoded, { encoding: 'utf8', flag: 'a' });
  }

  private async listCurrentRendersUnlocked(
    root: string,
    context: InvocationContext,
  ): Promise<ReactUiRender[]> {
    return this.listJson(root, this.directory(root, context, 'renders'), async (id) => {
      const render = await this.readCurrentRenderUnlocked(root, id, context);
      if (!render) throw new Error(`React UI render ${id} disappeared during enumeration`);
      return render;
    });
  }

  private async listCurrentComponentsBestEffortUnlocked(
    root: string,
    context: InvocationContext,
  ): Promise<CompiledReactComponent[]> {
    const files = await this.listFileNames(root, this.directory(root, context, 'components'));
    const values = await Promise.all(files.map((file) =>
      this.readCurrentComponentUnlocked(root, file.slice(0, -5), context).catch(() => undefined),
    ));
    return values.filter((value): value is CompiledReactComponent => value !== undefined);
  }

  private async reclaimWorkspaceComponentsUnlocked(
    root: string,
    context: InvocationContext,
    targetCount: number,
  ): Promise<void> {
    let renders: ReactUiRender[];
    try {
      renders = await this.listCurrentRendersUnlocked(root, context);
    } catch {
      return;
    }
    const protectedIds = new Set(renders.map((render) => render.componentId));
    for (const render of renders.filter((candidate) => candidate.workspace)) {
      try {
        const head = await this.readCurrentWorkspaceHeadUnlocked(root, render, context);
        if (head) protectedIds.add(head);
      } catch {
        return;
      }
    }
    const components = await this.listCurrentComponentsBestEffortUnlocked(root, context);
    const groups = new Map<string, CompiledReactComponent[]>();
    for (const component of components) {
      if (component.sourceKind !== 'workspace_file' || protectedIds.has(component.id)) continue;
      const key = stableStringify({
        sourcePath: component.sourcePath,
        title: component.title,
        description: component.description ?? '',
        profile: component.authoringProfile && {
          id: component.authoringProfile.id,
          version: component.authoringProfile.version,
        },
      });
      const group = groups.get(key) ?? [];
      group.push(component);
      groups.set(key, group);
    }
    const removable = [...groups.values()].flatMap((group) =>
      group.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)).slice(3),
    ).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    // This final reference snapshot is taken while the shared scope mutation
    // lock is held; putRender/putWorkspaceHead cannot create a new reference
    // between this check and unlink.
    const finalProtectedIds = new Set((await this.listCurrentRendersUnlocked(root, context)).map((render) => render.componentId));
    for (const render of renders.filter((candidate) => candidate.workspace)) {
      const head = await this.readCurrentWorkspaceHeadUnlocked(root, render, context).catch(() => undefined);
      if (head) finalProtectedIds.add(head);
    }
    let count = (await this.listFileNames(root, this.directory(root, context, 'components'))).length;
    for (const component of removable) {
      if (count <= targetCount) break;
      if (finalProtectedIds.has(component.id)) continue;
      const path = await resolveContainedExistingPath(
        root, this.componentPath(root, component.id, context), 'React UI reclaimable component', 'file',
      );
      await unlink(path);
      count -= 1;
    }
  }

  private async replaceJson(root: string, path: string, value: unknown): Promise<void> {
    const directory = dirname(path);
    await ensureContainedDirectory(root, directory, 'React UI record directory');
    await assertContainedFileTarget(root, path, 'React UI record');
    const temporaryPath = `${path}.write-${randomUUID()}`;
    await assertContainedFileTarget(root, temporaryPath, 'React UI replacement record');
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    try {
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await rename(temporaryPath, path);
    } finally {
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  private async writeImmutable(root: string, path: string, value: unknown): Promise<void> {
    await ensureContainedDirectory(root, dirname(path), 'React UI record directory');
    await assertContainedFileTarget(root, path, 'React UI record');
    try {
      await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A concurrent writer created the same content-addressed artifact.
      await resolveContainedExistingPath(root, path, 'React UI record', 'file');
    }
  }

  private async writeExecutableRecord<T extends { id: string; scopeKey: string }>(
    root: string,
    path: string,
    kind: ReactUiExecutableRecordKind,
    record: T,
  ): Promise<void> {
    await this.writeImmutable(root, path, await this.sealExecutableRecord(kind, record));
  }

  private async sealExecutableRecord<T extends { id: string; scopeKey: string }>(
    kind: ReactUiExecutableRecordKind,
    record: T,
  ): Promise<T | ReactUiAuthenticatedRecord<T>> {
    const authenticator = this.options.recordAuthenticator;
    if (!authenticator) return record;
    const payload = executableRecordPayload(kind, record);
    return {
      schemaVersion: 1,
      kind,
      record,
      seal: {
        schemaVersion: 1,
        authorityId: authenticator.authorityId,
        signature: await authenticator.sign(payload),
      },
    };
  }

  private async openExecutableRecord<T extends { id: string; scopeKey: string }>(
    value: T | ReactUiAuthenticatedRecord<T>,
    expectedKind: ReactUiExecutableRecordKind,
  ): Promise<T> {
    if (!isAuthenticatedRecord(value)) {
      if (this.options.recordAuthenticator && this.options.unsignedRecordPolicy !== 'content-only') {
        throw new Error('Unsigned React UI executable record is not trusted; recompile it with this harness');
      }
      return value;
    }
    if (value.kind !== expectedKind) throw new Error('React UI executable record kind validation failed');
    const authenticator = this.options.recordAuthenticator;
    if (!authenticator) {
      throw new Error('React UI executable record requires an unavailable host authority');
    }
    if (
      value.seal.schemaVersion !== 1 ||
      value.seal.authorityId !== authenticator.authorityId ||
      !await authenticator.verify(executableRecordPayload(value.kind, value.record), value.seal.signature)
    ) {
      throw new Error('React UI executable record authenticity validation failed');
    }
    return value.record;
  }

  private componentPath(root: string, id: string, context: InvocationContext): string {
    assertDigestId(id, 'componentId');
    return resolve(this.directory(root, context, 'components'), `${id}.json`);
  }

  private renderPath(root: string, id: string, context: InvocationContext): string {
    assertDigestId(id, 'renderId');
    return resolve(this.directory(root, context, 'renders'), `${id}.json`);
  }

  private statePath(root: string, id: string, context: InvocationContext, scope: UiStateScope): string {
    assertDigestId(id, 'renderId');
    return resolve(root, 'scopes', stateScopeKey(context, scope), 'state', `${id}.json`);
  }

  private actionResultPath(
    root: string,
    key: string,
    scope: UiStateScope,
    context: InvocationContext,
  ): string {
    assertDigestId(key, 'UI action idempotency key');
    return resolve(root, 'scopes', stateScopeKey(context, scope), 'action-results', `${key}.json`);
  }

  private actionLeasePath(
    root: string,
    key: string,
    scope: UiStateScope,
    context: InvocationContext,
  ): string {
    assertDigestId(key, 'UI action idempotency key');
    return resolve(root, 'scopes', stateScopeKey(context, scope), 'action-leases', `${key}.json`);
  }

  private actionJournalDirectory(
    root: string,
    scope: UiStateScope,
    context: InvocationContext,
  ): string {
    return resolve(root, 'scopes', stateScopeKey(context, scope), 'action-journals');
  }

  private actionJournalPath(
    root: string,
    key: string,
    scope: UiStateScope,
    context: InvocationContext,
  ): string {
    assertDigestId(key, 'UI action journal key');
    return resolve(this.actionJournalDirectory(root, scope, context), `${key}.jsonl`);
  }

  private actionTransactionPath(
    root: string,
    key: string,
    scope: UiStateScope,
    context: InvocationContext,
  ): string {
    assertDigestId(key, 'UI action idempotency key');
    return resolve(root, 'scopes', stateScopeKey(context, scope), 'action-locks', `${key}.lock`);
  }

  private async withActionTransaction<T>(
    key: string,
    scope: UiStateScope,
    context: InvocationContext,
    operation: (root: string) => Promise<T>,
    deadline = Number.POSITIVE_INFINITY,
  ): Promise<T> {
    const root = await this.root();
    const transactionPath = this.actionTransactionPath(root, key, scope, context);
    const releaseQueue = await acquireActionTransactionTurn(transactionPath, deadline);
    try {
      const lock = await this.acquireActionTransaction(root, key, scope, context);
      try {
        await lock.assertHealthy();
        const result = await operation(root);
        await lock.assertHealthy();
        return result;
      } finally {
        await lock.release();
      }
    } finally {
      releaseQueue();
    }
  }

  private withScopeExecutableMutation<T>(
    context: InvocationContext,
    operation: (root: string) => Promise<T>,
  ): Promise<T> {
    return this.withActionTransaction(SCOPE_EXECUTABLE_MUTATION_KEY, 'project', context, operation);
  }

  private async acquireActionTransaction(
    root: string,
    key: string,
    scope: UiStateScope,
    context: InvocationContext,
  ): Promise<ReactUiActionTransactionLock> {
    const path = this.actionTransactionPath(root, key, scope, context);
    const directory = dirname(path);
    const timeoutMs = this.options.actionTransactionTimeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
      throw new Error('React UI action transaction timeout must be 100-60000 milliseconds');
    }
    const staleMs = this.options.actionTransactionStaleMs ?? Math.min(2_000, timeoutMs);
    if (!Number.isSafeInteger(staleMs) || staleMs < 50 || staleMs > timeoutMs) {
      throw new Error('React UI action transaction staleness must be 50 milliseconds through the transaction timeout');
    }
    const deadline = Date.now() + timeoutMs;
    await ensureContainedDirectory(root, directory, 'React UI action transaction directory');
    for (;;) {
      assertActionTransactionDeadline(deadline);
      const owner: ReactUiActionTransactionOwner = {
        ownerId: randomUUID(),
        pid: process.pid,
        createdAt: new Date().toISOString(),
      };
      const candidate = `${path}.candidate-${transactionOwnerKey(owner.ownerId)}`;
      assertContained(root, candidate, 'React UI action transaction candidate');
      await rm(candidate, { recursive: true, force: true });
      await mkdir(candidate);
      const candidateOwnerPath = resolve(candidate, actionTransactionOwnerFile(owner.ownerId));
      assertContained(root, candidateOwnerPath, 'React UI action transaction candidate owner');
      await writeFile(candidateOwnerPath, `${JSON.stringify(owner)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      try {
        if (await this.readActionTransactionObservation(root, path)) {
          throw Object.assign(new Error('React UI action transaction already exists'), {
            code: 'EEXIST',
          });
        }
        await rename(candidate, path);
      } catch (error) {
        await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
        if (!isRenameContention(error)) throw error;
        const observed = await this.readActionTransactionObservation(root, path);
        if (!observed) continue;
        if (Date.now() - observed.modifiedAt <= staleMs) {
          await actionTransactionDelay();
          continue;
        }

        const recoveryKey = transactionOwnerKey(observed.owner.ownerId);
        const recovered = `${path}.stale-${recoveryKey}`;
        const mutationGate = `${path}.gate-${recoveryKey}`;
        assertContained(root, recovered, 'React UI recovered action transaction');
        assertContained(root, mutationGate, 'React UI action recovery gate');
        try {
          await this.acquireActionTransactionMutationGate(mutationGate, timeoutMs, deadline);
        } catch (recoveryError) {
          if (isRenameContention(recoveryError)) continue;
          throw recoveryError;
        }
        try {
          const observedAgain = await this.readActionTransactionObservation(root, path);
          if (
            !observedAgain ||
            !sameActionTransactionOwner(observedAgain.owner, observed.owner) ||
            Date.now() - observedAgain.modifiedAt <= staleMs
          ) continue;
          try {
            await renameActionTransactionPath(path, recovered, deadline);
          } catch (recoveryError) {
            if (!isRenameContention(recoveryError)) throw recoveryError;
            continue;
          }
          const moved = await this.readActionTransactionObservation(root, recovered);
          if (!moved || !sameActionTransactionOwner(moved.owner, observed.owner)) {
            await restoreActionTransactionPath(recovered, path, deadline);
            throw new Error('React UI action transaction changed during recovery');
          }
          await rm(recovered, { recursive: true, force: true });
        } finally {
          await rm(mutationGate, { recursive: true, force: true }).catch(() => undefined);
        }
        continue;
      }
      const heartbeat = this.maintainActionTransaction(root, path, owner, staleMs);
      let released = false;
      return {
        assertHealthy: () => heartbeat.assertHealthy(),
        release: async () => {
          if (released) return;
          await heartbeat.stop();
          await this.releaseActionTransaction(root, path, owner, timeoutMs);
          released = true;
        },
      };
    }
  }

  private async releaseActionTransaction(
    root: string,
    path: string,
    owner: ReactUiActionTransactionOwner,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const mutationGate = `${path}.gate-${transactionOwnerKey(owner.ownerId)}`;
    const released = `${path}.released-${transactionOwnerKey(owner.ownerId)}`;
    assertContained(root, mutationGate, 'React UI action release gate');
    assertContained(root, released, 'React UI released action transaction');
    await this.acquireActionTransactionMutationGate(mutationGate, timeoutMs, deadline);
    try {
      const current = await this.readActionTransactionObservation(root, path);
      if (!current) return;
      if (!sameActionTransactionOwner(current.owner, owner)) {
        throw new Error('React UI action transaction lock was lost');
      }
      await renameActionTransactionPath(path, released, deadline);
      const moved = await this.readActionTransactionObservation(root, released);
      if (!moved || !sameActionTransactionOwner(moved.owner, owner)) {
        await restoreActionTransactionPath(released, path, deadline);
        throw new Error('React UI action transaction changed during release');
      }
      await rm(released, { recursive: true, force: true });
    } finally {
      await rm(mutationGate, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private maintainActionTransaction(
    root: string,
    path: string,
    owner: ReactUiActionTransactionOwner,
    staleMs: number,
  ): { assertHealthy(): Promise<void>; stop(): Promise<void> } {
    let stopped = false;
    let failure: Error | undefined;
    let pending: Promise<void> = Promise.resolve();
    const intervalMs = Math.max(1, Math.floor(staleMs / 3));
    const renew = async (): Promise<void> => {
      const current = await this.readActionTransactionObservation(root, path);
      if (!current || !sameActionTransactionOwner(current.owner, owner)) {
        throw new Error('React UI action transaction lock was lost');
      }
      const now = new Date();
      await utimes(resolve(path, actionTransactionOwnerFile(owner.ownerId)), now, now);
    };
    const timer = setInterval(() => {
      if (stopped || failure) return;
      pending = pending.then(renew).catch((error: unknown) => {
        failure = error instanceof Error ? error : new Error(String(error));
      });
    }, intervalMs);
    timer.unref?.();
    return {
      async assertHealthy() {
        await pending;
        if (failure) throw failure;
        await renew();
      },
      async stop() {
        stopped = true;
        clearInterval(timer);
        await pending;
        if (failure) throw failure;
      },
    };
  }

  private async acquireActionTransactionMutationGate(
    path: string,
    staleMs: number,
    deadline: number,
  ): Promise<void> {
    for (;;) {
      assertActionTransactionDeadline(deadline);
      try {
        await mkdir(path);
        return;
      } catch (error) {
        if (!isRenameContention(error)) throw error;
        try {
          const stat = await lstat(path);
          if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new Error('React UI action transaction mutation gate is unsafe');
          }
          if (Date.now() - stat.mtimeMs > staleMs) {
            await rm(path, { recursive: true, force: true });
            continue;
          }
        } catch (inspectionError) {
          if ((inspectionError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw inspectionError;
        }
        await actionTransactionDelay();
      }
    }
  }

  private async readActionTransactionObservation(
    root: string,
    path: string,
  ): Promise<ReactUiActionTransactionObservation | undefined> {
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        throw new Error('React UI action transaction is unsafe');
      }
      if (stat.isFile()) {
        const serialized = await readContainedFileStable(
          root,
          path,
          'Legacy React UI action transaction',
        );
        if (serialized === undefined) return undefined;
        return {
          owner: parseActionTransactionOwner(serialized),
          modifiedAt: stat.mtimeMs,
          kind: 'legacy-file',
        };
      }
      if (!stat.isDirectory()) {
        throw new Error('React UI action transaction is unsafe');
      }
      const entries = await readdir(path, { withFileTypes: true });
      if (entries.length === 0) {
        return {
          owner: incompleteActionTransactionOwner(stat.birthtimeMs),
          modifiedAt: stat.mtimeMs,
          kind: 'incomplete-directory',
        };
      }
      if (
        entries.length !== 1 ||
        !entries[0].isFile()
      ) {
        throw new Error('React UI action transaction ownership is ambiguous');
      }
      const ownerId = parseActionTransactionOwnerFile(entries[0].name);
      const ownerPath = resolve(path, entries[0].name);
      const ownerStat = await lstat(ownerPath);
      if (ownerStat.isSymbolicLink() || !ownerStat.isFile() || ownerStat.size > 4_096) {
        throw new Error('React UI action transaction owner is unsafe');
      }
      const serialized = await readContainedFileStable(
        root,
        ownerPath,
        'React UI action transaction owner',
      );
      if (serialized === undefined) return undefined;
      const owner = parseActionTransactionOwner(serialized);
      if (owner.ownerId !== ownerId) {
        throw new Error('React UI action transaction owner token does not match its path');
      }
      return {
        owner,
        modifiedAt: ownerStat.mtimeMs,
        kind: 'directory',
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async replaceLease(
    root: string,
    path: string,
    lease: ReactUiStoredActionLease,
  ): Promise<void> {
    const directory = dirname(path);
    await ensureContainedDirectory(root, directory, 'React UI action lease directory');
    await assertContainedFileTarget(root, path, 'React UI action lease');
    const temporaryPath = `${path}.write-${lease.ownerId}-${randomUUID()}`;
    await assertContainedFileTarget(root, temporaryPath, 'React UI replacement action lease');
    await writeFile(temporaryPath, `${JSON.stringify(lease, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    try {
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await rename(temporaryPath, path);
    } finally {
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  private async removeLease(path: string): Promise<void> {
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  private putActionResult(
    key: string,
    scope: UiStateScope,
    record: UiActionIdempotencyRecord,
    context: InvocationContext,
  ): Promise<void> {
    return this.put(key, scope, record, context);
  }

  private async readLease(
    root: string,
    path: string,
    key: string,
    scope: UiStateScope,
    context: InvocationContext,
  ): Promise<ReactUiStoredActionLease | undefined> {
    try {
      const safePath = await resolveContainedExistingPath(root, path, 'React UI action lease', 'file');
      const value = JSON.parse(await readFile(safePath, 'utf8')) as Partial<ReactUiStoredActionLease>;
      if (
        value.key !== key ||
        value.scope !== scope ||
        value.scopeKey !== stateScopeKey(context, scope) ||
        typeof value.ownerId !== 'string' ||
        !/^[0-9a-f-]{36}$/.test(value.ownerId) ||
        !/^[a-f0-9]{64}$/.test(value.requestDigest ?? '') ||
        !value.createdAt ||
        !Number.isFinite(Date.parse(value.createdAt)) ||
        !value.expiresAt ||
        !Number.isFinite(Date.parse(value.expiresAt)) ||
        (value.leaseDurationMs !== undefined &&
          (!Number.isSafeInteger(value.leaseDurationMs) || value.leaseDurationMs < 10 || value.leaseDurationMs > 3_600_000)) ||
        (value.ownerPid !== undefined && (!Number.isSafeInteger(value.ownerPid) || value.ownerPid <= 0))
      ) {
        throw new Error('React UI action lease validation failed');
      }
      return value as ReactUiStoredActionLease;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private directory(
    root: string,
    context: InvocationContext,
    kind: 'components' | 'renders' | 'state' | 'workspace-heads',
  ): string {
    return resolve(root, 'scopes', scopeKey(context), kind);
  }

  private workspaceHeadPath(root: string, renderId: string, context: InvocationContext): string {
    assertDigestId(renderId, 'renderId');
    return resolve(this.directory(root, context, 'workspace-heads'), `${renderId}.json`);
  }

  private root(): Promise<string> {
    return (this.rootPromise ??= initializeSafeDirectory(
      resolve(this.options.storageRoot),
      'React UI storage root',
    ));
  }
}

function assertStorageKey(value: string): void {
  if (!value || value.length > 512) throw new Error('React UI storage key must be 1-512 characters');
}

function assertLeaseDuration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 10 || value > 3_600_000) {
    throw new Error('UI action idempotency lease must be 10-3600000 milliseconds');
  }
}

function staleTakeoverAt(lease: ReactUiStoredActionLease): number {
  const expiresAt = Date.parse(lease.expiresAt);
  const inferredDuration = Math.max(
    10,
    Math.min(3_600_000, expiresAt - Date.parse(lease.createdAt)),
  );
  return expiresAt + (lease.leaseDurationMs ?? inferredDuration);
}

function parseActionTransactionOwner(serialized: string): ReactUiActionTransactionOwner {
  const value = JSON.parse(serialized) as Partial<ReactUiActionTransactionOwner>;
  if (
    typeof value.ownerId !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(value.ownerId) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid! <= 0 ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw new Error('React UI action transaction owner validation failed');
  }
  return value as ReactUiActionTransactionOwner;
}

function actionTransactionOwnerFile(ownerId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(ownerId)) {
    throw new Error('React UI action transaction owner token validation failed');
  }
  return `${ACTION_TRANSACTION_OWNER_PREFIX}${ownerId}${ACTION_TRANSACTION_OWNER_SUFFIX}`;
}

function acquireActionTransactionTurn(path: string, deadline: number): Promise<() => void> {
  const existing = ACTION_TRANSACTION_QUEUES.get(path);
  const queue = existing ?? { nextSequence: 0, waiting: [] };
  if (!existing) ACTION_TRANSACTION_QUEUES.set(path, queue);
  const sequence = queue.nextSequence;
  queue.nextSequence += 1;
  return new Promise((resolveTurn) => {
    const entry = { deadline, sequence, resolve: resolveTurn };
    if (sequence === 0) {
      resolveTurn(releaseActionTransactionTurn(path, queue));
      return;
    }
    queue.waiting.push(entry);
  });
}

function releaseActionTransactionTurn(
  path: string,
  queue: ReactUiActionTransactionQueue,
): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = takeNextActionTransaction(queue);
    if (!next) {
      if (ACTION_TRANSACTION_QUEUES.get(path) === queue) {
        ACTION_TRANSACTION_QUEUES.delete(path);
      }
      return;
    }
    next.resolve(releaseActionTransactionTurn(path, queue));
  };
}

function takeNextActionTransaction(
  queue: ReactUiActionTransactionQueue,
): ReactUiActionTransactionQueueEntry | undefined {
  let selected = 0;
  for (let index = 1; index < queue.waiting.length; index += 1) {
    const candidate = queue.waiting[index]!;
    const current = queue.waiting[selected]!;
    if (
      candidate.deadline < current.deadline ||
      (candidate.deadline === current.deadline && candidate.sequence < current.sequence)
    ) {
      selected = index;
    }
  }
  return queue.waiting.splice(selected, 1)[0];
}

function incompleteActionTransactionOwner(birthtimeMs: number): ReactUiActionTransactionOwner {
  const timestamp = Number.isFinite(birthtimeMs) && birthtimeMs > 0 ? birthtimeMs : 0;
  const token = digest(`incomplete-action-transaction\0${Math.floor(timestamp)}`).slice(0, 32);
  return {
    ownerId: [
      token.slice(0, 8),
      token.slice(8, 12),
      token.slice(12, 16),
      token.slice(16, 20),
      token.slice(20),
    ].join('-'),
    pid: 1,
    createdAt: new Date(timestamp).toISOString(),
  };
}

function parseActionTransactionOwnerFile(fileName: string): string {
  if (
    !fileName.startsWith(ACTION_TRANSACTION_OWNER_PREFIX) ||
    !fileName.endsWith(ACTION_TRANSACTION_OWNER_SUFFIX)
  ) {
    throw new Error('React UI action transaction owner filename validation failed');
  }
  const ownerId = fileName.slice(
    ACTION_TRANSACTION_OWNER_PREFIX.length,
    -ACTION_TRANSACTION_OWNER_SUFFIX.length,
  );
  actionTransactionOwnerFile(ownerId);
  return ownerId;
}

function sameActionTransactionOwner(
  left: ReactUiActionTransactionOwner,
  right: ReactUiActionTransactionOwner,
): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.pid === right.pid &&
    left.createdAt === right.createdAt
  );
}

function transactionOwnerKey(ownerId: string): string {
  return digest(ownerId).slice(0, 32);
}

function assertActionTransactionDeadline(deadline: number): void {
  if (Date.now() >= deadline) {
    throw Object.assign(new Error('Timed out acquiring React UI action transaction lock'), {
      code: 'UI_ACTION_TRANSACTION_TIMEOUT',
    });
  }
}

async function renameActionTransactionPath(
  source: string,
  target: string,
  deadline: number,
): Promise<void> {
  for (;;) {
    assertActionTransactionDeadline(deadline);
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw error;
      }
      await actionTransactionDelay();
    }
  }
}

async function restoreActionTransactionPath(
  source: string,
  target: string,
  deadline: number,
): Promise<void> {
  try {
    await renameActionTransactionPath(source, target, deadline);
  } catch (error) {
    if (isRenameContention(error)) return;
    throw error;
  }
}

function actionJournalEventBase(
  key: string,
  scope: UiStateScope,
  requestDigest: string,
  context: InvocationContext,
): {
  schemaVersion: 1;
  scopeKey: string;
  key: string;
  scope: UiStateScope;
  requestDigest: string;
  at: string;
} {
  return {
    schemaVersion: 1,
    scopeKey: stateScopeKey(context, scope),
    key,
    scope,
    requestDigest,
    at: new Date().toISOString(),
  };
}

function assertActionJournalEvent(
  event: ReactUiStoredActionJournalEvent,
  key: string,
  scope: UiStateScope,
  context: InvocationContext,
): void {
  if (
    !event ||
    event.schemaVersion !== 1 ||
    event.key !== key ||
    event.scope !== scope ||
    event.scopeKey !== stateScopeKey(context, scope) ||
    !isDigest(event.requestDigest) ||
    !isIsoTimestamp(event.at)
  ) {
    throw new Error('React UI action journal event validation failed');
  }
  switch (event.type) {
    case 'begin':
      assertActionJournalAttempt(event.attempt, scope, context);
      if (event.attempt.requestDigest !== event.requestDigest) {
        throw new Error('React UI action journal request digest validation failed');
      }
      return;
    case 'resume':
      assertJournalReceiptId(event.receiptId);
      if (
        (event.ownerId !== undefined && !/^[0-9a-f-]{36}$/.test(event.ownerId)) ||
        !Number.isSafeInteger(event.ownerPid) ||
        event.ownerPid <= 0 ||
        (event.leaseExpiresAt !== undefined && !isIsoTimestamp(event.leaseExpiresAt))
      ) {
        throw new Error('React UI action journal resume validation failed');
      }
      return;
    case 'lease_lost':
      assertJournalReceiptId(event.receiptId);
      boundedJournalError(event.error);
      return;
    case 'complete':
      assertJournalReceiptId(event.receiptId);
      assertUiActionResult(event.result, event.receiptId, event.requestDigest);
      return;
    case 'close':
      assertJournalReceiptId(event.receiptId);
  }
}

function assertActionJournalAttempt(
  attempt: UiActionJournalAttempt,
  scope: UiStateScope,
  context: InvocationContext,
): void {
  assertJournalReceiptId(attempt.receiptId);
  assertJournalReceiptId(attempt.executionId);
  if (
    attempt.scope !== scope ||
    attempt.principalId !== context.principal.id ||
    !isDigest(attempt.requestDigest) ||
    !isDigest(attempt.targetIdempotencyKey) ||
    !isIsoTimestamp(attempt.startedAt) ||
    !Number.isSafeInteger(attempt.ownerPid) ||
    attempt.ownerPid <= 0 ||
    (attempt.ownerId !== undefined && !/^[0-9a-f-]{36}$/.test(attempt.ownerId)) ||
    (attempt.leaseExpiresAt !== undefined && !isIsoTimestamp(attempt.leaseExpiresAt)) ||
    (attempt.phase !== 'pending' && attempt.phase !== 'terminal') ||
    !attempt.lineage ||
    typeof attempt.lineage.rootExecutionId !== 'string' ||
    !attempt.lineage.rootExecutionId ||
    !Number.isSafeInteger(attempt.lineage.depth) ||
    attempt.lineage.depth < 0 ||
    typeof attempt.renderId !== 'string' ||
    !attempt.renderId ||
    typeof attempt.actionId !== 'string' ||
    !attempt.actionId ||
    typeof attempt.actionVersion !== 'string' ||
    !attempt.actionVersion ||
    !attempt.target ||
    typeof attempt.target !== 'object'
  ) {
    throw new Error('React UI action journal attempt validation failed');
  }
  if (attempt.phase === 'pending' && attempt.result !== undefined) {
    throw new Error('Pending UI action journal attempt cannot contain a result');
  }
  if (attempt.phase === 'terminal') {
    if (!attempt.result) throw new Error('Terminal UI action journal attempt requires a result');
    assertUiActionResult(attempt.result, attempt.receiptId, attempt.requestDigest);
  }
}

function assertUiActionResult(
  result: UiActionResult,
  receiptId: string,
  requestDigest: string,
): void {
  if (
    !result ||
    typeof result !== 'object' ||
    !result.receipt ||
    result.receipt.receiptId !== receiptId ||
    result.receipt.requestDigest !== requestDigest ||
    result.receipt.status !== result.status ||
    result.receipt.executionId.length === 0 ||
    !result.receipt.lineage ||
    typeof result.receipt.lineage.rootExecutionId !== 'string' ||
    !isDigest(result.receipt.targetIdempotencyKey) ||
    !isIsoTimestamp(result.receipt.startedAt) ||
    !isIsoTimestamp(result.receipt.completedAt) ||
    !Number.isFinite(result.receipt.durationMs) ||
    result.receipt.durationMs < 0
  ) {
    throw new Error('React UI action journal result validation failed');
  }
}

function replayActionJournal(
  events: readonly ReactUiStoredActionJournalEvent[],
): ReactUiStoredActionJournal {
  let journal: ReactUiStoredActionJournal | undefined;
  for (const event of events) {
    if (!journal) {
      if (event.type !== 'begin') {
        throw new Error('React UI action journal must begin with a root');
      }
      journal = {
        schemaVersion: 1,
        scopeKey: event.scopeKey,
        key: event.key,
        scope: event.scope,
        requestDigest: event.requestDigest,
        attempts: [event.attempt],
        activeReceiptId: event.attempt.receiptId,
      };
      continue;
    }
    if (
      event.key !== journal.key ||
      event.scope !== journal.scope ||
      event.scopeKey !== journal.scopeKey ||
      event.requestDigest !== journal.requestDigest
    ) {
      throw new Error('React UI action journal event binding changed');
    }
    if (event.type === 'begin') {
      if (journal.activeReceiptId) {
        throw new Error('React UI action journal cannot begin while another root is active');
      }
      journal.attempts.push(event.attempt);
      journal.activeReceiptId = event.attempt.receiptId;
      continue;
    }
    const attempt = requireActionJournalAttempt(journal, event.receiptId);
    if (event.type === 'resume') {
      if (attempt.phase !== 'pending' || journal.activeReceiptId !== attempt.receiptId) {
        throw new Error('Only an active pending UI action root may resume');
      }
      Object.assign(attempt, {
        ...(event.ownerId ? { ownerId: event.ownerId } : {}),
        ownerPid: event.ownerPid,
        ...(event.leaseExpiresAt ? { leaseExpiresAt: event.leaseExpiresAt } : {}),
      });
      continue;
    }
    if (event.type === 'lease_lost') {
      if (attempt.phase !== 'pending') {
        throw new Error('Only a pending UI action root may lose its lease');
      }
      attempt.leaseLoss = { at: event.at, ...event.error };
      continue;
    }
    if (event.type === 'complete') {
      if (attempt.phase === 'terminal') {
        if (stableStringify(attempt.result) !== stableStringify(event.result)) {
          throw new Error('UI action journal contains conflicting terminal results');
        }
        continue;
      }
      attempt.phase = 'terminal';
      attempt.result = event.result;
      journal.activeReceiptId =
        event.result.status === 'success' ? attempt.receiptId : undefined;
      continue;
    }
    if (
      attempt.phase !== 'terminal' ||
      attempt.result?.status !== 'success' ||
      journal.activeReceiptId !== attempt.receiptId
    ) {
      throw new Error('Only an active successful UI action root may close');
    }
    journal.activeReceiptId = undefined;
  }
  if (!journal) throw new Error('React UI action journal is empty');
  return journal;
}

function requireActionJournalAttempt(
  journal: ReactUiStoredActionJournal,
  receiptId: string,
): UiActionJournalAttempt {
  const attempt = journal.attempts.find((candidate) => candidate.receiptId === receiptId);
  if (!attempt) throw new Error('UI action journal receipt was not found');
  return attempt;
}

function actionAttemptToken(
  root: string,
  key: string,
  scope: UiStateScope,
  context: InvocationContext,
  receiptId: string,
): string {
  return `${root}\0${stateScopeKey(context, scope)}\0${key}\0${receiptId}`;
}

function actionLeaseToken(
  root: string,
  key: string,
  scope: UiStateScope,
  context: InvocationContext,
): string {
  return `${root}\0${stateScopeKey(context, scope)}\0${key}`;
}

function rememberActiveActionLease(
  root: string,
  key: string,
  scope: UiStateScope,
  context: InvocationContext,
  attempt: UiActionJournalAttempt,
): void {
  if (!attempt.ownerId || !attempt.leaseExpiresAt) return;
  ACTIVE_ACTION_LEASES.set(actionLeaseToken(root, key, scope, context), {
    ownerId: attempt.ownerId,
    requestDigest: attempt.requestDigest,
    expiresAt: attempt.leaseExpiresAt,
  });
}

function boundedJournalError(error: { code: string; message: string }): {
  code: string;
  message: string;
} {
  if (!error || typeof error.code !== 'string' || typeof error.message !== 'string') {
    throw new Error('UI action journal error validation failed');
  }
  return {
    code: error.code.slice(0, 256),
    message: error.message.slice(0, 8_192),
  };
}

function interruptedActionResult(attempt: UiActionJournalAttempt): UiActionResult {
  const completed = new Date();
  const permission = {
    decision: 'deny' as const,
    code: 'ui_action_interrupted',
    reason: 'The process owning this UI action ended before it terminalized the root receipt.',
  };
  return {
    status: 'failed',
    error: {
      code: 'ui_action_interrupted',
      message: 'UI action execution was interrupted before completion.',
    },
    receipt: {
      receiptId: attempt.receiptId,
      executionId: attempt.executionId,
      lineage: attempt.lineage,
      renderId: attempt.renderId,
      actionId: attempt.actionId,
      actionVersion: attempt.actionVersion,
      target: attempt.target,
      scope: attempt.scope,
      principalId: attempt.principalId,
      ...(attempt.identity ? { identity: attempt.identity } : {}),
      ...(attempt.invocationScope ? { invocationScope: attempt.invocationScope } : {}),
      ...(attempt.idempotencyKey ? { idempotencyKey: attempt.idempotencyKey } : {}),
      targetIdempotencyKey: attempt.targetIdempotencyKey,
      requestDigest: attempt.requestDigest,
      permission,
      status: 'failed',
      startedAt: attempt.startedAt,
      completedAt: completed.toISOString(),
      durationMs: Math.max(0, completed.getTime() - Date.parse(attempt.startedAt)),
      ...(attempt.activation
        ? {
            activation: {
              ...attempt.activation,
              acceptedAt: attempt.startedAt,
              dispatchOverheadMs: Math.max(
                0,
                Date.parse(attempt.startedAt) - Date.parse(attempt.activation.activatedAt),
              ),
            },
          }
        : {}),
    },
  };
}

function actionRootExecutionReceipt(result: UiActionResult): RuntimeExecutionReceipt {
  const receipt = result.receipt;
  return {
    protocolVersion: '1.0.0',
    receiptId: receipt.receiptId,
    executionId: receipt.executionId,
    target: `ui.action.${receipt.actionId}`,
    principalId: receipt.principalId,
    ...(receipt.identity ? { identity: receipt.identity } : {}),
    ...(receipt.invocationScope ? { scope: receipt.invocationScope } : {}),
    lineage: receipt.lineage,
    status: receipt.status,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
    durationMs: receipt.durationMs,
    permission: receipt.permission,
    providerReceipt: receipt,
  };
}

function assertJournalReceiptId(value: string): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) {
    throw new Error('UI action journal receipt identity validation failed');
  }
}

function isRenameContention(error: unknown): boolean {
  return ['EEXIST', 'ENOTEMPTY', 'ENOENT', 'EPERM', 'EACCES'].includes(
    (error as NodeJS.ErrnoException).code ?? '',
  );
}

function actionTransactionDelay(): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ACTION_TRANSACTION_POLL_MS));
}

function boundedStorageValue(value: string): string {
  if (Buffer.byteLength(value) > 100_000) {
    throw new Error('React UI storage value exceeds 100000 bytes');
  }
  return value;
}

function assertStorageSize(values: Record<string, string>): void {
  if (Object.keys(values).length > 256 || Buffer.byteLength(JSON.stringify(values)) > 262_144) {
    throw new Error('React UI storage exceeds its scoped limit');
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.entries(value).every(
        ([key, child]) => key.length > 0 && key.length <= 512 && typeof child === 'string',
      ),
  );
}

function assertStoredComponent(
  value: CompiledReactComponent,
  expectedId: string,
  expectedScopeKey: string,
): void {
  if (
    !value || typeof value !== 'object' || value.id !== expectedId || value.scopeKey !== expectedScopeKey ||
    typeof value.title !== 'string' || typeof value.sourcePath !== 'string' ||
    (value.sourceKind !== 'workspace_file' && value.sourceKind !== 'registered_component') ||
    !isDigest(value.sourceDigest) || !isDigest(value.bundleDigest) || !isDigest(value.htmlDigest) ||
    typeof value.html !== 'string' || digest(value.html) !== value.htmlDigest ||
    value.resourceUri !== `ui://marshal-react/${value.id}/index.html` ||
    !Array.isArray(value.inputs) || value.inputs.some((input) => typeof input !== 'string') ||
    !isIsoTimestamp(value.createdAt)
  ) {
    throw new Error('Compiled React UI component integrity validation failed');
  }
  const embedded = extractBundleInputs(value.html);
  if (digest(`${embedded.script}\0${embedded.style}`) !== value.bundleDigest) {
    throw new Error('Compiled React UI component bundle integrity validation failed');
  }
  const expectedContentId = digest(JSON.stringify({
    protocol: value.buildGraph ? 2 : 1,
    sourceKind: value.sourceKind,
    sourcePath: value.sourcePath,
    sourceDigest: value.sourceDigest,
    bundleDigest: value.bundleDigest,
    htmlDigest: value.htmlDigest,
    title: value.title,
    description: value.description ?? '',
    registeredComponent: value.registeredComponent ?? null,
    authoringProfile: value.authoringProfile,
    inputs: value.inputs,
    ...(value.buildGraph ? { buildGraph: validatedBuildGraph(value) } : {}),
  }));
  if (expectedContentId !== value.id) {
    throw new Error('Compiled React UI component content address validation failed');
  }
}

function assertStoredRender(value: ReactUiRender, expectedId: string, expectedScopeKey: string): void {
  if (
    !value || typeof value !== 'object' || value.id !== expectedId || value.scopeKey !== expectedScopeKey ||
    !isDigest(value.componentId) || !isIsoTimestamp(value.createdAt) ||
    value.resourceUri !== `ui://marshal-react/${value.componentId}/index.html` ||
    value.toolName !== `marshal_render_react_${value.id}` ||
    !value.props || typeof value.props !== 'object' || Array.isArray(value.props) ||
    !value.fallback || typeof value.fallback.summary !== 'string'
  ) {
    throw new Error('React UI render integrity validation failed');
  }
  const expectedContentId = value.workspace
    ? workspaceRenderKey(value.workspace, value.props, value.fallback, value.application)
    : digest(stableStringify({
        componentId: value.componentId,
        props: value.props,
        fallback: value.fallback,
        application: value.application,
      }));
  if (value.workspace) assertWorkspaceBinding(value.workspace, expectedContentId);
  if (expectedContentId !== value.id) {
    throw new Error('React UI render content address validation failed');
  }
}

function validatedBuildGraph(value: CompiledReactComponent) {
  const graph = value.buildGraph;
  if (!graph || graph.schemaVersion !== 1 || !Array.isArray(graph.inputs) || graph.inputs.length === 0) {
    throw new Error('Compiled React UI build graph validation failed');
  }
  const inputs = graph.inputs.map((input) => {
    if (!input || (input.kind !== 'workspace' && input.kind !== 'package') ||
      typeof input.path !== 'string' || !isCanonicalAttestedPath(input.path) || !isDigest(input.digest)) {
      throw new Error('Compiled React UI build graph input validation failed');
    }
    if (input.kind === 'package') {
      if (!input.package || typeof input.package.name !== 'string' ||
        typeof input.package.version !== 'string' || !isDigest(input.package.manifestDigest)) {
        throw new Error('Compiled React UI package attestation validation failed');
      }
      if (input.resolution) validatePackageResolution(input.resolution);
    } else if (input.package !== undefined || input.resolution !== undefined) {
      throw new Error('Workspace React UI input cannot declare package authority');
    }
    return input;
  }).sort((left, right) => buildGraphInputKey(left).localeCompare(buildGraphInputKey(right)));
  const keys = inputs.map(buildGraphInputKey);
  if (new Set(keys).size !== keys.length || stableStringify(inputs) !== stableStringify(graph.inputs)) {
    throw new Error('Compiled React UI build graph must be canonical and unique');
  }
  const workspaceInputs = inputs.filter((input) => input.kind === 'workspace').map((input) => input.path).sort();
  if (stableStringify(workspaceInputs) !== stableStringify([...value.inputs].sort())) {
    throw new Error('Compiled React UI workspace inputs do not match its build graph');
  }
  return { schemaVersion: 1 as const, inputs };
}

function validatePackageResolution(
  resolution: NonNullable<NonNullable<CompiledReactComponent['buildGraph']>['inputs'][number]['resolution']>,
): void {
  if (resolution.schemaVersion !== 1 || !Array.isArray(resolution.steps) ||
    resolution.steps.length === 0 || resolution.steps.length > 256) {
    throw new Error('Compiled React UI package resolution validation failed');
  }
  for (const step of resolution.steps) {
    if (!step || typeof step.specifier !== 'string' || !step.specifier ||
      step.specifier.startsWith('.') || isAbsolute(step.specifier) ||
      !step.importer || !isCanonicalAttestedPath(step.importer.path)) {
      throw new Error('Compiled React UI package resolution step validation failed');
    }
    if (step.importer.kind === 'package') {
      const identity = step.importer.package;
      if (!identity || typeof identity.name !== 'string' || !identity.name ||
        typeof identity.version !== 'string' || !identity.version || !isDigest(identity.manifestDigest)) {
        throw new Error('Compiled React UI package resolution importer validation failed');
      }
    } else if (step.importer.kind !== 'workspace') {
      throw new Error('Compiled React UI package resolution importer kind is invalid');
    }
  }
}

function isCanonicalAttestedPath(path: string): boolean {
  return Boolean(path && !path.includes('\\') && !isAbsolute(path) &&
    path.split('/').every((segment) => segment && segment !== '.' && segment !== '..'));
}

function buildGraphInputKey(input: NonNullable<CompiledReactComponent['buildGraph']>['inputs'][number]): string {
  return input.kind === 'workspace'
    ? `workspace:${input.path}`
    : `package:${input.package?.name}@${input.package?.version}:${input.path}:${input.resolution ? JSON.stringify(input.resolution) : 'legacy'}`;
}

function assertWorkspaceBinding(binding: ReactUiWorkspaceBinding, expectedKey: string): void {
  if (binding.version !== '1.0.0' || binding.key !== expectedKey ||
    typeof binding.entryPath !== 'string' || !binding.entryPath ||
    typeof binding.title !== 'string' || !binding.title ||
    !Number.isInteger(binding.pollIntervalMs) || binding.pollIntervalMs < 1_000 || binding.pollIntervalMs > 60_000) {
    throw new Error('React UI workspace binding integrity validation failed');
  }
}

function componentMatchesWorkspaceRender(
  component: CompiledReactComponent,
  render: ReactUiRender,
): boolean {
  const binding = render.workspace;
  return Boolean(binding && component.sourceKind === 'workspace_file' &&
    component.sourcePath === binding.entryPath && component.title === binding.title &&
    (component.description ?? '') === (binding.description ?? '') &&
    (!binding.authoringProfile || (
      component.authoringProfile?.id === binding.authoringProfile.id &&
      component.authoringProfile.version === binding.authoringProfile.version
    )));
}

function extractBundleInputs(html: string): { script: string; style: string } {
  const styleStart = html.indexOf('<style>');
  const styleEnd = html.indexOf('</style>', styleStart + 7);
  const scriptStart = html.indexOf('<script>', styleEnd + 8);
  const scriptEnd = html.indexOf('</script>', scriptStart + 8);
  if (styleStart < 0 || styleEnd < 0 || scriptStart < 0 || scriptEnd < 0 || styleEnd >= scriptStart) {
    throw new Error('Compiled React UI HTML envelope validation failed');
  }
  return {
    style: html.slice(styleStart + 7, styleEnd),
    script: html.slice(scriptStart + 8, scriptEnd),
  };
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function executableRecordPayload<T extends { id: string; scopeKey: string }>(
  kind: ReactUiExecutableRecordKind,
  record: T,
): string {
  // Match the exact JSON value persisted by writeImmutable: optional
  // properties whose value is undefined are not part of the authenticated
  // record and therefore cannot make a post-restart signature diverge.
  const persistedRecord = JSON.parse(JSON.stringify(record)) as T;
  return stableStringify({
    protocol: 'marshal.react-ui.record.v1',
    kind,
    id: record.id,
    scopeKey: record.scopeKey,
    record: persistedRecord,
  });
}

function isAuthenticatedRecord<T>(value: T | ReactUiAuthenticatedRecord<T>): value is ReactUiAuthenticatedRecord<T> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<ReactUiAuthenticatedRecord<T>>;
  return candidate.schemaVersion === 1 &&
    (candidate.kind === 'component' || candidate.kind === 'render' || candidate.kind === 'workspace-head') &&
    Boolean(candidate.record && typeof candidate.record === 'object') &&
    Boolean(candidate.seal && typeof candidate.seal === 'object');
}

export function scopeKey(context: InvocationContext): string {
  return scopeKeyFromParts({
    workspaceId: context.scope?.workspaceId ?? context.scope?.workspacePath ?? '',
    projectId: context.scope?.projectId ?? '',
    principalId: context.principal.id,
  });
}

export function stateScopeKey(context: InvocationContext, scope: UiStateScope): string {
  switch (scope) {
    case 'session':
      return scopeKeyFromParts({
        workspaceId: context.scope?.workspaceId ?? context.scope?.workspacePath ?? '',
        projectId: context.scope?.projectId ?? '',
        sessionId: context.scope?.sessionId ?? '',
        principalId: context.principal.id,
      });
    case 'workspace':
      return scopeKeyFromParts({
        workspaceId: context.scope?.workspaceId ?? context.scope?.workspacePath ?? '',
        principalId: context.principal.id,
      });
    case 'project':
      return scopeKey(context);
  }
}

/** Hash used by releases that scoped compiled UI records to one task session. */
export function legacySessionScopeKey(context: InvocationContext): string {
  return scopeKeyFromParts({
    workspaceId: context.scope?.workspaceId ?? context.scope?.workspacePath ?? '',
    projectId: context.scope?.projectId ?? '',
    sessionId: context.scope?.sessionId ?? '',
    principalId: context.principal.id,
  });
}

function scopeKeyFromParts(value: Readonly<Record<string, string>>): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 32);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`;
}

export function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Stable identity for one editable workspace app; compiled revisions are deliberately excluded. */
export function workspaceRenderKey(
  binding: Omit<ReactUiWorkspaceBinding, 'key' | 'pollIntervalMs'>,
  props: ReactUiRender['props'],
  fallback: ReactUiRender['fallback'],
  application: ReactUiRender['application'],
): string {
  return digest(stableStringify({
    protocol: 'marshal.react-ui.workspace-render.v1',
    version: binding.version,
    entryPath: binding.entryPath,
    title: binding.title,
    description: binding.description ?? '',
    authoringProfile: binding.authoringProfile,
    props,
    fallback,
    application,
  }));
}

export function assertDigestId(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field} must be a SHA-256 identifier`);
}

function normalizeStoredState(
  value: Partial<ReactUiStoredState>,
  renderId: string,
  scope: UiStateScope,
  schemaVersion: string,
  context: InvocationContext,
): ReactUiStoredState {
  if (value.renderId !== renderId || !isStringRecord(value.values)) {
    throw new Error('React UI state validation failed');
  }
  const version = value.version === undefined ? 1 : value.version;
  if (!Number.isInteger(version) || version < 0) throw new Error('React UI state version is invalid');
  return {
    scopeKey: stateScopeKey(context, scope),
    renderId,
    scope,
    schemaVersion: typeof value.schemaVersion === 'string' && value.schemaVersion ? value.schemaVersion : schemaVersion,
    version,
    values: value.values,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString(),
  };
}
