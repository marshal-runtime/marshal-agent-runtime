import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  DelegationAdapterPort,
  DelegationAdapterSnapshot,
  DelegationCancelRequest,
  DelegationContinueRequest,
  DelegationContinuationResult,
  DelegationContext,
  DelegationLaunchRequest,
  DelegationPauseRequest,
  DelegationRecord,
  DelegationRecoverRequest,
  DelegationSpawnRequest,
  DelegationStore,
  DelegationWaitRequest,
} from './types.js';

const TERMINAL_STATES = new Set(['done', 'failed']);

export interface DelegationManagerOptions {
  readonly store: DelegationStore;
  readonly adapter: DelegationAdapterPort;
  readonly createId?: () => string;
}

export class DelegationManager {
  private readonly createId: () => string;
  private readonly launches = new Map<string, Promise<DelegationRecord>>();
  private readonly completions = new Map<string, Promise<DelegationRecord>>();

  constructor(private readonly options: DelegationManagerOptions) {
    this.createId = options.createId ?? (() => `delegation-${randomUUID()}`);
  }

  async spawn(
    request: DelegationSpawnRequest,
    context: DelegationContext = {},
  ): Promise<DelegationRecord> {
    requireText(request.prompt, 'prompt');
    throwIfAborted(context);
    assertManagedMutation(context);
    if (request.idempotencyKey !== undefined) requireText(request.idempotencyKey, 'idempotencyKey');
    if (request.delegationId !== undefined) requireText(request.delegationId, 'delegationId');
    const ownerSessionId = context.scope?.sessionId ?? context.invocation?.scope?.sessionId;
    const ownerPrincipalId = context.invocation?.principal.id;
    const scope = context.scope ?? context.invocation?.scope;
    const identity = JSON.stringify([
      ownerPrincipalId, ownerSessionId, scope?.workspaceId, scope?.projectId, scope?.threadId,
      request.idempotencyKey,
    ]);
    const delegationId = request.delegationId ?? (request.idempotencyKey === undefined
      ? this.createId()
      : `delegation-${digest(identity)}`);
    const fingerprint = digest(JSON.stringify([identity, launchRequest(request), request.parentDelegationId]));
    const active = this.launches.get(delegationId);
    if (active) {
      const record = await active;
      assertSpawnIdentity(record, fingerprint, context);
      return record;
    }
    const launch = this.spawnRegistered(request, context, delegationId, fingerprint);
    this.launches.set(delegationId, launch);
    try {
      return await launch;
    } finally {
      this.launches.delete(delegationId);
    }
  }

  private async spawnRegistered(
    request: DelegationSpawnRequest,
    context: DelegationContext,
    delegationId: string,
    fingerprint: string,
  ): Promise<DelegationRecord> {

    if (request.parentDelegationId) {
      assertCaller(await this.requireRecord(request.parentDelegationId), context);
    }
    const launch = launchRequest(request);
    let record: DelegationRecord = {
      delegationId,
      state: 'pending',
      spawnFingerprint: fingerprint,
      ...(context.scope?.sessionId === undefined ? {} : { ownerSessionId: context.scope.sessionId }),
      ...(context.invocation?.principal.id === undefined ? {} : { ownerPrincipalId: context.invocation.principal.id }),
      ...(request.parentDelegationId === undefined
        ? {}
        : { parentDelegationId: request.parentDelegationId }),
    };
    const existing = await this.options.store.get(delegationId);
    if (existing) {
      assertSpawnIdentity(existing, fingerprint, context);
      if (existing.state !== 'pending' || existing.adapterHandle) return existing;
      record = existing;
    } else {
      try {
        await this.options.store.create(record);
      } catch (error) {
        const concurrent = await this.options.store.get(delegationId);
        if (!concurrent) throw error;
        assertSpawnIdentity(concurrent, fingerprint, context);
        return concurrent;
      }
    }

    let snapshot: DelegationAdapterSnapshot;
    try {
      snapshot = await this.options.adapter.spawn(
        { delegationId, request: launch },
        context,
      );
    } catch (error) {
      return this.applySnapshot(record, failedSnapshot(error));
    }
    let applied: DelegationRecord;
    try {
      applied = await this.applySnapshot(record, snapshot);
    } catch (error) {
      if (
        snapshot.adapterHandle !== undefined
        && !TERMINAL_STATES.has(snapshot.state)
      ) {
        try {
          await this.options.adapter.cancel(
            snapshot.adapterHandle,
            cleanupContext(context),
          );
        } catch (cancelError) {
          throw new AggregateError(
            [error, cancelError],
            `Delegation "${delegationId}" with host session "${snapshot.adapterHandle}" could not be published or cancelled.`,
          );
        }
      }
      throw error;
    }
    if (
      snapshot.adapterHandle !== undefined
      && !TERMINAL_STATES.has(snapshot.state)
      && TERMINAL_STATES.has(applied.state)
    ) {
      await this.options.adapter.cancel(
        snapshot.adapterHandle,
        cleanupContext(context),
      );
    }
    return applied;
  }

