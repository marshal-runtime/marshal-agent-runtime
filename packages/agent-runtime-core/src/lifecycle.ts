import type {
  Disposable,
  InvocationContext,
  MaybePromise,
  PermissionDecision,
  RuntimeExecutionStatus,
  RuntimeProtocolVersion,
} from './contracts.js';
import { RUNTIME_PROTOCOL_VERSION } from './contracts.js';

export interface RuntimeLifecyclePayloads {
  'runtime.provider.registered': {
    readonly providerId: string;
    readonly providerVersion?: string;
  };
  'runtime.provider.disposed': {
    readonly providerId: string;
  };
  'runtime.search.completed': {
    readonly query: string;
    readonly resultCount: number;
  };
  'runtime.execution.started': {
    readonly executionId: string;
    readonly target: string;
    readonly providerId: string;
  };
  'runtime.execution.permission': {
    readonly executionId: string;
    readonly target: string;
    readonly decision: PermissionDecision;
  };
  'runtime.execution.completed': {
    readonly executionId: string;
    readonly target: string;
    readonly status: RuntimeExecutionStatus;
    readonly receiptId: string;
  };
}

export type RuntimeLifecycleEventType = keyof RuntimeLifecyclePayloads;

export interface RuntimeLifecycleEvent<
  TType extends RuntimeLifecycleEventType = RuntimeLifecycleEventType,
> {
  readonly protocolVersion: RuntimeProtocolVersion;
  readonly id: string;
  readonly type: TType;
  readonly occurredAt: string;
  readonly context?: InvocationContext;
  readonly payload: RuntimeLifecyclePayloads[TType];
}

export type AnyRuntimeLifecycleEvent = {
  [TType in RuntimeLifecycleEventType]: RuntimeLifecycleEvent<TType>;
}[RuntimeLifecycleEventType];

export interface RuntimeLifecyclePublisher {
  publish(event: AnyRuntimeLifecycleEvent): MaybePromise<void>;
}

export type RuntimeLifecycleListener<
  TType extends RuntimeLifecycleEventType = RuntimeLifecycleEventType,
> = (event: RuntimeLifecycleEvent<TType>) => MaybePromise<void>;

export interface RuntimeLifecycleBusOptions {
  readonly onListenerError?: (
    error: unknown,
    event: AnyRuntimeLifecycleEvent,
  ) => MaybePromise<void>;
}

/**
 * Small in-process event bus. Listener failures are isolated so observational
 * integrations cannot change runtime execution outcomes.
 */
export class RuntimeLifecycleBus implements RuntimeLifecyclePublisher {
  private readonly listeners = new Map<
    RuntimeLifecycleEventType | '*',
    Set<RuntimeLifecycleListener>
  >();

  constructor(private readonly options: RuntimeLifecycleBusOptions = {}) {}

  subscribe<TType extends RuntimeLifecycleEventType>(
    type: TType,
    listener: RuntimeLifecycleListener<TType>,
  ): Disposable;
  subscribe(type: '*', listener: RuntimeLifecycleListener): Disposable;
  subscribe(type: RuntimeLifecycleEventType | '*', listener: RuntimeLifecycleListener): Disposable {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        listeners?.delete(listener);
        if (listeners?.size === 0) this.listeners.delete(type);
      },
    };
  }

  async publish(event: AnyRuntimeLifecycleEvent): Promise<void> {
    const listeners = [
      ...(this.listeners.get(event.type) ?? []),
      ...(this.listeners.get('*') ?? []),
    ];
    const deliveries = listeners.map(async (listener) => {
      try {
        await listener(event);
      } catch (error) {
        try {
          await this.options.onListenerError?.(error, event);
        } catch {
          // Error reporting is observational too and must remain isolated.
        }
      }
    });
    await Promise.all(deliveries);
  }
}

export function createLifecycleEvent<TType extends RuntimeLifecycleEventType>(
  type: TType,
  payload: RuntimeLifecyclePayloads[TType],
  options: {
    readonly id: string;
    readonly occurredAt: string;
    readonly context?: InvocationContext;
  },
): RuntimeLifecycleEvent<TType> {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    id: options.id,
    type,
    occurredAt: options.occurredAt,
    context: options.context,
    payload,
  };
}
