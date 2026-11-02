import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';

const SPOOL_VERSION = 1 as const;
const DEFAULT_MAX_EVENT_BYTES = 64 * 1024;
const DEFAULT_MAX_EPOCH_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_EPOCH_EVENTS = 4_096;
const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1_000;
const MAX_DIRECTORY_ENTRIES = 4_096;
const MAX_IDENTIFIER_LENGTH = 4_096;
const MAX_METADATA_KEYS = 128;

export type TranscriptEventKind =
  | 'session_start'
  | 'user_message'
  | 'tool_result'
  | 'assistant_turn'
  | 'session_end'
  | 'subagent_start'
  | 'subagent_end'
  | 'compaction_segment';

export interface TranscriptLineage {
  readonly parentSessionId?: string;
  readonly parentEpochId?: string;
}

export type SealedTranscriptDescriptor =
  | TranscriptReviewDescriptor
  | TranscriptAbandonedDescriptor;

export interface TranscriptObservation {
  readonly eventId: string;
  readonly sessionId: string;
  readonly kind: 'user_message' | 'tool_result' | 'assistant_turn';
  readonly content: unknown;
  readonly toolName?: string;
  readonly agentId?: string;
  readonly workspacePath?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface TranscriptEpochReference {
  readonly sessionId: string;
  readonly epochId: string;
}

export interface TranscriptSpoolOptions {
  readonly rootDirectory: string;
  readonly deliveryTargetIdentity?: string;
  readonly maxEventBytes?: number;
  readonly maxEpochBytes?: number;
  readonly maxEpochEvents?: number;
  readonly staleAfterMs?: number;
  readonly now?: () => Date;
}

export interface TranscriptEventInput extends TranscriptLineage {
  readonly eventId: string;
  readonly sessionId: string;
  readonly kind: TranscriptEventKind;
  readonly content?: unknown;
  readonly toolName?: string;
  readonly agentId?: string;
  readonly workspacePath?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly segmentId?: string;
  readonly fromSequence?: number;
  readonly toSequence?: number;
}

export interface TranscriptCompactionSegmentInput extends TranscriptLineage {
  readonly eventId: string;
  readonly sessionId: string;
  readonly segmentId: string;
  readonly summary: string;
  readonly fromSequence?: number;
  readonly toSequence?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TranscriptAppendResult {
  readonly epochId: string;
  readonly sequence: number;
  readonly duplicate: boolean;
}

export interface TranscriptReviewDescriptor extends TranscriptLineage {
  readonly version: typeof SPOOL_VERSION;
  readonly kind: 'transcript_review';
  readonly descriptorId: string;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly epochId: string;
  readonly sealedPath: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly eventCount: number;
  readonly compactionSegmentCount: number;
  readonly sealedAt: string;
}

export interface TranscriptAbandonedDescriptor extends TranscriptLineage {
  readonly version: typeof SPOOL_VERSION;
  readonly kind: 'transcript_abandoned';
  readonly descriptorId: string;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly epochId: string;
  readonly abandonedPath: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly eventCount: number;
  readonly abandonedAt: string;
}

interface EpochState {
  readonly epochId: string;
  readonly sessionId: string;
  readonly filePath: string;
  readonly firstEvent: EpochLine;
  readonly lines: readonly EpochLine[];
  readonly byteLength: number;
}

interface EpochLine extends TranscriptLineage {
  readonly version: typeof SPOOL_VERSION;
  readonly epochId: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly kind: 'epoch_start' | TranscriptEventKind;
  readonly eventId: string;
  readonly at: string;
  readonly eventDigest: string;
  readonly content?: unknown;
  readonly toolName?: string;
  readonly agentId?: string;
  readonly workspacePath?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly segmentId?: string;
  readonly fromSequence?: number;
  readonly toSequence?: number;
}

interface StoredSeal extends TranscriptReviewDescriptor {}

export class TranscriptSpool {
  readonly rootDirectory: string;
  readonly maxEventBytes: number;
  readonly maxEpochBytes: number;
  readonly maxEpochEvents: number;
  readonly staleAfterMs: number;
  readonly #deliveryTargetDigest: string | undefined;
  readonly #now: () => Date;

  constructor(options: TranscriptSpoolOptions) {
    if (!path.isAbsolute(options.rootDirectory)) {
      throw new Error('Transcript spool rootDirectory must be absolute.');
    }
    this.rootDirectory = path.resolve(options.rootDirectory);
    this.maxEventBytes = boundedPositiveInteger(
      options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES,
      'maxEventBytes',
      1_024 * 1_024,
    );
    this.maxEpochBytes = boundedPositiveInteger(
      options.maxEpochBytes ?? DEFAULT_MAX_EPOCH_BYTES,
      'maxEpochBytes',
      256 * 1_024 * 1_024,
    );
    this.maxEpochEvents = boundedPositiveInteger(
      options.maxEpochEvents ?? DEFAULT_MAX_EPOCH_EVENTS,
      'maxEpochEvents',
      1_000_000,
    );
    this.staleAfterMs = boundedNonNegativeInteger(
      options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
      'staleAfterMs',
      31 * 24 * 60 * 60 * 1_000,
    );
    this.#deliveryTargetDigest = options.deliveryTargetIdentity
      ? digest(options.deliveryTargetIdentity)
      : undefined;
    this.#now = options.now ?? (() => new Date());
  }

