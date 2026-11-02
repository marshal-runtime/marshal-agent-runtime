import type {
  JsonObject,
  RuntimeCallContext,
  RuntimeExecutionRequest,
  RuntimeInlineModuleExecutionRequest,
  RuntimeModuleExecutionRequest,
  RuntimeKernelPort,
  RuntimeLifecyclePort,
  RuntimeSearchRequest,
  RuntimeSessionEndRequest,
  RuntimeSessionStartRequest,
  RuntimeTurnObservation,
} from '../ports.js';

export interface InMemoryCapabilityDescriptor extends JsonObject {
  name: string;
  description: string;
  kind?: string;
  inputSchema?: JsonObject;
}

export interface InMemoryRuntimeProvider {
  list():
    readonly InMemoryCapabilityDescriptor[] | Promise<readonly InMemoryCapabilityDescriptor[]>;
  invoke(name: string, input: unknown, context: RuntimeCallContext): Promise<unknown>;
}

export type InMemoryInlineModuleExecutor = (
  request: RuntimeInlineModuleExecutionRequest,
  context: RuntimeCallContext,
) => Promise<unknown>;

export type InMemoryModuleExecutor = (
  request: RuntimeModuleExecutionRequest,
  context: RuntimeCallContext,
) => Promise<unknown>;

export class InMemoryRuntimeKernel implements RuntimeKernelPort {
  readonly searchCalls: Array<{ request: RuntimeSearchRequest; context: RuntimeCallContext }> = [];
  readonly executeCalls: Array<{ request: RuntimeExecutionRequest; context: RuntimeCallContext }> =
    [];

  constructor(
    private readonly providers: readonly InMemoryRuntimeProvider[],
    private readonly inlineModuleExecutor?: InMemoryInlineModuleExecutor,
    private readonly moduleExecutor?: InMemoryModuleExecutor,
  ) {}

  async search(request: RuntimeSearchRequest, context: RuntimeCallContext): Promise<unknown> {
    this.searchCalls.push({ request, context });
    const descriptors = (
      await Promise.all(this.providers.map((provider) => provider.list()))
    ).flat();
    const terms = (request.query ?? '').toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return descriptors
      .filter((descriptor) => {
        const candidate =
          `${descriptor.name} ${descriptor.description} ${descriptor.kind ?? ''}`.toLocaleLowerCase();
        return (
          (!request.name || descriptor.name === request.name) &&
          terms.every((term) => candidate.includes(term))
        );
      })
      .slice(0, request.limit ?? descriptors.length);
  }

  async execute(request: RuntimeExecutionRequest, context: RuntimeCallContext): Promise<unknown> {
    this.executeCalls.push({ request, context });
    if (request.targetType === 'inline_module') {
      if (!this.inlineModuleExecutor) {
        throw new Error('No in-memory inline module executor configured');
      }
      return this.inlineModuleExecutor(request, context);
    }
    if (request.targetType === 'module') {
      if (!this.moduleExecutor) {
        throw new Error('No in-memory file module executor configured');
      }
      return this.moduleExecutor(request, context);
    }
    for (const provider of this.providers) {
      const descriptors = await provider.list();
      if (descriptors.some((descriptor) => descriptor.name === request.target)) {
        return provider.invoke(request.target, request.input, context);
      }
    }
    throw new Error(`Unknown in-memory runtime operation: ${request.target}`);
  }
}

export class InMemoryLifecycle implements RuntimeLifecyclePort {
  readonly starts: RuntimeSessionStartRequest[] = [];
  readonly observations: RuntimeTurnObservation[] = [];
  readonly ends: RuntimeSessionEndRequest[] = [];

  constructor(
    private readonly handlers: {
      startSession?: (request: RuntimeSessionStartRequest) => unknown | Promise<unknown>;
      observeTurn?: (request: RuntimeTurnObservation) => unknown | Promise<unknown>;
      endSession?: (request: RuntimeSessionEndRequest) => unknown | Promise<unknown>;
    } = {},
  ) {}

  async startSession(request: RuntimeSessionStartRequest): Promise<unknown> {
    this.starts.push(request);
    return this.handlers.startSession?.(request);
  }

  async observeTurn(request: RuntimeTurnObservation): Promise<unknown> {
    this.observations.push(request);
    return this.handlers.observeTurn?.(request);
  }

  async endSession(request: RuntimeSessionEndRequest): Promise<unknown> {
    this.ends.push(request);
    return this.handlers.endSession?.(request);
  }
}
