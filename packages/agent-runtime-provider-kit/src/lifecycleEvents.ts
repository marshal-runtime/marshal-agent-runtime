import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  RUNTIME_PROTOCOL_VERSION,
  assertSupportedProtocolVersion,
  sameStableFileIdentity,
} from '@marshal/agent-runtime-core';
import {
  purgeLifecycleResults,
  readLifecycleResultPurgeEpoch,
  type LifecycleResultPurgeFilter,
  type LifecycleResultPurgeReceipt,
} from './lifecycleResults.js';

const MAX_RECEIPT_BYTES = 1024 * 1024;
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 25;
const DEFAULT_LEASE_DURATION_MS = 5_000;
const MIN_RETENTION_SWEEP_INTERVAL_MS = 60_000;

export interface RuntimeLifecycleEventIdentity {
  readonly sessionId: string;
  readonly protocolVersion?: string;
  readonly eventId?: string;
}

export interface DurableLifecycleEventReceipt {
  readonly protocolVersion: string;
  readonly receiptId: string;
  readonly sessionId: string;
  readonly eventId: string;
  readonly kind: string;
  readonly requestDigest: string;
  readonly status: 'applying' | 'applied' | 'failed';
  readonly replayed: boolean;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly error?: Readonly<{ code: string; message: string }>;
  /**
   * The result body is not kept for replay: it was purged or expired, or a purge ran while the
   * callback was in flight and the body was dropped at write time. Replays omit the result; the
   * live caller of the dropped write still receives it.
   */
  readonly resultUnavailable?: boolean;
}

export interface DurableLifecycleApplication<TResult> {
  readonly result?: TResult;
  readonly receipt: DurableLifecycleEventReceipt;
}

export interface DurableLifecycleEventCoordinatorOptions {
  /** Maximum time a duplicate caller waits for the active owner to finish. */
  readonly waitTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  /** Lease duration after which a missing heartbeat permits owner takeover. */
  readonly leaseDurationMs?: number;
  /**
   * Protected result-body storage. Journal files retain only opaque references
   * and digests so recalled private context is never copied into lifecycle replay.
   */
  readonly resultDirectory?: string;
  /**
   * How long result bodies are kept for replay. Unset keeps them until purged. Expired bodies
   * are swept at most once a minute after an apply; replay of an expired event returns its
   * receipt with `resultUnavailable: true` and never reapplies the callback.
   */
  readonly resultRetentionMs?: number;
}

interface StoredLifecycleEvent
  extends Omit<DurableLifecycleEventReceipt, 'replayed'> {
  readonly resultRef?: LifecycleResultReference;
  readonly owner?: LeaseOwner;
}

interface LifecycleResultReference {
  readonly id: string;
  readonly digest: string;
}

interface StoredLifecycleResult<TResult = unknown> extends LifecycleResultReference {
  readonly receiptId: string;
  readonly requestDigest: string;
  readonly result: TResult;
}

interface LeaseOwner {
  readonly token: string;
  readonly pid: number;
  readonly expiresAt: string;
}

interface EventHeartbeat {
  readonly kind: 'lifecycle-event-heartbeat';
  readonly owner: LeaseOwner;
}

type ClaimDecision =
  | {
      readonly state: 'owned';
      readonly applying: StoredLifecycleEvent;
      readonly generation: number;
    }
  | { readonly state: 'observed'; readonly stored: StoredLifecycleEvent };

interface StoredState {
  readonly stored: StoredLifecycleEvent;
  readonly generation: number;
}

/** Durable claim-and-receipt gate for process-independent lifecycle callbacks. */
export class DurableLifecycleEventCoordinator {
  private readonly rootDirectory: string;
  private readonly resultDirectory: string;
  private rootsPromise: Promise<{ readonly root: string; readonly resultRoot: string }> | undefined;
  private readonly waitTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly resultRetentionMs: number | undefined;
  private lastRetentionSweep = 0;