  async continue(
    request: DelegationContinueRequest,
    context: DelegationContext = {},
  ): Promise<DelegationContinuationResult> {
    requireText(request.prompt, 'prompt');
    throwIfAborted(context);
    assertManagedMutation(context);

    const record = await this.requireRecord(request.delegationId);
    assertCaller(record, context);
    if (record.finalized) return record;
    if (record.state === 'failed') return record;
    const resumesCompletedTurn = record.state === 'done';
    let snapshot: DelegationAdapterSnapshot;
    try {
      snapshot = await this.options.adapter.continue(
        requireAdapterHandle(record),
        request.prompt,
        context,
      );
    } catch (error) {
      return this.applySnapshot(
        record,
        failedSnapshot(error),
        resumesCompletedTurn,
      );
    }
    const applied = await this.applySnapshot(record, snapshot, resumesCompletedTurn);
    return snapshot.continuationDelivery === undefined
      ? applied
      : { ...applied, continuationDelivery: snapshot.continuationDelivery };
  }

  async recover(request: DelegationRecoverRequest, context: DelegationContext = {}): Promise<DelegationRecord> {
    requireText(request.delegationId, 'delegationId');
    requireText(request.reason, 'reason');
    requireText(request.idempotencyKey, 'idempotencyKey');
    if (request.reason.length > 2000 || request.idempotencyKey.length > 256) throw new Error('Recovery inputs exceed their bounds.');
    if (request.expectedError === undefined) throw new Error('Recovery requires the expected failure.');
    throwIfAborted(context);
    assertManagedMutation(context);
    let record = await this.requireRecord(request.delegationId);
    assertCaller(record, context);
    if (recoveryMatches(record, request)) return record;
    assertRecoverable(record, request);
    if (!this.options.adapter.recover) throw new Error('The delegation adapter does not support explicit recovery.');
    const handle = requireAdapterHandle(record);
    const snapshot = await this.options.adapter.recover(handle, context);
    throwIfAborted(context);
    if ((snapshot.state !== 'running' && snapshot.state !== 'done') ||
      (snapshot.adapterHandle !== undefined && snapshot.adapterHandle !== handle) ||
      (record.sessionId !== undefined && snapshot.sessionId !== undefined && snapshot.sessionId !== record.sessionId)) {
      throw new Error('Recovery requires the same existing live execution.');
    }
    // Recheck after the host read so a changed failure/finalization is never overwritten.
    record = await this.requireRecord(request.delegationId);
    assertCaller(record, context);
    if (recoveryMatches(record, request)) return record;
    assertRecoverable(record, request);
    if (record.adapterHandle !== handle) throw new Error('The recovery target changed during host verification.');
    const recovered: DelegationRecord = {
      ...record,
      ...(snapshot.executionId !== undefined && snapshot.executionId !== record.executionId
        ? { usage: undefined, usageByModel: undefined, model: undefined, reasoningEffort: undefined }
        : {}),
      ...executionMetadata(snapshot),
      state: snapshot.state,
      recovery: { idempotencyKey: request.idempotencyKey, reason: request.reason, previousError: request.expectedError },
    };
    delete (recovered as { error?: unknown }).error;
    delete (recovered as { result?: unknown }).result;
    await this.options.store.update(recovered);
    return recovered;
  }

  async wait(
    request: DelegationWaitRequest,
    context: DelegationContext = {},
  ): Promise<DelegationRecord> {
    throwIfAborted(context);
    const record = await this.requireRecord(request.delegationId);
    assertCaller(record, context);
    if (TERMINAL_STATES.has(record.state)) return record;
    let snapshot: DelegationAdapterSnapshot;
    try {
      snapshot = await this.options.adapter.wait(
        requireAdapterHandle(record),
        context,
      );
    } catch (error) {
      return this.applySnapshot(record, failedSnapshot(error));
    }
    return this.applySnapshot(record, snapshot);
  }

