import type {
  InvocationContext,
  JsonSchema,
  PermissionDecision,
  RuntimeExecResponse,
  RuntimeExecutionLineage,
  RuntimeExecutionReceipt,
  RuntimeHarnessIdentity,
  RuntimeModuleSourceReference,
  RuntimeScope,
} from '@marshal/agent-runtime-core';
import type { JsonObject } from './types.js';

export const MARSHAL_UI_CLIENT_VERSION = '1.0.0' as const;
export const MCP_APPS_PROTOCOL_VERSION = '2026-01-26' as const;
export const UI_ACTION_TOOL_NAME = 'marshal_invoke_react_action' as const;
export const UI_DECLARED_TOOL_NAME = 'marshal_invoke_react_tool' as const;
export const UI_CHROME_ACTION_BINDING_METHOD = 'marshal/ui/chrome-action-binding' as const;
export const UI_CHROME_ACTION_REQUEST_METHOD = 'marshal/ui/chrome-action-request' as const;
export const UI_CHROME_ACTION_CANCEL_METHOD = 'marshal/ui/chrome-action-cancel' as const;
export const UI_CHROME_ACTION_RESULT_METHOD = 'marshal/ui/chrome-action-result' as const;
export const UI_CHROME_ACTION_TIMEOUT_MS = 30_000 as const;

export type UiDisplayMode = 'inline' | 'fullscreen' | 'pip';
export type UiTheme = 'light' | 'dark';
export type UiStateScope = 'session' | 'project' | 'workspace';

export interface UiDimensions {
  width?: number;
  height?: number;
  maxWidth?: number;
  maxHeight?: number;
}

export interface UiSafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface UiHostContext {
  theme?: UiTheme;
  styles?: { variables?: Readonly<Record<string, string>> };
  locale?: string;
  timezone?: string;
  platform?: string;
  displayMode: UiDisplayMode;
  availableDisplayModes: readonly UiDisplayMode[];
  containerDimensions?: UiDimensions;
  safeAreaInsets?: UiSafeAreaInsets;
  [extension: string]: unknown;
}

export interface UiHostCapabilities {
  serverTools?: boolean;
  serverResources?: boolean;
  logging?: boolean;
  sandbox?: Readonly<Record<string, unknown>>;
  extensions?: Readonly<Record<string, unknown>>;
}

export interface UiHostExtensionCallResult<TResult = unknown> {
  namespace: string;
  method: string;
  status: 'success' | 'unsupported' | 'failed';
  result?: TResult;
  error?: { code?: string; message: string };
}

export interface UiMessage {
  role: 'user';
  content: Array<{ type: 'text'; text: string } | { type: string; [key: string]: unknown }>;
}

export interface UiModelContextUpdate {
  content: Array<{ type: 'text'; text: string } | { type: string; [key: string]: unknown }>;
}

export interface UiOpenLinkRequest {
  url: string;
}

export interface UiDisplayModeResult {
  requested: UiDisplayMode;
  actual: UiDisplayMode;
  status: 'granted' | 'unsupported' | 'denied' | 'fallback' | 'timed_out';
  reason?: string;
}

export interface UiChromeActionResult {
  requestId: string;
  actionId: string;
  status:
    | 'success'
    | 'not_found'
    | 'unavailable'
    | 'denied'
    | 'approval_required'
    | 'failed'
    | 'cancelled'
    | 'timed_out';
  message: string;
  receipt?: UiActionReceipt;
}

export interface UiChromeActionContext {
  requestId: string;
  actionId: string;
  activatedAt: string;
  signal: AbortSignal;
}

/** Renderer-authenticated origin metadata for one outer application-control activation. */
export interface UiActionActivation {
  requestId: string;
  surface: 'outer-renderer-chrome';
  method: typeof UI_CHROME_ACTION_REQUEST_METHOD;
  activatedAt: string;
  dispatchedAt: string;
}

export interface UiActionActivationReceipt extends UiActionActivation {
  acceptedAt: string;
  dispatchOverheadMs: number;
}

export interface UiDeclaredToolReference<TInput = unknown, TOutput = unknown> {
  id: string;
  name: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  _input?: TInput;
  _output?: TOutput;
}

export interface UiModuleActionTarget {
  kind: 'module';
  module: Exclude<RuntimeModuleSourceReference, { kind: 'inline' }>;
  executorCapability?: string;
}

export interface UiCapabilityActionTarget {
  kind: 'capability';
  capability: string;
}

export interface UiActionDeclaration<TInput = unknown, TOutput = unknown> {
  id: string;
  version: string;
  title?: string;
  description?: string;
  target: UiModuleActionTarget | UiCapabilityActionTarget;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  allowedScopes: readonly UiStateScope[];
  requiredPermissions: readonly string[];
  risk: 'read' | 'write' | 'external-effect';
  idempotency: 'required' | 'supported' | 'none';
  _input?: TInput;
  _output?: TOutput;
}