  constructor(rootDirectory: string, options: DurableLifecycleEventCoordinatorOptions = {}) {
    if (!path.isAbsolute(rootDirectory)) {
      throw new TypeError('Lifecycle event root must be absolute.');
    }
    this.waitTimeoutMs = positiveInteger(
      options.waitTimeoutMs,
      DEFAULT_WAIT_TIMEOUT_MS,
      'waitTimeoutMs',
    );
    this.pollIntervalMs = positiveInteger(
      options.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
      'pollIntervalMs',
    );
    this.leaseDurationMs = positiveInteger(
      options.leaseDurationMs,
      DEFAULT_LEASE_DURATION_MS,
      'leaseDurationMs',
    );
    this.resultRetentionMs = options.resultRetentionMs === undefined
      ? undefined
      : positiveInteger(options.resultRetentionMs, 1, 'resultRetentionMs');
    this.rootDirectory = path.resolve(rootDirectory);
    const resultDirectory = options.resultDirectory ?? path.join(rootDirectory, '.protected-results');
    if (!path.isAbsolute(resultDirectory)) throw new TypeError('Lifecycle result root must be absolute.');
    this.resultDirectory = path.resolve(resultDirectory);
  }

  async apply<TRequest extends RuntimeLifecycleEventIdentity, TResult>(
    kind: string,
    request: TRequest,
    callback: (
      request: TRequest & Required<Pick<RuntimeLifecycleEventIdentity, 'protocolVersion' | 'eventId'>>,
    ) => Promise<TResult>,
  ): Promise<DurableLifecycleApplication<TResult>> {
    validateSessionId(request.sessionId);
    const protocolVersion = request.protocolVersion ?? RUNTIME_PROTOCOL_VERSION;
    assertSupportedProtocolVersion(protocolVersion);
    const eventId = normalizeEventId(request.eventId, kind, request);
    const normalized = { ...request, protocolVersion, eventId } as TRequest &
      Required<Pick<RuntimeLifecycleEventIdentity, 'protocolVersion' | 'eventId'>>;
    const requestDigest = digest(stableJson(normalized));
    const { root, resultRoot } = await this.initializeRoots();
    const sessionDirectory = path.join(root, digest(request.sessionId));
    const eventKey = digest(eventId);
    const claimTarget = path.join(sessionDirectory, `${eventKey}.claim.json`);
    const receiptTarget = path.join(sessionDirectory, `${eventKey}.receipt.json`);
    const statePrefix = path.join(sessionDirectory, `${eventKey}.state.`);
    for (const target of [sessionDirectory, claimTarget, receiptTarget, statePrefix]) {
      assertContained(root, target);
    }
    await ensureSafeSessionDirectory(root, sessionDirectory);

    const identity = {
      protocolVersion,
      sessionId: request.sessionId,
      eventId,
      kind,
      requestDigest,
    };
    const deadline = Date.now() + this.waitTimeoutMs;
    let decision: ClaimDecision;
    while (true) {
      decision = await this.claimOrObserve(
        claimTarget,
        receiptTarget,
        statePrefix,
        identity,
        deadline,
      );
      if (decision.state === 'owned') break;
      const stored = decision.stored;
      assertSameEvent(stored, identity);
      if (stored.status === 'applied') {
        const result = stored.resultRef
          ? await readLifecycleResult<TResult>(resultRoot, stored.resultRef, stored)
          : undefined;
        if (result === RESULT_UNAVAILABLE) {
          return { receipt: { ...withoutPrivateState(stored), replayed: true, resultUnavailable: true } };
        }
        return { result, receipt: { ...withoutPrivateState(stored), replayed: true } };
      }
      if (stored.status === 'failed') throwStoredFailure(stored);
      if (Date.now() >= deadline) throwBusy(stored);
      await delay(Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now())));
    }

    const applying = decision.applying;
    const generation = decision.generation;
    const owner = applying.owner!;
    const heartbeat = startHeartbeat(
      () => this.renewLease(claimTarget, receiptTarget, statePrefix, owner.token),
      Math.max(10, Math.floor(this.leaseDurationMs / 3)),
    );

    try {
      const epoch = await readLifecycleResultPurgeEpoch(resultRoot);
      const result = await callback(normalized);
      const resultRef = result === undefined
        ? undefined
        : await writeResultUnlessPurged(resultRoot, applying, result, epoch);
      const completed: StoredLifecycleEvent = {
        ...applying,
        status: 'applied',
        completedAt: new Date().toISOString(),
        resultRef,
        ...(result !== undefined && resultRef === undefined ? { resultUnavailable: true } : {}),
      };
      await this.finishOwned(
        claimTarget,
        receiptTarget,
        statePrefix,
        owner.token,
        generation,
        completed,
      );
      await this.sweepExpiredResults(resultRoot);
      return { result, receipt: { ...withoutPrivateState(completed), replayed: false } };
    } catch (error) {
      const failed: StoredLifecycleEvent = {
        ...applying,
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: {
          code: safePersistedErrorCode(error),
          message: 'Lifecycle event callback failed.',
        },
      };
      await this.finishOwned(
        claimTarget,
        receiptTarget,
        statePrefix,
        owner.token,
        generation,
        failed,
      ).catch(
        (finishError) => {
          throw finishError;
        },
      );
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        lifecycleReceipt: { ...withoutPrivateState(failed), replayed: false },
      });
    } finally {
      await heartbeat.stop();
    }
  }

  /**
   * Deletes stored result bodies that match the filter, for example every body that contains a
   * forgotten record's id or text. Receipts stay, so the events are still never reapplied.
   */
  async purgeResults(filter: LifecycleResultPurgeFilter): Promise<LifecycleResultPurgeReceipt> {
    const { resultRoot } = await this.initializeRoots();
    return purgeLifecycleResults(resultRoot, filter);
  }

  private async sweepExpiredResults(resultRoot: string): Promise<void> {
    if (this.resultRetentionMs === undefined) return;
    const now = Date.now();
    const interval = Math.max(MIN_RETENTION_SWEEP_INTERVAL_MS, Math.floor(this.resultRetentionMs / 10));
    if (now - this.lastRetentionSweep < interval) return;
    this.lastRetentionSweep = now;
    await purgeLifecycleResults(resultRoot, { olderThanMs: this.resultRetentionMs }, { now, advanceEpoch: false }).catch(() => undefined);
  }

  private async claimOrObserve(
    claimTarget: string,
    receiptTarget: string,
    statePrefix: string,
    identity: Pick<
      StoredLifecycleEvent,
      'protocolVersion' | 'sessionId' | 'eventId' | 'kind' | 'requestDigest'
    >,
    deadline: number,
  ): Promise<ClaimDecision> {
    while (true) {
      const existing = await readLatestState(claimTarget, receiptTarget, statePrefix);
      if (existing) {
        assertSameEvent(existing.stored, identity);
        if (existing.stored.status !== 'applying') {
          return { state: 'observed', stored: existing.stored };
        }
        if (await hasActiveLease(claimTarget, existing.stored, this.leaseDurationMs)) {
          return { state: 'observed', stored: existing.stored };
        }
      }

      const applying: StoredLifecycleEvent = {
        ...identity,
        receiptId: `lifecycle-${digest(`${identity.sessionId}:${identity.eventId}`)}`,
        status: 'applying',
        startedAt: new Date().toISOString(),
        owner: leaseOwner(this.leaseDurationMs),
      };
      const generation = existing ? existing.generation + 1 : 0;
      const target = generation === 0 ? claimTarget : stateTarget(statePrefix, generation);
      if (await claimFile(target, applying)) {
        return { state: 'owned', applying, generation };
      }
      if (Date.now() >= deadline) {
        const latest = await readLatestState(claimTarget, receiptTarget, statePrefix);
        if (latest) return { state: 'observed', stored: latest.stored };
        throw Object.assign(new Error('Timed out claiming the lifecycle event.'), {
          code: 'LIFECYCLE_EVENT_BUSY',
        });
      }
    }
  }

  private initializeRoots(): Promise<{ readonly root: string; readonly resultRoot: string }> {
    return this.rootsPromise ??= initializeRoot(this.rootDirectory).then(async (root) => ({
      root,
      resultRoot: await initializeRoot(this.resultDirectory),
    }));
  }

  private async renewLease(
    claimTarget: string,
    receiptTarget: string,
    statePrefix: string,
    token: string,
  ): Promise<void> {
    const current = await readLatestState(claimTarget, receiptTarget, statePrefix);
    if (current?.stored.status !== 'applying' || current.stored.owner?.token !== token) return;
    await writeHeartbeat(heartbeatTarget(claimTarget, token), {
      kind: 'lifecycle-event-heartbeat',
      owner: { ...current.stored.owner, expiresAt: expiry(this.leaseDurationMs) },
    });
  }

  private async finishOwned(
    claimTarget: string,
    receiptTarget: string,
    statePrefix: string,
    token: string,
    ownedGeneration: number,
    completed: StoredLifecycleEvent,
  ): Promise<void> {
    let generation = ownedGeneration;
    while (true) {
      const current = await readLatestState(claimTarget, receiptTarget, statePrefix);
      if (
        !current ||
        current.generation !== generation ||
        current.stored.status !== 'applying' ||
        current.stored.owner?.token !== token
      ) {
        throw Object.assign(new Error('Lifecycle event ownership was lost before completion.'), {
          code: 'LIFECYCLE_EVENT_LEASE_LOST',
        });
      }
      const nextGeneration = generation + 1;
      if (await claimFile(stateTarget(statePrefix, nextGeneration), completed)) {
        // This projection preserves compatibility with readers from earlier releases.
        await writeStored(receiptTarget, completed).catch(() => undefined);
        return;
      }
      generation = nextGeneration;
    }
  }
}

