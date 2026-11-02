import type { InvocationContext } from '@marshal/agent-runtime-core';
import type {
  ReactUiMcpAppsPort,
  UiApplicationManifest,
  UiDisplayMode,
  UiHostCapabilities,
  UiLifecycleEvent,
  UiMessage,
  UiModelContextUpdate,
  UiOpenLinkRequest,
  UiProtocolMessage,
  UiRenderToolDescriptor,
  UiRenderToolResult,
} from '@marshal/agent-runtime-ui';
import type { JsonRecord, MaybePromise } from './contracts.js';

export const ADAPTIVE_APPLICATION_CONFORMANCE_CASES = [
  'renderer-resource-metadata',
  'complete-fallback',
  'stable-cached-display',
  'manifest-recovery',
  'display-mode-negotiation',
  'host-context-lifecycle',
  'host-operations',
  'declared-actions',
  'restart-scope-isolation',
] as const;

export type AdaptiveApplicationConformanceCaseName =
  (typeof ADAPTIVE_APPLICATION_CONFORMANCE_CASES)[number];

export interface AdaptiveApplicationScope {
  readonly name: 'primary' | 'isolated';
}

export interface AdaptiveApplicationProvisionedRender {
  readonly renderId: string;
  readonly componentId: string;
  readonly rendererUri: string;
}

export interface AdaptiveApplicationHostProfile {
  readonly displayMode: UiDisplayMode;
  readonly availableDisplayModes: readonly UiDisplayMode[];
  readonly displayResponses?: Readonly<Partial<Record<UiDisplayMode, UiDisplayMode>>>;
  readonly deniedDisplayModes?: readonly UiDisplayMode[];
  readonly capabilities?: UiHostCapabilities;
  readonly requestResults?: Readonly<Record<string, unknown>>;
  readonly context?: JsonRecord;
}

export interface AdaptiveApplicationHostSnapshot {
  readonly context: JsonRecord;
  readonly events: readonly UiLifecycleEvent[];
  readonly requests: readonly { readonly method: string; readonly params: unknown }[];
  readonly notifications: readonly { readonly method: string; readonly params: unknown }[];
}

export interface AdaptiveApplicationHostSession {
  requestDisplayMode(mode: UiDisplayMode): Promise<unknown>;
  sendMessage(message: UiMessage): Promise<void>;
  updateModelContext(update: UiModelContextUpdate): Promise<void>;
  openLink(request: UiOpenLinkRequest): Promise<unknown>;
  reportSize(dimensions: { readonly width?: number; readonly height?: number }): void;
  supportsHostExtension(namespace: string, method: string): boolean;
  callHostExtension(namespace: string, method: string, args?: readonly unknown[]): Promise<unknown>;
  callTool(toolId: string, input: unknown): Promise<unknown>;
  callAction(
    actionId: string,
    input: unknown,
    options?: {
      readonly scope?: 'session' | 'project' | 'workspace';
      readonly idempotencyKey?: string;
    },
  ): Promise<unknown>;
  emit(message: UiProtocolMessage): void;
  snapshot(): AdaptiveApplicationHostSnapshot;
  close(): void;
}

export interface AdaptiveApplicationObservations {
  readonly compileInvocations: number;
  readonly renderBindingInvocations: number;
  readonly displayInvocations: number;
  readonly sourceContentDigest: string;
  readonly sourceModifiedAtMs: number;
  readonly actionExecutions: number;
  readonly toolExecutions: number;
  readonly authorizationRequests: readonly JsonRecord[];
}

/** Structural resource plane accepted from a standards host or a harness adapter. */
export interface AdaptiveApplicationResourcePort {
  listResources(context: InvocationContext): Promise<readonly unknown[]>;
  readResource(uri: string, context: InvocationContext): Promise<unknown>;
  listRenderTools(context: InvocationContext): Promise<readonly UiRenderToolDescriptor[]>;
  invokeRenderTool(
    name: string,
    input: unknown,
    context: InvocationContext,
  ): Promise<UiRenderToolResult | undefined>;
  toolMetadata(): UiRenderToolDescriptor['_meta'];
  reactToolMetadata?(): UiRenderToolDescriptor['_meta'];
}

export interface AdaptiveApplicationResourceFactoryInput {
  readonly react: ReactUiMcpAppsPort;
  readonly stateRoot: string;
}

export type AdaptiveApplicationResourceFactory = (
  input: AdaptiveApplicationResourceFactoryInput,
) => MaybePromise<AdaptiveApplicationResourcePort>;

export interface AdaptiveApplicationConformanceEnvironment {
  readonly manifest: UiApplicationManifest;
  readonly fallback: { readonly summary: string; readonly details: JsonRecord };
  readonly rendererVersion: string;
  provision(scope?: AdaptiveApplicationScope): Promise<AdaptiveApplicationProvisionedRender>;
  listResources(scope?: AdaptiveApplicationScope): Promise<readonly unknown[]>;
  readResource(uri: string, scope?: AdaptiveApplicationScope): Promise<unknown>;
  rendererToolMetadata(): unknown;
  display(renderId: string, scope?: AdaptiveApplicationScope): Promise<unknown>;
  payload(renderId: string, scope?: AdaptiveApplicationScope): Promise<unknown>;
  updateState(
    renderId: string,
    key: string,
    value: string,
    scope?: AdaptiveApplicationScope,
  ): Promise<unknown>;
  invokeAction(
    renderId: string,
    input: JsonRecord,
    scope?: AdaptiveApplicationScope,
  ): Promise<unknown>;
  connectHost(
    renderId: string,
    profile: AdaptiveApplicationHostProfile,
    scope?: AdaptiveApplicationScope,
  ): Promise<AdaptiveApplicationHostSession>;
  restart(): Promise<void>;
  inspect(): AdaptiveApplicationObservations;
  dispose(): Promise<void>;
}

export interface AdaptiveApplicationConformanceFixture {
  readonly name: string;
  create(
    caseName: AdaptiveApplicationConformanceCaseName,
  ): Promise<AdaptiveApplicationConformanceEnvironment>;
}

export interface AdaptiveApplicationConformanceCaseResult {
  readonly name: AdaptiveApplicationConformanceCaseName;
  readonly status: 'passed' | 'failed';
  readonly durationMs: number;
  readonly error?: { readonly message: string; readonly details?: unknown };
}

export interface AdaptiveApplicationConformanceReport {
  readonly adapterName: string;
  readonly ok: boolean;
  readonly passed: number;
  readonly failed: number;
  readonly cases: readonly AdaptiveApplicationConformanceCaseResult[];
}
