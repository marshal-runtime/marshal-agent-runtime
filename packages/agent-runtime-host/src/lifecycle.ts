import * as fs from 'node:fs/promises';
import { constants as fsConstants, type Stats } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  DurableLifecycleEventCoordinator,
  withLifecycleReceipt,
} from '@marshal/agent-runtime-provider-kit';
import { sameStableFileIdentity } from '@marshal/agent-runtime-core';
import type {
  RuntimeLifecyclePort,
  RuntimeSessionEndRequest,
  RuntimeSessionStartRequest,
  RuntimeTurnObservation,
} from './types.js';
import { isContained, scopeFileName } from './state.js';

const MAX_ADDITIONAL_CONTEXT_CHARACTERS = 32_000;

interface RegisteredLifecycleDelegate {
  readonly delegate: RuntimeLifecyclePort;
  readonly inFlight: Set<Promise<unknown>>;
  active: boolean;
}

export class ComposedRuntimeLifecycle implements RuntimeLifecyclePort {
  private readonly journalDirectory: string;
  private readonly lifecycleEvents: DurableLifecycleEventCoordinator;
  private readonly delegates = new Set<RegisteredLifecycleDelegate>();

  constructor(
    stateRoot: string,
    delegates: readonly RuntimeLifecyclePort[],
    protectedResultRoot = path.join(stateRoot, 'protected-lifecycle-results'),
  ) {
    this.journalDirectory = path.join(stateRoot, 'lifecycle');
    this.lifecycleEvents = new DurableLifecycleEventCoordinator(
      path.join(this.journalDirectory, 'host-events'),
      { resultDirectory: path.join(protectedResultRoot, 'host-events') },
    );
    if (!isContained(stateRoot, this.journalDirectory)) {
      throw new Error('Lifecycle journal escaped runtime state.');
    }
    for (const delegate of delegates) this.register(delegate);
  }

  register(delegate: RuntimeLifecyclePort): { dispose(): Promise<void> } {
    if (
      !delegate
      || typeof delegate.startSession !== 'function'
      || typeof delegate.observeTurn !== 'function'
      || typeof delegate.endSession !== 'function'
    ) {
      throw new TypeError('Runtime lifecycle delegate is invalid.');
    }
    const registered: RegisteredLifecycleDelegate = {
      delegate,
      inFlight: new Set(),
      active: true,
    };
    this.delegates.add(registered);
    let disposeOperation: Promise<void> | undefined;
    return Object.freeze({
      dispose: () => {
        disposeOperation ??= this.unregister(registered);
        return disposeOperation;
      },
    });
  }

  async startSession(request: RuntimeSessionStartRequest): Promise<unknown> {
    return this.apply('startSession', 'session_start', request);
  }

  async observeTurn(request: RuntimeTurnObservation): Promise<unknown> {
    return this.apply('observeTurn', request.kind, request);
  }

  async endSession(request: RuntimeSessionEndRequest): Promise<unknown> {
    return this.apply('endSession', 'session_end', request);
  }

  private async apply(
    method: keyof RuntimeLifecyclePort,
    kind: string,
    request: RuntimeSessionStartRequest | RuntimeTurnObservation | RuntimeSessionEndRequest,
  ): Promise<unknown> {
    return withLifecycleReceipt(
      await this.lifecycleEvents.apply(kind, request, async (normalized) => {
        await this.append(normalized.sessionId, kind, normalized);
        return this.dispatch(method, normalized);
      }),
    );
  }

