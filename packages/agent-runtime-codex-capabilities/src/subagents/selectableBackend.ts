import type {
  SpawnSubagentRequest,
  SubagentBackend,
  SubagentBackendName,
  SubagentListRequest,
  SubagentRunResult,
  SubagentSnapshot,
  SubagentWaitSignal,
} from './types.js';

export class SelectableSubagentBackend implements SubagentBackend {
  constructor(
    private readonly codex: SubagentBackend,
    private readonly copilot: SubagentBackend,
    private readonly defaultBackend: SubagentBackendName = 'codex',
  ) {}

  spawn(request: SpawnSubagentRequest): Promise<SubagentSnapshot> {
    const backend = request.backend ?? this.defaultBackend;
    return this.selected(backend).spawn(request).then((snapshot) =>
      backend === 'copilot' ? withId(snapshot, `copilot-${snapshot.id}`) : snapshot);
  }

  run(threadId: string, prompt: string, options?: { reasoningEffort?: string }): Promise<SubagentRunResult> {
    const [backend, id] = this.route(threadId);
    return this.selected(backend).run(id, prompt, options).then((result) => this.mapResult(backend, result));
  }

  list(request: SubagentListRequest): Promise<readonly SubagentSnapshot[]> {
    return Promise.all([
      this.codex.list(request),
      this.copilot.list(request).then((snapshots) => snapshots.map((snapshot) => withId(snapshot, `copilot-${snapshot.id}`))),
    ]).then(([codex, copilot]) => {
      const snapshots = [...codex, ...copilot];
      return request.limit === undefined ? snapshots : snapshots.slice(0, request.limit);
    });
  }

  steer(threadId: string, message: string): Promise<SubagentSnapshot> {
    const [backend, id] = this.route(threadId);
    return this.selected(backend).steer(id, message).then((snapshot) => this.mapSnapshot(backend, snapshot));
  }

  async pause(threadId: string, reason: string): Promise<SubagentSnapshot> {
    const [backend, id] = this.route(threadId);
    const selected = this.selected(backend);
    if (selected.pause) {
      return this.mapSnapshot(backend, await selected.pause(id, reason));
    }
    const message =
      'Pause cooperatively at the next safe point. Preserve current progress and await further instructions.'
      + (reason.trim() ? ` Reason: ${reason.trim()}` : '');
    try {
      return this.mapSnapshot(backend, await selected.steer(id, message));
    } catch (steerError) {
      try {
        const current = await selected.inspect(id);
        if (current.status === 'idle' && !current.activeTurnId) {
          return this.mapSnapshot(backend, current);
        }
      } catch (inspectionError) {
        throw new AggregateError(
          [steerError, inspectionError],
          `${backend} session "${threadId}" could not be paused or re-inspected.`,
        );
      }
      throw steerError;
    }
  }

  followUp(threadId: string, message: string, options?: { reasoningEffort?: string }): Promise<SubagentRunResult> {
    const [backend, id] = this.route(threadId);
    return this.selected(backend).followUp(id, message, options).then((result) => this.mapResult(backend, result));
  }

  wait(threadId: string, options?: { timeoutMs?: number; pollIntervalMs?: number; signal?: SubagentWaitSignal }): Promise<SubagentSnapshot> {
    const [backend, id] = this.route(threadId);
    return this.selected(backend).wait(id, options).then((snapshot) => this.mapSnapshot(backend, snapshot));
  }

  cancel(threadId: string): Promise<SubagentSnapshot> {
    const [backend, id] = this.route(threadId);
    return this.selected(backend).cancel(id).then((snapshot) => this.mapSnapshot(backend, snapshot));
  }

  inspect(threadId: string): Promise<SubagentSnapshot & { transcript?: readonly Record<string, unknown>[] }> {
    const [backend, id] = this.route(threadId);
    return this.selected(backend).inspect(id).then((snapshot) => this.mapSnapshot(backend, snapshot));
  }

  async dispose(): Promise<void> {
    await Promise.all([this.codex.dispose?.(), this.copilot.dispose?.()]);
  }

  private selected(name: SubagentBackendName): SubagentBackend {
    if (name === 'codex') return this.codex;
    if (name === 'copilot') return this.copilot;
    throw new TypeError('backend must be "codex" or "copilot".');
  }

  private route(threadId: string): [SubagentBackendName, string] {
    return threadId.startsWith('copilot-')
      ? ['copilot', threadId.slice('copilot-'.length)]
      : ['codex', threadId];
  }

  private mapSnapshot(backend: SubagentBackendName, snapshot: SubagentSnapshot): SubagentSnapshot {
    return backend === 'copilot' ? withId(snapshot, `copilot-${snapshot.id}`) : snapshot;
  }

  private mapResult(backend: SubagentBackendName, result: SubagentRunResult): SubagentRunResult {
    return backend === 'copilot' ? { ...result, thread: this.mapSnapshot(backend, result.thread) } : result;
  }
}

function withId(snapshot: SubagentSnapshot, id: string): SubagentSnapshot {
  return { ...snapshot, id, metadata: { ...(snapshot.metadata ?? {}), backend: 'copilot' } };
}