export function withLifecycleReceipt<TResult>(
  application: DurableLifecycleApplication<TResult>,
): Readonly<Record<string, unknown>> {
  const result = application.result;
  return {
    ...(isRecord(result) ? result : result === undefined ? {} : { result }),
    lifecycleReceipt: application.receipt,
  };
}

async function initializeRoot(rootDirectory: string): Promise<string> {
  const resolved = path.resolve(rootDirectory);
  await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Lifecycle event root must be a real directory.');
  }
  const canonical = await fs.realpath(resolved);
  if (!samePath(canonical, resolved)) {
    throw new Error('Lifecycle event root cannot traverse a symbolic link or junction.');
  }
  return canonical;
}

async function ensureSafeSessionDirectory(root: string, sessionDirectory: string): Promise<void> {
  try {
    await fs.mkdir(sessionDirectory, { mode: 0o700 });
  } catch (error) {
    if (readErrorCode(error) !== 'EEXIST') throw error;
  }
  const stat = await fs.lstat(sessionDirectory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw Object.assign(new Error('Lifecycle session path must be a real directory.'), {
      code: 'LIFECYCLE_SESSION_PATH_UNSAFE',
    });
  }
  const canonical = await fs.realpath(sessionDirectory);
  if (!samePath(canonical, sessionDirectory) || !isContained(root, canonical)) {
    throw Object.assign(new Error('Lifecycle session directory escaped its state root.'), {
      code: 'LIFECYCLE_SESSION_PATH_UNSAFE',
    });
  }
}