  async startSession(input: {
    readonly eventId: string;
    readonly sessionId: string;
    readonly agentId?: string;
    readonly workspacePath?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly parentSessionId?: string;
    readonly parentEpochId?: string;
  }): Promise<TranscriptAppendResult> {
    return this.append({
      ...input,
      kind: 'session_start',
    });
  }

  async append(input: TranscriptEventInput): Promise<TranscriptAppendResult> {
    validateEventInput(input);
    await this.ensureRoot();
    return this.withLock(() => this.appendUnlocked(input));
  }

  async openEpochId(sessionId: string): Promise<string | undefined> {
    validateIdentifier(sessionId, 'sessionId');
    await this.ensureRoot();
    return this.withLock(async () => (await this.findOpenEpoch(sessionId))?.epochId);
  }

  async appendCompactionSegment(
    input: TranscriptCompactionSegmentInput,
  ): Promise<TranscriptAppendResult> {
    validateCompactionInput(input);
    await this.ensureRoot();
    return this.withLock(async () => {
      const epoch = await this.findOpenEpoch(input.sessionId);
      if (!epoch) {
        throw new Error(`No open transcript epoch exists for compaction in session ${input.sessionId}.`);
      }
      const priorSegments = epoch.lines.filter((line) => line.kind === 'compaction_segment');
      const priorSegment = priorSegments.at(-1);
      const fromSequence = input.fromSequence ?? (priorSegment ? priorSegment.sequence + 1 : 1);
      const toSequence = input.toSequence ?? epoch.lines.at(-1)!.sequence;
      if (toSequence < fromSequence) {
        throw new Error('A compaction segment must reference at least one prior transcript event.');
      }
      return this.appendUnlocked({
        ...input,
        kind: 'compaction_segment',
        content: input.summary,
        fromSequence,
        toSequence,
        metadata: {
          ...(input.metadata ?? {}),
          compactionSegment: priorSegments.length + 1,
        },
      });
    });
  }

  async seal(sessionId: string): Promise<TranscriptReviewDescriptor> {
    validateIdentifier(sessionId, 'sessionId');
    await this.ensureRoot();
    return this.withLock(() => this.sealUnlocked(sessionId));
  }

  async sealWithEvent(input: TranscriptEventInput): Promise<TranscriptReviewDescriptor> {
    validateEventInput(input);
    await this.ensureRoot();
    return this.withLock(async () => {
      const replayed = await this.findStoredSealForEvent(input);
      if (replayed) return replayed;
      await this.appendUnlocked(input);
      return this.sealUnlocked(input.sessionId);
    });
  }

  async checkpointWithEvent(
    input: TranscriptEventInput,
  ): Promise<TranscriptEpochReference | TranscriptReviewDescriptor> {
    validateEventInput(input);
    await this.ensureRoot();
    return this.withLock(async () => {
      const replayed = await this.findStoredSealForEvent(input);
      if (replayed) return replayed;
      const checkpoint = await this.appendUnlocked(input);
      return { sessionId: input.sessionId, epochId: checkpoint.epochId };
    });
  }

  async observations(
    descriptor: SealedTranscriptDescriptor,
  ): Promise<readonly TranscriptObservation[]> {
    const epoch = await this.readSealedEpoch(descriptor);
    return epoch.lines
      .map((line) => observationFromLine(line, epoch.epochId, descriptor.descriptorId))
      .filter((observation): observation is TranscriptObservation => observation !== undefined);
  }