  async complete(
    request: DelegationWaitRequest,
    context: DelegationContext = {},
  ): Promise<DelegationRecord> {
    throwIfAborted(context);
    assertManagedMutation(context);
    let record = await this.requireRecord(request.delegationId);
    assertCaller(record, context);
    const launch = this.launches.get(record.delegationId);
    if (record.state === 'pending' && launch) record = await launch;
    if (record.finalized || record.state === 'failed') return record;
    if (!this.options.adapter.complete) throw new Error('The delegation adapter does not support explicit finalization.');
    const active = this.completions.get(record.delegationId);
    if (active) return active;
    const completion = (async () => {
      const snapshot = await this.options.adapter.complete!(requireAdapterHandle(record), context, record.delegationId);
      if (snapshot.state !== 'done') throw new Error('Delegation finalization did not complete.');
      return this.applySnapshot(record, snapshot, true, true);
    })();
    this.completions.set(record.delegationId, completion);
    try {
      return await completion;
    } finally {
      this.completions.delete(record.delegationId);
    }
  }

  async pause(
    request: DelegationPauseRequest,
    context: DelegationContext = {},
  ): Promise<DelegationRecord> {
    requireText(request.reason, 'reason');
    throwIfAborted(context);
    assertManagedMutation(context);
    const record = await this.requireRecord(request.delegationId);
    assertCaller(record, context);
    if (TERMINAL_STATES.has(record.state)) return record;
    await this.options.adapter.pause(
      requireAdapterHandle(record),
      request.reason,
      context,
    );
    return this.requireRecord(record.delegationId);
  }

  async cancel(
    request: DelegationCancelRequest,
    context: DelegationContext = {},
  ): Promise<readonly DelegationRecord[]> {
    throwIfAborted(context);
    assertManagedMutation(context);
    const target = await this.requireRecord(request.delegationId);
    assertCaller(target, context);
    const records = request.recursive
      ? descendantsOf(target, await this.options.store.list())
      : [target];
    return Promise.all(
      records.map(async (selected) => {
        const record = await this.requireRecord(selected.delegationId);
        if (TERMINAL_STATES.has(record.state)) return record;
        let snapshot: DelegationAdapterSnapshot;
        try {
          snapshot = await this.options.adapter.cancel(
            requireAdapterHandle(record),
            cleanupContext(context),
          );
        } catch (error) {
          return this.applySnapshot(record, failedSnapshot(error));
        }
        return this.applySnapshot(record, terminalCancellation(snapshot));
      }),
    );
  }

  private async requireRecord(
    delegationId: string,
  ): Promise<DelegationRecord> {
    const record = await this.options.store.get(delegationId);
    if (!record) {
      throw new Error(`Delegation "${delegationId}" was not found.`);
    }
    return record;
  }

  private async applySnapshot(
    record: DelegationRecord,
    snapshot: DelegationAdapterSnapshot,
    resumesCompletedTurn = false,
    finalized = false,
  ): Promise<DelegationRecord> {
    const current = await this.requireRecord(record.delegationId);
    if (current.finalized) {
      // Completion may be reported inside a turn, before its final usage event.
      // Accept that same turn's final measurements without reopening its task.
      if (snapshot.executionId !== undefined && snapshot.executionId === current.executionId) {
        const measured = { ...current, ...executionMetadata(snapshot) };
        await this.options.store.update(measured);
        return measured;
      }
      return current;
    }
    if (
      TERMINAL_STATES.has(current.state)
      && !(resumesCompletedTurn && current.state === 'done')
    ) {
      return current;
    }
    const updated: DelegationRecord = {
      ...current,
      ...(snapshot.executionId !== undefined && snapshot.executionId !== current.executionId
        ? { usage: undefined, usageByModel: undefined, model: undefined, reasoningEffort: undefined }
        : {}),
      delegationId: current.delegationId,
      state: snapshot.state,
      ...(current.parentDelegationId === undefined
        ? {}
        : { parentDelegationId: current.parentDelegationId }),
      ...((snapshot.adapterHandle ?? current.adapterHandle) === undefined
        ? {}
        : { adapterHandle: snapshot.adapterHandle ?? current.adapterHandle }),
      ...(snapshot.result === undefined ? {} : { result: snapshot.result }),
      ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
      ...(snapshot.changeRefs === undefined ? {} : { changeRefs: snapshot.changeRefs }),
      ...executionMetadata(snapshot),
      ...(finalized ? { finalized: true } : {}),
    };
    if (snapshot.result === undefined) delete (updated as { result?: unknown }).result;
    if (snapshot.error === undefined) delete (updated as { error?: unknown }).error;
    await this.options.store.update(updated);
    return updated;
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertManagedMutation(context: DelegationContext): void {
  const metadata = context.invocation?.metadata;
  if (typeof metadata?.runtimeTaskController === 'string'
    && metadata.runtimeExtensionIdentity !== metadata.runtimeTaskController) {
    throw new Error('Managed agents must use their extension task operations to mutate delegations.');
  }
}

function assertCaller(record: DelegationRecord, context: DelegationContext): void {
  const principal = context.invocation?.principal.id;
  const session = context.scope?.sessionId ?? context.invocation?.scope?.sessionId;
  if (record.ownerPrincipalId && record.ownerPrincipalId !== principal) {
    throw new Error('Delegation belongs to another principal.');
  }
  const authenticatedDelegation = context.invocation?.metadata?.delegationId;
  if (record.ownerSessionId && session !== record.ownerSessionId && session !== record.sessionId
    && authenticatedDelegation !== record.delegationId) {
    throw new Error('Delegation belongs to another session.');
  }
}

function assertSpawnIdentity(record: DelegationRecord, fingerprint: string, context: DelegationContext): void {
  assertCaller(record, context);
  if (record.spawnFingerprint !== fingerprint) throw new Error('Delegation retry identity was reused with different launch inputs.');
}

function executionMetadata(snapshot: DelegationAdapterSnapshot): Partial<DelegationRecord> {
  return {
    ...(snapshot.sessionId === undefined ? {} : { sessionId: snapshot.sessionId }),
    ...(snapshot.executionId === undefined ? {} : { executionId: snapshot.executionId }),
    ...(snapshot.transcriptRef === undefined ? {} : { transcriptRef: snapshot.transcriptRef }),
    ...(snapshot.model === undefined ? {} : { model: snapshot.model }),
    ...(snapshot.reasoningEffort === undefined ? {} : { reasoningEffort: snapshot.reasoningEffort }),
    ...(snapshot.usage === undefined ? {} : { usage: snapshot.usage }),
    ...(snapshot.usageByModel === undefined ? {} : { usageByModel: snapshot.usageByModel }),
  };
}

function launchRequest(request: DelegationSpawnRequest): DelegationLaunchRequest {
  return {
    prompt: request.prompt,
    ...(request.backend === undefined ? {} : { backend: request.backend }),
    ...(request.scope === undefined ? {} : { scope: request.scope }),
    ...(request.role === undefined ? {} : { role: request.role }),
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: request.reasoningEffort }),
    ...(request.workspaceMode === undefined
      ? {}
      : { workspaceMode: request.workspaceMode }),
    ...(request.baseRef === undefined ? {} : { baseRef: request.baseRef }),
    ...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
    ...(request.tools === undefined ? {} : { tools: [...request.tools] }),
    ...(request.attachments === undefined ? {} : { attachments: [...request.attachments] }),
  };
}