async function claimFile(target: string, entry: StoredLifecycleEvent): Promise<boolean> {
  const temporary = await writeTemporary(target, entry);
  try {
    await fs.link(temporary, target);
    return true;
  } catch (error) {
    if (readErrorCode(error) === 'EEXIST') return false;
    throw error;
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if (readErrorCode(error) !== 'ENOENT') throw error;
    });
  }
}

async function readLatestState(
  claimTarget: string,
  receiptTarget: string,
  statePrefix: string,
): Promise<StoredState | undefined> {
  const directory = path.dirname(statePrefix);
  const prefix = path.basename(statePrefix);
  const names = await fs.readdir(directory);
  let generation = -1;
  let target: string | undefined;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    if (!/^\d{12}\.json$/.test(suffix)) continue;
    const candidateGeneration = Number.parseInt(suffix.slice(0, 12), 10);
    if (candidateGeneration <= generation) continue;
    generation = candidateGeneration;
    target = path.join(directory, name);
  }
  if (target) return { stored: await readStored(target), generation };

  const receipt = await readOptionalStored(receiptTarget);
  if (receipt) return { stored: receipt, generation: 0 };
  const claim = await readOptionalStored(claimTarget);
  return claim ? { stored: claim, generation: 0 } : undefined;
}

async function hasActiveLease(
  claimTarget: string,
  stored: StoredLifecycleEvent,
  leaseDurationMs: number,
): Promise<boolean> {
  if (stored.owner) {
    const heartbeat = await readOptionalHeartbeat(heartbeatTarget(claimTarget, stored.owner.token));
    const effective = heartbeat?.owner.token === stored.owner.token ? heartbeat.owner : stored.owner;
    return !isLeaseExpired(effective);
  }
  // Earlier releases did not persist an owner. Give an in-flight legacy caller
  // one lease window before permitting migration to an immutable generation.
  const startedAt = Date.parse(stored.startedAt);
  return Number.isFinite(startedAt) && startedAt + leaseDurationMs > Date.now();
}