  async deliverUndelivered(
    source: TranscriptEpochReference | SealedTranscriptDescriptor,
    deliver: (observation: TranscriptObservation) => Promise<void>,
  ): Promise<number> {
    validateIdentifier(source.sessionId, 'sessionId');
    validateIdentifier(source.epochId, 'epochId');
    await this.ensureRoot();
    return this.withLock(async () => {
      const descriptor = 'kind' in source ? source : undefined;
      const epoch = descriptor
        ? await this.readSealedEpoch(descriptor)
        : await this.findOpenEpoch(source.sessionId);
      if (!epoch || epoch.epochId !== source.epochId) {
        throw new Error(`Transcript epoch ${source.epochId} is not available for delivery.`);
      }
      const cursorPath = path.join(
        this.rootDirectory,
        `delivery-${digest(epoch.epochId)}${
          this.#deliveryTargetDigest ? `-${this.#deliveryTargetDigest}` : ''
        }.cursor`,
      );
      let cursor = await readDeliveryCursor(
        cursorPath,
        this.rootDirectory,
        this.maxEpochBytes,
        epoch.lines.at(-1)!.sequence,
      );
      let delivered = 0;
      for (const line of epoch.lines) {
        if (line.sequence <= cursor) continue;
        const observation = observationFromLine(line, epoch.epochId, descriptor?.descriptorId);
        if (observation) {
          await deliver(observation);
          delivered += 1;
          await appendChecked(cursorPath, `${line.sequence}\n`, this.rootDirectory);
          cursor = line.sequence;
        }
      }
      const finalSequence = epoch.lines.at(-1)!.sequence;
      if (cursor < finalSequence) {
        await appendChecked(cursorPath, `${finalSequence}\n`, this.rootDirectory);
      }
      return delivered;
    });
  }

  private async appendUnlocked(input: TranscriptEventInput): Promise<TranscriptAppendResult> {
    const epoch = await this.findOrCreateOpenEpoch(
      input.sessionId,
      input.parentSessionId,
      input.parentEpochId,
    );
    const existing = epoch.lines.find(
      (line) => line.kind !== 'epoch_start' && line.eventId === input.eventId,
    );
    const eventDigest = digest(stableJson(input));
    if (existing) {
      if (existing.eventDigest !== eventDigest) {
        throw new Error(`Transcript event id collision: ${input.eventId}`);
      }
      return {
        epochId: epoch.epochId,
        sequence: existing.sequence,
        duplicate: true,
      };
    }

    if (epoch.lines.length - 1 >= this.maxEpochEvents) {
      throw new Error(`Transcript epoch exceeds ${this.maxEpochEvents} events.`);
    }
    const line = this.createEventLine(input, epoch);
    const encoded = encodeLine(line, this.maxEventBytes);
    if (epoch.byteLength + Buffer.byteLength(encoded, 'utf8') > this.maxEpochBytes) {
      throw new Error(`Transcript epoch exceeds ${this.maxEpochBytes} bytes.`);
    }
    await appendChecked(epoch.filePath, encoded, this.rootDirectory);
    return {
      epochId: epoch.epochId,
      sequence: line.sequence,
      duplicate: false,
    };
  }

  private async sealUnlocked(sessionId: string): Promise<TranscriptReviewDescriptor> {
    const open = await this.findOpenEpoch(sessionId);
    if (!open) {
      const stored = await this.findStoredSeal(sessionId);
      if (stored) return stored;
      throw new Error(`No open transcript epoch exists for session ${sessionId}.`);
    }

    const sealedPath = replaceSuffix(open.filePath, '.open.jsonl', '.sealed.jsonl');
    const existingSealed = await inspectFile(sealedPath, this.rootDirectory);
    if (existingSealed) {
      const existingDigest = digest(existingSealed.bytes);
      const openDigest = digest(await readBoundedFile(
        open.filePath,
        this.rootDirectory,
        this.maxEpochBytes,
      ));
      if (existingDigest !== openDigest) {
        throw new Error('Transcript seal target already exists with different bytes.');
      }
      await fs.unlink(open.filePath);
    } else {
      await fs.rename(open.filePath, sealedPath);
    }

    const bytes = await readBoundedFile(sealedPath, this.rootDirectory, this.maxEpochBytes);
    const descriptor = this.createReviewDescriptor(open, sealedPath, bytes);
    const sealPath = replaceSuffix(sealedPath, '.sealed.jsonl', '.seal.json');
    const stored = await readJsonFile<StoredSeal>(
      sealPath,
      this.rootDirectory,
      this.maxEventBytes,
    );
    if (stored) {
      assertReviewDescriptor(stored);
      if (stored.sha256 !== descriptor.sha256 || stored.epochId !== descriptor.epochId) {
        throw new Error('Transcript seal descriptor does not match sealed bytes.');
      }
      return stored;
    }
    await atomicWrite(sealPath, `${stableJson(descriptor)}\n`, this.rootDirectory);
    return descriptor;
  }

  async recoverAbandoned(): Promise<readonly TranscriptAbandonedDescriptor[]> {
    await this.ensureRoot();
    return this.withLock(async () => {
      const entries = await boundedDirectoryEntries(this.rootDirectory);
      const recovered: TranscriptAbandonedDescriptor[] = [];
      for (const name of entries.filter((entry) => entry.endsWith('.open.jsonl'))) {
        const filePath = path.join(this.rootDirectory, name);
        const stat = await fs.lstat(filePath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new Error(`Transcript spool epoch must be a regular file: ${filePath}`);
        }
        if (this.#now().getTime() - stat.mtimeMs < this.staleAfterMs) continue;
        const epoch = await readEpoch(filePath, this.rootDirectory, this.maxEpochBytes);
        const abandonedPath = replaceSuffix(filePath, '.open.jsonl', '.abandoned.jsonl');
        if (await inspectFile(abandonedPath, this.rootDirectory)) {
          await fs.unlink(filePath);
          continue;
        }
        await fs.rename(filePath, abandonedPath);
        const bytes = await readBoundedFile(abandonedPath, this.rootDirectory, this.maxEpochBytes);
        const abandonedAt = this.#now().toISOString();
        const descriptor: TranscriptAbandonedDescriptor = {
          version: SPOOL_VERSION,
          kind: 'transcript_abandoned',
          descriptorId: digest(`${epoch.epochId}:${digest(bytes)}:abandoned`),
          idempotencyKey: `transcript:${epoch.epochId}:${digest(bytes)}:abandoned`,
          sessionId: epoch.sessionId,
          epochId: epoch.epochId,
          abandonedPath,
          sha256: digest(bytes),
          byteLength: bytes.length,
          eventCount: epoch.lines.length - 1,
          abandonedAt,
          ...(epoch.firstEvent.parentSessionId
            ? { parentSessionId: epoch.firstEvent.parentSessionId }
            : {}),
          ...(epoch.firstEvent.parentEpochId
            ? { parentEpochId: epoch.firstEvent.parentEpochId }
            : {}),
        };
        await atomicWrite(
          replaceSuffix(abandonedPath, '.abandoned.jsonl', '.abandoned.json'),
          `${stableJson(descriptor)}\n`,
          this.rootDirectory,
        );
        recovered.push(descriptor);
      }
      for (const name of entries.filter((entry) => entry.endsWith('.abandoned.json'))) {
        const descriptor = await readJsonFile<TranscriptAbandonedDescriptor>(
          path.join(this.rootDirectory, name),
          this.rootDirectory,
          this.maxEventBytes,
        );
        if (!descriptor) continue;
        assertAbandonedDescriptor(descriptor);
        if (!recovered.some((item) => item.descriptorId === descriptor.descriptorId)) {
          recovered.push(descriptor);
        }
      }
      return recovered;
    });
  }

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.rootDirectory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Transcript spool root must be a real directory.');
    }
    if (!samePath(await fs.realpath(this.rootDirectory), this.rootDirectory)) {
      throw new Error('Transcript spool root cannot traverse a symbolic link or junction.');
    }
  }

  private async findOrCreateOpenEpoch(
    sessionId: string,
    parentSessionId?: string,
    parentEpochId?: string,
  ): Promise<EpochState> {
    const existing = await this.findOpenEpoch(sessionId);
    if (existing) return existing;
    const epochId = randomUUID();
    const filePath = path.join(
      this.rootDirectory,
      `epoch-${digest(sessionId).slice(0, 32)}-${epochId}.open.jsonl`,
    );
    assertContained(this.rootDirectory, filePath);
    const firstEvent: EpochLine = {
      version: SPOOL_VERSION,
      epochId,
      sessionId,
      sequence: 0,
      kind: 'epoch_start',
      eventId: `epoch:${epochId}`,
      at: this.#now().toISOString(),
      eventDigest: digest(stableJson({ epochId, sessionId, parentSessionId, parentEpochId })),
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(parentEpochId ? { parentEpochId } : {}),
    };
    await atomicWrite(filePath, encodeLine(firstEvent, this.maxEventBytes), this.rootDirectory);
    return {
      epochId,
      sessionId,
      filePath,
      firstEvent,
      lines: [firstEvent],
      byteLength: Buffer.byteLength(encodeLine(firstEvent, this.maxEventBytes), 'utf8'),
    };
  }

  private async findOpenEpoch(sessionId: string): Promise<EpochState | undefined> {
    const entries = await boundedDirectoryEntries(this.rootDirectory);
    const matches: EpochState[] = [];
    for (const name of entries.filter((entry) => entry.endsWith('.open.jsonl'))) {
      const filePath = path.join(this.rootDirectory, name);
      const epoch = await readEpoch(filePath, this.rootDirectory, this.maxEpochBytes);
      if (epoch.sessionId === sessionId) matches.push(epoch);
    }
    if (matches.length > 1) {
      throw new Error(`Multiple open transcript epochs exist for session ${sessionId}.`);
    }
    return matches[0];
  }

  private async findStoredSeal(sessionId: string): Promise<TranscriptReviewDescriptor | undefined> {
    const entries = await boundedDirectoryEntries(this.rootDirectory);
    const seals: TranscriptReviewDescriptor[] = [];
    for (const name of entries.filter((entry) => entry.endsWith('.seal.json'))) {
      const seal = await readJsonFile<StoredSeal>(
        path.join(this.rootDirectory, name),
        this.rootDirectory,
        this.maxEventBytes,
      );
      if (!seal) continue;
      assertReviewDescriptor(seal);
      if (seal.sessionId === sessionId) seals.push(seal);
    }
    seals.sort((left, right) => left.sealedAt.localeCompare(right.sealedAt));
    return seals.at(-1);
  }

  private async findStoredSealForEvent(
    input: TranscriptEventInput,
  ): Promise<TranscriptReviewDescriptor | undefined> {
    const entries = await boundedDirectoryEntries(this.rootDirectory);
    const matches: TranscriptReviewDescriptor[] = [];
    const eventDigest = digest(stableJson(input));
    for (const name of entries.filter((entry) => entry.endsWith('.seal.json'))) {
      const seal = await readJsonFile<StoredSeal>(
        path.join(this.rootDirectory, name),
        this.rootDirectory,
        this.maxEventBytes,
      );
      if (!seal) continue;
      assertReviewDescriptor(seal);
      if (seal.sessionId !== input.sessionId) continue;
      const bytes = await readBoundedFile(
        seal.sealedPath,
        this.rootDirectory,
        this.maxEpochBytes,
      );
      if (bytes.length !== seal.byteLength || digest(bytes) !== seal.sha256) {
        throw new Error('Transcript descriptor integrity does not match transcript bytes.');
      }
      const epoch = await readEpoch(seal.sealedPath, this.rootDirectory, this.maxEpochBytes);
      if (epoch.epochId !== seal.epochId || epoch.sessionId !== seal.sessionId) {
        throw new Error('Transcript descriptor identity does not match transcript bytes.');
      }
      const event = epoch.lines.find(
        (line) => line.kind !== 'epoch_start' && line.eventId === input.eventId,
      );
      if (!event) continue;
      if (event.eventDigest !== eventDigest) {
        throw new Error(`Transcript event id collision: ${input.eventId}`);
      }
      matches.push(seal);
    }
    matches.sort((left, right) => left.sealedAt.localeCompare(right.sealedAt));
    return matches[0];
  }

  private async readSealedEpoch(
    descriptor: SealedTranscriptDescriptor,
  ): Promise<EpochState> {
    const filePath =
      descriptor.kind === 'transcript_review'
        ? descriptor.sealedPath
        : descriptor.abandonedPath;
    const bytes = await readBoundedFile(filePath, this.rootDirectory, this.maxEpochBytes);
    if (bytes.length !== descriptor.byteLength || digest(bytes) !== descriptor.sha256) {
      throw new Error('Transcript descriptor integrity does not match transcript bytes.');
    }
    const epoch = await readEpoch(filePath, this.rootDirectory, this.maxEpochBytes);
    if (epoch.epochId !== descriptor.epochId || epoch.sessionId !== descriptor.sessionId) {
      throw new Error('Transcript descriptor identity does not match transcript bytes.');
    }
    return epoch;
  }

  private createEventLine(input: TranscriptEventInput, epoch: EpochState): EpochLine {
    const line: EpochLine = {
      version: SPOOL_VERSION,
      epochId: epoch.epochId,
      sessionId: input.sessionId,
      sequence: epoch.lines.at(-1)!.sequence + 1,
      kind: input.kind,
      eventId: input.eventId,
      at: this.#now().toISOString(),
      eventDigest: digest(stableJson(input)),
      ...(input.content === undefined ? {} : { content: input.content }),
      ...(input.toolName ? { toolName: input.toolName } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(input.segmentId ? { segmentId: input.segmentId } : {}),
      ...(input.fromSequence === undefined ? {} : { fromSequence: input.fromSequence }),
      ...(input.toSequence === undefined ? {} : { toSequence: input.toSequence }),
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      ...(input.parentEpochId ? { parentEpochId: input.parentEpochId } : {}),
    };
    return line;
  }

  private createReviewDescriptor(
    epoch: EpochState,
    sealedPath: string,
    bytes: Buffer,
  ): TranscriptReviewDescriptor {
    const sha256 = digest(bytes);
    return {
      version: SPOOL_VERSION,
      kind: 'transcript_review',
      descriptorId: digest(`${epoch.epochId}:${sha256}`),
      idempotencyKey: `transcript:${epoch.epochId}:${sha256}`,
      sessionId: epoch.sessionId,
      epochId: epoch.epochId,
      sealedPath,
      sha256,
      byteLength: bytes.length,
      eventCount: epoch.lines.length - 1,
      compactionSegmentCount: epoch.lines.filter(
        (line) => line.kind === 'compaction_segment',
      ).length,
      sealedAt: this.#now().toISOString(),
      ...(epoch.firstEvent.parentSessionId
        ? { parentSessionId: epoch.firstEvent.parentSessionId }
        : {}),
      ...(epoch.firstEvent.parentEpochId
        ? { parentEpochId: epoch.firstEvent.parentEpochId }
        : {}),
    };
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = path.join(this.rootDirectory, '.spool.lock');
    assertContained(this.rootDirectory, lockPath);
    let handle: fs.FileHandle | undefined;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        handle = await fs.open(
          lockPath,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
          0o600,
        );
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (await recoverStaleLock(this.rootDirectory, lockPath)) continue;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    if (!handle) throw new Error('Transcript spool lock could not be acquired.');
    try {
      await handle.writeFile(`${process.pid}\n`, 'utf8');
      await handle.sync();
      return await operation();
    } finally {
      await handle.close();
      await fs.unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
}

async function recoverStaleLock(rootDirectory: string, lockPath: string): Promise<boolean> {
  let source: string;
  try {
    source = (await readBoundedFile(lockPath, rootDirectory, 32)).toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    return false;
  }
  if (!/^[1-9]\d*\n$/.test(source)) return false;
  const ownerPid = Number(source.trim());
  if (!Number.isSafeInteger(ownerPid) || isProcessAlive(ownerPid)) return false;

  const abandonedPath = path.join(rootDirectory, `.spool.lock.abandoned-${randomUUID()}`);
  assertContained(rootDirectory, abandonedPath);
  try {
    await fs.rename(lockPath, abandonedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  await fs.unlink(abandonedPath);
  return true;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Reclaim only when the OS definitively reports that the owner is gone.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function readEpoch(
  filePath: string,
  rootDirectory: string,
  maxBytes: number,
): Promise<EpochState> {
  const bytes = await readBoundedFile(filePath, rootDirectory, maxBytes);
  const lines = parseLines(bytes, filePath);
  const firstEvent = lines[0];
  if (
    !firstEvent
    || firstEvent.kind !== 'epoch_start'
    || firstEvent.sequence !== 0
    || !firstEvent.epochId
    || !firstEvent.sessionId
  ) {
    throw new Error(`Transcript epoch has an invalid epoch_start line: ${filePath}`);
  }
  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1]!;
    const current = lines[index]!;
    if (
      current.epochId !== firstEvent.epochId
      || current.sessionId !== firstEvent.sessionId
      || current.sequence !== previous.sequence + 1
    ) {
      throw new Error(`Transcript epoch ordering is invalid: ${filePath}`);
    }
  }
  return {
    epochId: firstEvent.epochId,
    sessionId: firstEvent.sessionId,
    filePath,
    firstEvent,
    lines,
    byteLength: bytes.length,
  };
}

function parseLines(bytes: Buffer, filePath: string): readonly EpochLine[] {
  const source = bytes.toString('utf8');
  if (!source.endsWith('\n')) throw new Error(`Transcript epoch must end with LF: ${filePath}`);
  return source
    .trimEnd()
    .split('\n')
    .map((line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`Transcript epoch contains invalid JSON: ${filePath}`);
      }
      if (!isRecord(parsed)) throw new Error(`Transcript epoch line must be an object: ${filePath}`);
      return parsed as unknown as EpochLine;
    });
}

async function appendChecked(filePath: string, encoded: string, rootDirectory: string): Promise<void> {
  assertContained(rootDirectory, filePath);
  const flags = fsConstants.O_APPEND
    | fsConstants.O_CREAT
    | fsConstants.O_WRONLY
    | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(filePath, flags, 0o600);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`Transcript epoch must be a regular file: ${filePath}`);
    const linked = await fs.lstat(filePath);
    if (linked.isSymbolicLink() || !linked.isFile()) {
      throw new Error(`Transcript epoch path is unsafe: ${filePath}`);
    }
    await handle.writeFile(encoded, 'utf8');
    await handle.sync();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error(`Transcript epoch identity changed during append: ${filePath}`);
    }
  } finally {
    await handle.close();
  }
}

async function atomicWrite(contentPath: string, content: string, rootDirectory: string): Promise<void> {
  assertContained(rootDirectory, contentPath);
  const existing = await fs.lstat(contentPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(`Transcript spool target is unsafe: ${contentPath}`);
    }
    throw new Error(`Transcript spool target already exists: ${contentPath}`);
  }
  const temporary = `${contentPath}.${randomUUID()}.tmp`;
  assertContained(rootDirectory, temporary);
  const handle = await fs.open(
    temporary,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, contentPath);
  } catch (error) {
    await fs.unlink(temporary).catch((cleanupError: NodeJS.ErrnoException) => {
      if (cleanupError.code !== 'ENOENT') throw cleanupError;
    });
    throw error;
  }
}

async function readBoundedFile(filePath: string, rootDirectory: string, maxBytes: number): Promise<Buffer> {
  assertContained(rootDirectory, filePath);
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Transcript file is unsafe: ${filePath}`);
  if (stat.size > maxBytes) throw new Error(`Transcript file exceeds ${maxBytes} bytes: ${filePath}`);
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes) {
      throw new Error(`Transcript file exceeds its bounded shape: ${filePath}`);
    }
    const bytes = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < bytes.length) {
      const read = await handle.read(bytes, total, bytes.length - total, total);
      if (read.bytesRead === 0) break;
      total += read.bytesRead;
    }
    if (total > maxBytes) throw new Error(`Transcript file exceeds ${maxBytes} bytes: ${filePath}`);
    const linked = await fs.lstat(filePath);
    if (linked.isSymbolicLink() || !linked.isFile()) {
      throw new Error(`Transcript file changed into an unsafe path: ${filePath}`);
    }
    return bytes.subarray(0, total);
  } finally {
    await handle.close();
  }
}

async function inspectFile(
  filePath: string,
  rootDirectory: string,
): Promise<{ readonly bytes: Buffer } | undefined> {
  const stat = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!stat) return undefined;
  return { bytes: await readBoundedFile(filePath, rootDirectory, DEFAULT_MAX_EPOCH_BYTES) };
}

async function readDeliveryCursor(
  filePath: string,
  rootDirectory: string,
  maxBytes: number,
  maximumSequence: number,
): Promise<number> {
  const existing = await inspectFile(filePath, rootDirectory);
  if (!existing) return 0;
  const bytes = await readBoundedFile(filePath, rootDirectory, maxBytes);
  const source = bytes.toString('utf8');
  if (!source.endsWith('\n')) {
    throw new Error(`Transcript delivery cursor must end with LF: ${filePath}`);
  }
  let cursor = 0;
  for (const line of source.trimEnd().split('\n')) {
    if (!/^\d+$/.test(line)) {
      throw new Error(`Transcript delivery cursor is invalid: ${filePath}`);
    }
    const sequence = Number(line);
    if (!Number.isSafeInteger(sequence) || sequence <= cursor || sequence > maximumSequence) {
      throw new Error(`Transcript delivery cursor is out of order: ${filePath}`);
    }
    cursor = sequence;
  }
  return cursor;
}

function observationFromLine(
  line: EpochLine,
  epochId: string,
  descriptorId?: string,
): TranscriptObservation | undefined {
  if (
    line.kind !== 'user_message'
    && line.kind !== 'tool_result'
    && line.kind !== 'assistant_turn'
    && line.kind !== 'compaction_segment'
    && line.kind !== 'subagent_start'
    && line.kind !== 'subagent_end'
  ) {
    return undefined;
  }
  return {
    eventId: line.eventId,
    sessionId: line.sessionId,
    kind: line.kind === 'user_message' || line.kind === 'assistant_turn'
      ? line.kind
      : 'tool_result',
    content: line.content,
    ...(line.toolName
      ? { toolName: line.toolName }
      : line.kind === 'compaction_segment'
        ? { toolName: 'transcript.compaction' }
        : line.kind === 'subagent_start' || line.kind === 'subagent_end'
          ? { toolName: `transcript.${line.kind}` }
          : {}),
    ...(line.agentId ? { agentId: line.agentId } : {}),
    ...(line.workspacePath ? { workspacePath: line.workspacePath } : {}),
    metadata: {
      ...(line.metadata ?? {}),
      ...(line.kind === 'compaction_segment'
        ? {
            transcriptEventKind: line.kind,
            compactionSegmentId: line.segmentId,
            compactionFromSequence: line.fromSequence,
            compactionToSequence: line.toSequence,
          }
        : line.kind === 'subagent_start' || line.kind === 'subagent_end'
          ? { transcriptEventKind: line.kind }
          : {}),
      turnIndex: line.sequence - 1,
      transcriptEpochId: epochId,
      transcriptSequence: line.sequence,
      transcriptEventDigest: line.eventDigest,
      ...(descriptorId ? { transcriptDescriptorId: descriptorId } : {}),
    },
  };
}

async function readJsonFile<T>(
  filePath: string,
  rootDirectory: string,
  maxBytes: number,
): Promise<T | undefined> {
  const stat = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!stat) return undefined;
  const source = (await readBoundedFile(filePath, rootDirectory, maxBytes)).toString('utf8');
  try {
    return JSON.parse(source) as T;
  } catch {
    throw new Error(`Transcript descriptor is not valid JSON: ${filePath}`);
  }
}