  private async dispatch(
    method: keyof RuntimeLifecyclePort,
    request: RuntimeSessionStartRequest | RuntimeTurnObservation | RuntimeSessionEndRequest,
  ): Promise<unknown> {
    const settled = await Promise.allSettled(
      [...this.delegates]
        .filter((registered) => registered.active)
        .map((registered) =>
          this.invoke(registered, method, request),
      ),
    );
    const contexts = settled
      .filter((result): result is PromiseFulfilledResult<unknown> => result.status === 'fulfilled')
      .map((result) => extractAdditionalContext(result.value))
      .filter((value): value is string => Boolean(value));
    const diagnostics = settled
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => ({
        level: 'warning',
        code: 'lifecycle_delegate_failed',
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      }));
    const additionalContext = contexts.join('\n\n').slice(0, MAX_ADDITIONAL_CONTEXT_CHARACTERS);
    return {
      ...(additionalContext ? { additionalContext } : {}),
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
    };
  }

  private invoke(
    registered: RegisteredLifecycleDelegate,
    method: keyof RuntimeLifecyclePort,
    request: RuntimeSessionStartRequest | RuntimeTurnObservation | RuntimeSessionEndRequest,
  ): Promise<unknown> {
    let operation!: Promise<unknown>;
    operation = Promise.resolve().then(() =>
      (registered.delegate[method] as (value: typeof request) => Promise<unknown>)
        .call(registered.delegate, request),
    ).finally(() => {
      registered.inFlight.delete(operation);
    });
    registered.inFlight.add(operation);
    return operation;
  }

  private async unregister(registered: RegisteredLifecycleDelegate): Promise<void> {
    registered.active = false;
    this.delegates.delete(registered);
    await Promise.allSettled([...registered.inFlight]);
  }

  private async append(sessionId: string, kind: string, payload: unknown): Promise<void> {
    await ensureRealJournalDirectory(this.journalDirectory);
    const target = path.join(this.journalDirectory, scopeFileName('session', sessionId));
    if (!isContained(this.journalDirectory, target)) {
      throw new Error('Lifecycle journal target escaped runtime state.');
    }
    const line = `${JSON.stringify({ version: 2, kind, at: new Date().toISOString(), event: privateEventRecord(payload) })}\n`;
    const flags = fsConstants.O_CREAT
      | fsConstants.O_APPEND
      | fsConstants.O_WRONLY
      | (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await fs.open(target, flags, 0o600);
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new Error('Lifecycle journal target must be a regular file.');
      await attestOpenJournalIdentity(target, before);
      await handle.writeFile(line, 'utf8');
      await handle.sync();
      const after = await handle.stat();
      if (before.dev !== after.dev || before.ino !== after.ino) {
        throw new Error('Lifecycle journal identity changed during append.');
      }
      await attestOpenJournalIdentity(target, after);
    } finally {
      await handle.close();
    }
  }
}

async function ensureRealJournalDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Lifecycle journal directory must be a real directory.');
  }
  if (!samePath(await fs.realpath(directory), directory)) {
    throw new Error('Lifecycle journal directory cannot traverse a symbolic link or junction.');
  }
}

async function attestOpenJournalIdentity(
  target: string,
  opened: Stats,
): Promise<void> {
  const linked = await fs.lstat(target);
  if (linked.isSymbolicLink() || !linked.isFile() || !sameStableFileIdentity(linked, opened)) {
    throw new Error('Lifecycle journal path does not identify the opened file.');
  }
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function privateEventRecord(payload: unknown): Readonly<Record<string, unknown>> {
  const value = isRecord(payload) ? payload : {};
  return {
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
    eventId: typeof value.eventId === 'string' ? value.eventId : undefined,
    protocolVersion: typeof value.protocolVersion === 'string' ? value.protocolVersion : undefined,
    agentId: typeof value.agentId === 'string' ? value.agentId : undefined,
    toolName: typeof value.toolName === 'string' ? value.toolName : undefined,
    payloadDigest: createHash('sha256').update(stableJson(payload)).digest('hex'),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(',')}}`;
}

export function extractAdditionalContext(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const candidate of [
    record.additionalContext,
    record.injectedContext,
    record.context,
    isRecord(record.output) ? record.output.additionalContext : undefined,
    isRecord(record.result) ? record.result.additionalContext : undefined,
  ]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