export interface UiAuthoringProfile {
  id: string;
  version: string;
  portable: boolean;
  packageImports: readonly string[];
  /** Exact versions advertised by the adapter for packages it supplies. */
  packageVersions?: Readonly<Record<string, string>>;
  designTokens: Readonly<Record<string, string>>;
  templates: readonly string[];
  authoringGuidance: string;
  /** Authoring requirements whose rendered behavior is validated by harness release gates. */
  accessibilityRequirements: readonly string[];
  /** Responsive/container authoring requirements; metadata alone is not a conformance result. */
  layoutConstraints: readonly string[];
  requiredHostCapabilities: readonly string[];
  optionalHostExtensions: readonly string[];
}

export interface UiAuthoringProfileReference {
  id: string;
  version: string;
}

/** Immutable record of how a compiler resolved an authoring-profile request. */
export interface UiAuthoringProfileProvenance extends UiAuthoringProfileReference {
  status: 'selected' | 'fallback';
  origin: 'explicit' | 'preferred' | 'standards-default' | 'fallback';
  requested?: { id: string; version?: string };
  packageImports: readonly string[];
  reason?: string;
}

export interface UiAuthoritativeStateReference {
  capability: string;
  resourceId: string;
  version: string;
}

export interface UiLocalStateDeclaration {
  scope: UiStateScope;
  schemaVersion: string;
}

export interface UiApplicationManifest {
  version: '1.0.0';
  presentationModes: readonly UiDisplayMode[];
  actions: readonly UiActionDeclaration[];
  tools: readonly UiDeclaredToolReference[];
  localState?: UiLocalStateDeclaration;
  authoritativeState?: UiAuthoritativeStateReference;
  authoringProfile?: UiAuthoringProfileReference;
  /** Declares that the app consumes user-attached images, letting hosts gate attachment chrome on need instead of capability proof. */
  wantsImages?: boolean;
  /** Optional, explicitly declared host facilities; unsupported hosts may omit them. */
  hostFeatures?: readonly import('./hostInteraction.js').UiHostFeature[];
}

export interface UiLocalStateSnapshot {
  scope: UiStateScope;
  schemaVersion: string;
  version: number;
  values: Readonly<Record<string, string>>;
  updatedAt?: string;
}

export interface UiApplicationStateSnapshot {
  local: UiLocalStateSnapshot;
  /** A reference only. Authoritative business state is never copied into local preference storage. */
  authoritative?: UiAuthoritativeStateReference;
}

export type UiLifecycleEvent =
  | { type: 'tool-input'; input: unknown }
  | { type: 'tool-input-partial'; input: unknown }
  | { type: 'tool-result'; result: unknown }
  | { type: 'tool-cancelled'; reason?: string }
  | { type: 'tool-error'; error: { code?: string; message: string; details?: unknown } }
  | { type: 'host-context-changed'; context: UiHostContext }
  | { type: 'teardown'; reason?: string };

export interface UiProtocolMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message: string; data?: unknown };
}

