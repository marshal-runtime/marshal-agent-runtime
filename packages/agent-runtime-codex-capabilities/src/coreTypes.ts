export type JsonObject = Record<string, unknown>;

export interface InvocationCancellationSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener?(
    type: 'abort',
    listener: () => void,
    options?: Readonly<{ once?: boolean }>,
  ): void;
  removeEventListener?(type: 'abort', listener: () => void): void;
}

export interface InvocationContext {
  readonly principal: { readonly id: string; readonly kind: string };
  readonly scope?: Readonly<Record<string, string | undefined>>;
  readonly executionId?: string;
  readonly signal?: InvocationCancellationSignal;
  readonly metadata?: Readonly<JsonObject>;
}

export interface CapabilityDescriptor {
  readonly protocolVersion: string;
  readonly name: string;
  readonly version: string;
  readonly title?: string;
  readonly description: string;
  readonly tags?: readonly string[];
  readonly inputSchema?: Readonly<JsonObject>;
  readonly outputSchema: Readonly<JsonObject>;
  readonly permissions?: readonly {
    permission: string;
    reason?: string;
    risk?: 'low' | 'medium' | 'high' | 'critical';
  }[];
  readonly annotations?: Readonly<JsonObject>;
}

export interface CapabilityInvocationResult<T = unknown> {
  readonly output: T;
  readonly diagnostics?: readonly {
    level: 'debug' | 'info' | 'warning' | 'error';
    code?: string;
    message: string;
  }[];
  readonly artifacts?: readonly {
    id: string;
    kind: string;
    uri?: string;
    mediaType?: string;
    metadata?: Readonly<JsonObject>;
  }[];
  readonly metadata?: Readonly<JsonObject>;
  readonly receipt?: unknown;
}

export type MaybePromise<T> = T | Promise<T>;

/** Structural match for @marshal/agent-runtime-core.CapabilityProvider. */
export interface CapabilityProvider {
  readonly id: string;
  readonly version?: string;
  list(
    context: InvocationContext,
  ): MaybePromise<readonly CapabilityDescriptor[]>;
  get?(
    name: string,
    context: InvocationContext,
  ): MaybePromise<CapabilityDescriptor | undefined>;
  invoke(
    name: string,
    input: unknown,
    context: InvocationContext,
  ): MaybePromise<CapabilityInvocationResult>;
}

export const RUNTIME_PROTOCOL_VERSION = '1.0.0';

export function asObject(value: unknown, field = 'input'): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as JsonObject;
}

export function requireString(value: unknown, field: string, maxLength = 100_000): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${field} must be a non-empty string`);
  if (value.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters`);
  return value;
}

export function optionalString(
  value: unknown,
  field: string,
  maxLength = 100_000,
): string | undefined {
  return value === undefined ? undefined : requireString(value, field, maxLength);
}