function descendantsOf(
  target: DelegationRecord,
  records: readonly DelegationRecord[],
): DelegationRecord[] {
  const selected = new Set([target.delegationId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (record.parentDelegationId && selected.has(record.parentDelegationId)) {
        if (!selected.has(record.delegationId)) {
          selected.add(record.delegationId);
          changed = true;
        }
      }
    }
  }
  return records.filter(
    (record) =>
      record.delegationId === target.delegationId
      || (selected.has(record.delegationId)
        && !TERMINAL_STATES.has(record.state)),
  );
}

function failedSnapshot(error: unknown): DelegationAdapterSnapshot {
  return {
    state: 'failed',
    error: error instanceof Error ? error.message : String(error),
  };
}

function terminalCancellation(
  snapshot: DelegationAdapterSnapshot,
): DelegationAdapterSnapshot {
  return TERMINAL_STATES.has(snapshot.state)
    ? snapshot
    : {
        ...snapshot,
        state: 'failed',
        error: snapshot.error ?? 'Delegation was cancelled.',
      };
}

function requireAdapterHandle(record: DelegationRecord): string {
  if (!record.adapterHandle) {
    throw new Error(`Delegation "${record.delegationId}" has no adapter handle.`);
  }
  return record.adapterHandle;
}

function requireText(value: string, field: string): void {
  if (!value.trim()) throw new TypeError(`${field} must not be empty.`);
}

function cleanupContext(context: DelegationContext): DelegationContext {
  return context.scope === undefined ? {} : { scope: context.scope };
}

function throwIfAborted(context: DelegationContext): void {
  if (!context.signal?.aborted) return;
  throw context.signal.reason ?? Object.assign(new Error('Delegation was cancelled.'), {
    name: 'AbortError',
  });
}

function recoveryMatches(record: DelegationRecord, request: DelegationRecoverRequest): boolean {
  if (record.recovery?.idempotencyKey !== request.idempotencyKey) return false;
  if (record.recovery.reason !== request.reason || !isDeepStrictEqual(record.recovery.previousError, request.expectedError)) {
    throw new Error('Recovery retry identity was reused with different inputs.');
  }
  return true;
}

function assertRecoverable(record: DelegationRecord, request: DelegationRecoverRequest): void {
  if (record.finalized || record.state !== 'failed' || !isDeepStrictEqual(record.error, request.expectedError)) {
    throw new Error('Recovery requires the matching nonfinalized failed record.');
  }
}
