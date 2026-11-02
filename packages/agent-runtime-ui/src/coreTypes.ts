export type {
  CapabilityDescriptor,
  CapabilityInvocationResult,
  CapabilityProvider,
  InvocationContext,
  MaybePromise,
  PermissionApprovalDecision,
  RuntimeError,
  RuntimeExecutionStatus,
  RuntimeExecResponse,
} from '@marshal/agent-runtime-core';

export type JsonObject = Record<string, unknown>;
export { RUNTIME_PROTOCOL_VERSION } from '@marshal/agent-runtime-core';

export function asObject(value: unknown, field = 'input'): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as JsonObject;
}

export function requireString(value: unknown, field: string, maxLength = 100_000): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (value.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters`);
  return value;
}
