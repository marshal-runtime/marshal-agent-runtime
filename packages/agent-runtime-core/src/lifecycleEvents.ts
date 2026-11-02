import type { RuntimeJsonValue } from './events.js';
import type { RuntimeEventBus } from './events.js';
import { cloneRuntimeJson } from './json.js';
import type {
  AnyRuntimeLifecycleEvent,
  RuntimeLifecycleEventType,
  RuntimeLifecyclePublisher,
} from './lifecycle.js';
import type { InvocationContext } from './contracts.js';

export const RUNTIME_LIFECYCLE_EVENT_STREAM = 'runtime.lifecycle';

export type RuntimeLifecycleEventPayload<
  TType extends RuntimeLifecycleEventType = RuntimeLifecycleEventType,
> = {
  readonly protocolVersion: string;
  readonly id: string;
  readonly type: TType;
  readonly occurredAt: string;
  readonly context?: RuntimeJsonValue;
  readonly payload: RuntimeJsonValue;
};

export type RuntimeLifecycleEventMap = {
  [TType in RuntimeLifecycleEventType]: RuntimeLifecycleEventPayload<TType>;
};

function isRuntimeJsonValue(
  value: unknown,
  depth = 0,
  state: { entries: number } = { entries: 0 },
  seen: Set<object> = new Set(),
): value is RuntimeJsonValue {
  if (depth > 32 || ++state.entries > 10_000) return false;
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || Object.getOwnPropertySymbols(value).length > 0) {
    return false;
  }
  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const key of Reflect.ownKeys(value)) {
      if (
        key !== 'length' &&
        (typeof key !== 'string' ||
          !/^(0|[1-9]\d*)$/.test(key) ||
          Number(key) >= value.length)
      ) {
        seen.delete(value);
        return false;
      }
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        !descriptor ||
        !('value' in descriptor) ||
        !isRuntimeJsonValue(descriptor.value, depth + 1, state, seen)
      ) {
        seen.delete(value);
        return false;
      }
    }
    seen.delete(value);
    return true;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    seen.delete(value);
    return false;
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      !descriptor ||
      !('value' in descriptor) ||
      !isRuntimeJsonValue(descriptor.value, depth + 1, state, seen)
    ) {
      seen.delete(value);
      return false;
    }
  }
  seen.delete(value);
  return true;
}

function normalizeRuntimeJson(value: unknown): RuntimeJsonValue {
  if (!isRuntimeJsonValue(value)) {
    throw new TypeError('Runtime lifecycle data must contain JSON values.');
  }
  return cloneRuntimeJson(value);
}

function serializeContext(context: InvocationContext | undefined): RuntimeJsonValue | undefined {
  if (context === undefined) return undefined;
  const {
    signal: _signal,
    receiptCorrelationContext: _receiptCorrelationContext,
    ...serializableContext
  } = context;
  const result: Record<string, RuntimeJsonValue> = {};
  for (const [key, value] of Object.entries(serializableContext)) {
    if (value !== undefined) {
      result[key] = normalizeRuntimeJson(value);
    }
  }
  return normalizeRuntimeJson(result);
}

function toEventPayload(
  event: AnyRuntimeLifecycleEvent,
): RuntimeLifecycleEventPayload {
  const context = serializeContext(event.context);
  return {
    protocolVersion: event.protocolVersion,
    id: event.id,
    type: event.type,
    occurredAt: event.occurredAt,
    ...(context === undefined ? {} : { context }),
    payload: normalizeRuntimeJson(event.payload),
  };
}

export interface RuntimeLifecycleEventPublisherOptions {
  readonly eventBus: RuntimeEventBus<RuntimeLifecycleEventMap>;
  readonly streamId?: string;
}

/**
 * Adapts the legacy lifecycle publisher to the durable event bus. The bus
 * appends before notifying listeners, while preserving the lifecycle record
 * inside the journal payload for replay consumers.
 */
export class RuntimeLifecycleEventPublisher
  implements RuntimeLifecyclePublisher
{
  private readonly streamId: string;

  constructor(private readonly options: RuntimeLifecycleEventPublisherOptions) {
    this.streamId = options.streamId ?? RUNTIME_LIFECYCLE_EVENT_STREAM;
  }

  async publish(event: AnyRuntimeLifecycleEvent): Promise<void> {
    await this.options.eventBus.publish({
      streamId: this.streamId,
      eventId: event.id,
      type: event.type,
      occurredAt: event.occurredAt,
      payload: toEventPayload(event),
    });
  }
}

export function createRuntimeLifecycleEventPublisher(
  options: RuntimeLifecycleEventPublisherOptions,
): RuntimeLifecycleEventPublisher {
  return new RuntimeLifecycleEventPublisher(options);
}