export interface UiProtocolTransport {
  request<TResult = unknown>(
    method: string,
    params: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<TResult>;
  notify(method: string, params: unknown): void;
  subscribe(listener: (message: UiProtocolMessage) => void): () => void;
}

export interface UiClientOptions {
  appInfo: { name: string; version: string };
  application: UiApplicationManifest;
  renderId: string;
  transport: UiProtocolTransport;
}

export interface UiActionExecutionRequest {
  renderId: string;
  action: UiActionDeclaration;
  input: unknown;
  scope: UiStateScope;
  /** Stable, scope-bound identity that target runtimes use to deduplicate effects. */
  targetIdempotencyKey?: string;
  idempotencyKey?: string;
  approval?: Readonly<Record<string, unknown>>;
  activation?: UiActionActivation;
}

export interface UiActionExecutionPort {
  execute(request: UiActionExecutionRequest, context: InvocationContext): Promise<RuntimeExecResponse>;
}

export interface UiDeclaredToolExecutionPort {
  execute(
    tool: UiDeclaredToolReference,
    input: unknown,
    context: InvocationContext,
  ): Promise<RuntimeExecResponse>;
}

export interface UiDeclaredToolResult<TOutput = unknown> {
  status: RuntimeExecResponse['status'];
  output?: TOutput;
  error?: RuntimeExecResponse['error'];
  approval?: RuntimeExecResponse['approval'];
  receipt?: RuntimeExecResponse['receipt'];
}

export interface UiActionAuthorizationPort {
  authorize(
    request: UiActionExecutionRequest,
    context: InvocationContext,
  ): Promise<PermissionDecision> | PermissionDecision;
}

export interface UiActionReceipt {
  receiptId: string;
  executionId: string;
  lineage: RuntimeExecutionLineage;
  renderId: string;
  actionId: string;
  actionVersion: string;
  target: UiActionDeclaration['target'];
  scope: UiStateScope;
  principalId: string;
  identity?: RuntimeHarnessIdentity;
  invocationScope?: RuntimeScope;
  idempotencyKey?: string;
  targetIdempotencyKey: string;
  requestDigest?: string;
  replayed?: boolean;
  permission: PermissionDecision;
  status: RuntimeExecResponse['status'];
  startedAt: string;
  completedAt: string;
  durationMs: number;
  activation?: UiActionActivationReceipt;
  targetReceipt?: RuntimeExecResponse['receipt'];
}

export interface UiActionResult<TOutput = unknown> {
  status: RuntimeExecResponse['status'];
  output?: TOutput;
  error?: RuntimeExecResponse['error'];
  approval?: RuntimeExecResponse['approval'];
  receipt: UiActionReceipt;
}

export interface UiActionIdempotencyRecord {
  requestDigest: string;
  result: UiActionResult;
}

export interface UiActionIdempotencyLease {
  ownerId: string;
  requestDigest: string;
  expiresAt: string;
}

export type UiActionIdempotencyClaim =
  | { status: 'acquired'; lease: UiActionIdempotencyLease }
  | { status: 'busy'; retryAfterMs: number }
  | { status: 'replay'; record: UiActionIdempotencyRecord };

export interface UiActionIdempotencyStore {
  get(
    key: string,
    scope: UiStateScope,
    context: InvocationContext,
  ): Promise<UiActionIdempotencyRecord | undefined>;
  put(
    key: string,
    scope: UiStateScope,
    record: UiActionIdempotencyRecord,
    context: InvocationContext,
  ): Promise<void>;
  claim(
    key: string,
    scope: UiStateScope,
    requestDigest: string,
    leaseMs: number,
    context: InvocationContext,
  ): Promise<UiActionIdempotencyClaim>;
  renew(
    key: string,
    scope: UiStateScope,
    lease: UiActionIdempotencyLease,
    leaseMs: number,
    context: InvocationContext,
  ): Promise<UiActionIdempotencyLease | undefined>;
  complete(
    key: string,
    scope: UiStateScope,
    lease: UiActionIdempotencyLease,
    record: UiActionIdempotencyRecord,
    context: InvocationContext,
  ): Promise<UiActionIdempotencyRecord>;
  release(
    key: string,
    scope: UiStateScope,
    lease: UiActionIdempotencyLease,
    context: InvocationContext,
  ): Promise<void>;
}

export interface UiActionJournalAttempt {
  receiptId: string;
  executionId: string;
  lineage: RuntimeExecutionLineage;
  renderId: string;
  actionId: string;
  actionVersion: string;
  target: UiActionDeclaration['target'];
  scope: UiStateScope;
  principalId: string;
  identity?: RuntimeHarnessIdentity;
  invocationScope?: RuntimeScope;
  idempotencyKey?: string;
  requestDigest: string;
  targetIdempotencyKey: string;
  startedAt: string;
  activation?: UiActionActivation;
  ownerId?: string;
  ownerPid: number;
  leaseExpiresAt?: string;
  phase: 'pending' | 'terminal';
  leaseLoss?: { at: string; code: string; message: string };
  result?: UiActionResult;
}

export interface UiActionJournalStore {
  begin(
    key: string,
    scope: UiStateScope,
    attempt: UiActionJournalAttempt,
    context: InvocationContext,
  ): Promise<UiActionJournalAttempt>;
  markLeaseLost(
    key: string,
    scope: UiStateScope,
    receiptId: string,
    error: { code: string; message: string },
    context: InvocationContext,
  ): Promise<void>;
  terminalize(
    key: string,
    scope: UiStateScope,
    receiptId: string,
    result: UiActionResult,
    context: InvocationContext,
  ): Promise<void>;
  close(
    key: string,
    scope: UiStateScope,
    receiptId: string,
    context: InvocationContext,
  ): Promise<void>;
  listReceipts(
    scope: UiStateScope,
    context: InvocationContext,
  ): Promise<readonly RuntimeExecutionReceipt[]>;
}

export interface UiActionDispatcherOptions {
  loadApplication(renderId: string, context: InvocationContext): Promise<UiApplicationManifest | undefined>;
  authorize: UiActionAuthorizationPort;
  executor: UiActionExecutionPort;
  idempotencyStore?: UiActionIdempotencyStore;
  /** Durable root journal. Production adapters must provide one for restart-safe action receipts. */
  journalStore?: UiActionJournalStore;
  /** Duration of a durable action claim. It is renewed while execution is active. */
  idempotencyLeaseMs?: number;
  /** Maximum delay before checking a claim held by another dispatcher. */
  idempotencyPollMs?: number;
  now?: () => Date;
  receiptId?: () => string;
}

export interface UiDeclaredToolDispatcherOptions {
  loadApplication(renderId: string, context: InvocationContext): Promise<UiApplicationManifest | undefined>;
  executor: UiDeclaredToolExecutionPort;
}

export type UiActionToolInput = JsonObject & {
  renderId: string;
  actionId: string;
  input?: unknown;
  scope: UiStateScope;
  idempotencyKey?: string;
  approval?: JsonObject;
  activation?: UiActionActivation;
};

export type UiDeclaredToolInput = JsonObject & {
  renderId: string;
  toolId: string;
  input?: unknown;
};