function stateTarget(prefix: string, generation: number): string {
  if (!Number.isSafeInteger(generation) || generation <= 0 || generation > 999_999_999_999) {
    throw new Error('Lifecycle event generation is out of range.');
  }
  return `${prefix}${String(generation).padStart(12, '0')}.json`;
}

function heartbeatTarget(claimTarget: string, token: string): string {
  return `${claimTarget}.${digest(token)}.heartbeat.json`;
}

async function readOptionalStored(
  target: string,
): Promise<StoredLifecycleEvent | undefined> {
  try {
    return await readStored(target);
  } catch (error) {
    if (readErrorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

async function readOptionalHeartbeat(target: string): Promise<EventHeartbeat | undefined> {
  try {
    const value = await readJsonFile(target);
    if (!isEventHeartbeat(value)) throw new Error('Invalid lifecycle heartbeat shape.');
    return value;
  } catch (error) {
    if (readErrorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

async function readStored(target: string): Promise<StoredLifecycleEvent> {
  try {
    const value = await readJsonFile(target);
    if (!isStoredLifecycleEvent(value)) throw new Error('Invalid lifecycle receipt shape.');
    return value;
  } catch (error) {
    if (readErrorCode(error) === 'ENOENT') throw error;
    throw Object.assign(new Error('Lifecycle receipt is corrupt; refusing to reapply the event.'), {
      code: 'LIFECYCLE_RECEIPT_CORRUPT',
      cause: error,
    });
  }
}

async function readJsonFile(target: string): Promise<unknown> {
  const handle = await fs.open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_RECEIPT_BYTES) {
      throw new Error('Lifecycle record is unsafe or exceeds its size limit.');
    }
    const serialized = await handle.readFile('utf8');
    const after = await handle.stat();
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error('Lifecycle record changed while it was read.');
    }
    const linked = await fs.lstat(target);
    if (
      linked.isSymbolicLink()
      || !linked.isFile()
      || !sameStableFileIdentity(linked, after)
    ) {
      throw new Error('Lifecycle record path does not identify the opened file.');
    }
    return JSON.parse(serialized) as unknown;
  } finally {
    await handle.close();
  }
}

async function writeStored(target: string, entry: StoredLifecycleEvent): Promise<void> {
  const temporary = await writeTemporary(target, entry);
  try {
    await fs.rename(temporary, target);
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if (readErrorCode(error) !== 'ENOENT') throw error;
    });
  }
}

/**
 * Writes a body only while no purge has run since the callback started. The epoch is checked
 * again after the write, so a purge that scanned before the body landed still removes it.
 */
async function writeResultUnlessPurged<TResult>(
  root: string,
  event: StoredLifecycleEvent,
  result: TResult,
  epoch: string,
): Promise<LifecycleResultReference | undefined> {
  if (await readLifecycleResultPurgeEpoch(root) !== epoch) return undefined;
  const reference = await writeLifecycleResult(root, event, result);
  if (await readLifecycleResultPurgeEpoch(root) === epoch) return reference;
  await fs.unlink(path.join(root, `${reference.id}.result.json`)).catch((error) => {
    if (readErrorCode(error) !== 'ENOENT') throw error;
  });
  return undefined;
}

async function writeLifecycleResult<TResult>(
  root: string,
  event: StoredLifecycleEvent,
  result: TResult,
): Promise<LifecycleResultReference> {
  const id = digest(`${event.receiptId}:${event.requestDigest}:${event.owner?.token ?? 'completed'}`);
  const resultDigest = digest(stableJson(result));
  const target = path.join(root, `${id}.result.json`);
  assertContained(root, target);
  const record: StoredLifecycleResult<TResult> = {
    id,
    digest: resultDigest,
    receiptId: event.receiptId,
    requestDigest: event.requestDigest,
    result,
  };
  try {
    const existing = await readJsonFile(target);
    if (!isStoredLifecycleResult(existing) || existing.digest !== resultDigest) {
      throw new Error('Lifecycle result identity collision.');
    }
  } catch (error) {
    if (readErrorCode(error) !== 'ENOENT') throw error;
    const temporary = await writeTemporary(target, record);
    try {
      await fs.rename(temporary, target);
    } finally {
      await fs.unlink(temporary).catch((unlinkError) => {
        if (readErrorCode(unlinkError) !== 'ENOENT') throw unlinkError;
      });
    }
  }
  return { id, digest: resultDigest };
}

const RESULT_UNAVAILABLE: unique symbol = Symbol('lifecycle-result-unavailable');

async function readLifecycleResult<TResult>(
  root: string,
  reference: LifecycleResultReference,
  event: StoredLifecycleEvent,
): Promise<TResult | typeof RESULT_UNAVAILABLE> {
  const target = path.join(root, `${reference.id}.result.json`);
  assertContained(root, target);
  let value: unknown;
  try {
    value = await readJsonFile(target);
  } catch (error) {
    // A purged or expired body: the event stays applied and is never run again.
    if (readErrorCode(error) === 'ENOENT') return RESULT_UNAVAILABLE;
    throw error;
  }
  if (
    !isStoredLifecycleResult(value) ||
    value.id !== reference.id ||
    value.digest !== reference.digest ||
    value.receiptId !== event.receiptId ||
    value.requestDigest !== event.requestDigest ||
    digest(stableJson(value.result)) !== reference.digest
  ) {
    throw Object.assign(new Error('Lifecycle result is corrupt; refusing to reapply the event.'), {
      code: 'LIFECYCLE_RESULT_CORRUPT',
    });
  }
  return value.result as TResult;
}

async function writeHeartbeat(target: string, entry: EventHeartbeat): Promise<void> {
  const temporary = await writeTemporary(target, entry);
  try {
    await fs.rename(temporary, target);
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if (readErrorCode(error) !== 'ENOENT') throw error;
    });
  }
}