async function boundedDirectoryEntries(directory: string): Promise<readonly string[]> {
  const entries = await fs.readdir(directory);
  if (entries.length > MAX_DIRECTORY_ENTRIES) {
    throw new Error(`Transcript spool directory exceeds ${MAX_DIRECTORY_ENTRIES} entries.`);
  }
  return entries;
}

function encodeLine(line: EpochLine, maxBytes: number): string {
  const encoded = `${stableJson(line)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) {
    throw new Error(`Transcript event exceeds ${maxBytes} UTF-8 bytes.`);
  }
  return encoded;
}

function validateEventInput(input: TranscriptEventInput): void {
  validateIdentifier(input.eventId, 'eventId');
  validateIdentifier(input.sessionId, 'sessionId');
  if (![
    'session_start',
    'user_message',
    'tool_result',
    'assistant_turn',
    'session_end',
    'subagent_start',
    'subagent_end',
    'compaction_segment',
  ].includes(input.kind)) {
    throw new Error(`Unsupported transcript event kind: ${input.kind}`);
  }
  validateOptionalIdentifier(input.agentId, 'agentId');
  validateOptionalIdentifier(input.parentSessionId, 'parentSessionId');
  validateOptionalIdentifier(input.parentEpochId, 'parentEpochId');
  validateOptionalText(input.workspacePath, 'workspacePath');
  validateMetadata(input.metadata);
  try {
    JSON.stringify(input.content);
  } catch (error) {
    throw new Error(`Transcript event content is not JSON-serializable: ${String(error)}`);
  }
}

function validateCompactionInput(input: TranscriptCompactionSegmentInput): void {
  validateEventInput({
    eventId: input.eventId,
    sessionId: input.sessionId,
    kind: 'compaction_segment',
    parentSessionId: input.parentSessionId,
    parentEpochId: input.parentEpochId,
    metadata: input.metadata,
    content: input.summary,
  });
  validateIdentifier(input.segmentId, 'segmentId');
  validateText(input.summary, 'summary');
  if (
    input.fromSequence !== undefined
    && (!Number.isSafeInteger(input.fromSequence) || input.fromSequence < 0)
  ) {
    throw new Error('fromSequence must be a non-negative safe integer.');
  }
  if (
    input.toSequence !== undefined
    && (!Number.isSafeInteger(input.toSequence) || input.toSequence < 0)
  ) {
    throw new Error('toSequence must be a non-negative safe integer.');
  }
  if (
    input.fromSequence !== undefined
    && input.toSequence !== undefined
    && input.fromSequence > input.toSequence
  ) {
    throw new Error('Compaction segment sequence range is inverted.');
  }
}

function assertReviewDescriptor(value: TranscriptReviewDescriptor): void {
  if (
    value.version !== SPOOL_VERSION
    || value.kind !== 'transcript_review'
    || typeof value.sessionId !== 'string'
    || typeof value.epochId !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !/^[a-f0-9]{64}$/.test(value.descriptorId)
    || !value.idempotencyKey.startsWith('transcript:')
  ) {
    throw new Error('Transcript seal descriptor has an unsupported shape.');
  }
}

function assertAbandonedDescriptor(value: TranscriptAbandonedDescriptor): void {
  if (
    value.version !== SPOOL_VERSION
    || value.kind !== 'transcript_abandoned'
    || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !/^[a-f0-9]{64}$/.test(value.descriptorId)
    || !value.idempotencyKey.startsWith('transcript:')
  ) {
    throw new Error('Abandoned transcript descriptor has an unsupported shape.');
  }
}

function validateIdentifier(value: string, field: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error(`${field} must be a non-empty string of at most ${MAX_IDENTIFIER_LENGTH} characters.`);
  }
}

function validateOptionalIdentifier(value: string | undefined, field: string): void {
  if (value !== undefined) validateIdentifier(value, field);
}

function validateText(value: string, field: string): void {
  if (typeof value !== 'string' || value.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error(`${field} must be a string of at most ${MAX_IDENTIFIER_LENGTH} characters.`);
  }
}

function validateOptionalText(value: string | undefined, field: string): void {
  if (value !== undefined) validateText(value, field);
}

function validateMetadata(metadata: Readonly<Record<string, unknown>> | undefined): void {
  if (!metadata) return;
  const keys = Object.keys(metadata);
  if (keys.length > MAX_METADATA_KEYS) throw new Error('Transcript metadata has too many keys.');
  for (const key of keys) validateIdentifier(key, 'metadata key');
  try {
    JSON.stringify(metadata);
  } catch (error) {
    throw new Error(`Transcript metadata is not JSON-serializable: ${String(error)}`);
  }
}

function boundedPositiveInteger(value: number, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${field} must be a positive integer no greater than ${maximum}.`);
  }
  return value;
}

function boundedNonNegativeInteger(value: number, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${field} must be a non-negative integer no greater than ${maximum}.`);
  }
  return value;
}

function replaceSuffix(filePath: string, suffix: string, replacement: string): string {
  if (!filePath.endsWith(suffix)) throw new Error(`Unexpected transcript file suffix: ${filePath}`);
  return `${filePath.slice(0, -suffix.length)}${replacement}`;
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error('Transcript spool path escaped its root.');
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
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

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