async function writeTemporary(
  target: string,
  entry: unknown,
): Promise<string> {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(serialize(entry), 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return temporary;
}

function serialize(entry: unknown): string {
  const value = JSON.stringify(entry);
  if (Buffer.byteLength(value, 'utf8') > MAX_RECEIPT_BYTES) {
    throw new Error('Lifecycle receipt exceeds its size limit.');
  }
  return value;
}

function leaseOwner(durationMs: number): LeaseOwner {
  return { token: randomUUID(), pid: process.pid, expiresAt: expiry(durationMs) };
}

function expiry(durationMs: number): string {
  return new Date(Date.now() + durationMs).toISOString();
}

function isLeaseExpired(owner: LeaseOwner): boolean {
  const expiresAt = Date.parse(owner.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
}

function normalizeEventId(
  configured: string | undefined,
  kind: string,
  request: RuntimeLifecycleEventIdentity,
): string {
  if (configured !== undefined) {
    if (!configured.trim() || configured.length > 512) {
      throw new TypeError('eventId must be a non-empty string of at most 512 characters.');
    }
    return configured;
  }
  return `derived-${digest(stableJson({ kind, request }))}`;
}

function validateSessionId(value: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024) {
    throw new TypeError('sessionId must be a non-empty string of at most 1024 characters.');
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)]),
  );
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function withoutPrivateState(entry: StoredLifecycleEvent): Omit<StoredLifecycleEvent, 'resultRef' | 'owner'> {
  const { resultRef: _resultRef, owner: _owner, ...receipt } = entry;
  return receipt;
}

function assertContained(root: string, target: string): void {
  if (!isContained(root, target)) throw new Error('Lifecycle receipt path escaped its root.');
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (
    !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
  );
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLocaleLowerCase() === resolvedRight.toLocaleLowerCase()
    : resolvedLeft === resolvedRight;
}

function readErrorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === 'string' ? error.code : 'LIFECYCLE_EVENT_FAILED';
}

function safePersistedErrorCode(error: unknown): string {
  const code = readErrorCode(error);
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'LIFECYCLE_EVENT_FAILED';
}

function assertSameEvent(
  stored: StoredLifecycleEvent,
  expected: Pick<
    StoredLifecycleEvent,
    'protocolVersion' | 'sessionId' | 'eventId' | 'kind' | 'requestDigest'
  >,
): void {
  for (const key of [
    'protocolVersion',
    'sessionId',
    'eventId',
    'kind',
    'requestDigest',
  ] as const) {
    if (stored[key] !== expected[key]) {
      throw Object.assign(
        new Error(`Lifecycle event identity collision for ${expected.eventId}.`),
        { code: 'LIFECYCLE_EVENT_IDENTITY_COLLISION' },
      );
    }
  }
}

function throwStoredFailure(stored: StoredLifecycleEvent): never {
  throw Object.assign(
    new Error(stored.error?.message ?? 'Lifecycle event previously failed.'),
    {
      code: stored.error?.code ?? 'LIFECYCLE_EVENT_FAILED',
      lifecycleReceipt: { ...withoutPrivateState(stored), replayed: true },
    },
  );
}

function throwBusy(stored: StoredLifecycleEvent): never {
  throw Object.assign(new Error('Lifecycle event is still owned by another active process.'), {
    code: 'LIFECYCLE_EVENT_BUSY',
    lifecycleReceipt: { ...withoutPrivateState(stored), replayed: true },
  });
}

function isStoredLifecycleEvent(value: unknown): value is StoredLifecycleEvent {
  return (
    isRecord(value) &&
    typeof value.protocolVersion === 'string' &&
    typeof value.receiptId === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.eventId === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.requestDigest === 'string' &&
    (value.status === 'applying' || value.status === 'applied' || value.status === 'failed') &&
    typeof value.startedAt === 'string' &&
    (value.resultRef === undefined || isLifecycleResultReference(value.resultRef)) &&
    (value.resultUnavailable === undefined || value.resultUnavailable === true) &&
    (value.owner === undefined || isLeaseOwner(value.owner))
  );
}

function isLifecycleResultReference(value: unknown): value is LifecycleResultReference {
  return isRecord(value) && typeof value.id === 'string' && typeof value.digest === 'string';
}

function isStoredLifecycleResult(value: unknown): value is StoredLifecycleResult {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.digest === 'string' &&
    typeof value.receiptId === 'string' &&
    typeof value.requestDigest === 'string' &&
    'result' in value
  );
}

function isEventHeartbeat(value: unknown): value is EventHeartbeat {
  return (
    isRecord(value) &&
    value.kind === 'lifecycle-event-heartbeat' &&
    isLeaseOwner(value.owner)
  );
}

function isLeaseOwner(value: unknown): value is LeaseOwner {
  return (
    isRecord(value) &&
    typeof value.token === 'string' &&
    Number.isSafeInteger(value.pid) &&
    (value.pid as number) > 0 &&
    typeof value.expiresAt === 'string'
  );
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new TypeError(`${field} must be a positive integer.`);
  }
  return selected;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function startHeartbeat(
  renew: () => Promise<void>,
  intervalMs: number,
): { stop(): Promise<void> } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      running = renew()
        .catch(() => undefined)
        .finally(() => {
          running = undefined;
          schedule();
        });
    }, intervalMs);
    timer.unref?.();
  };
  schedule();
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
