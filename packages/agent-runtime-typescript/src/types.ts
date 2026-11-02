import type { ChildProcess } from 'node:child_process';
import type { AppServicesSnapshot } from './appServices.js';

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/**
 * `brokered` removes ambient host APIs and restricts imports for cooperative
 * code. It is defense in depth, not a security boundary for malicious code.
 * `trusted` additionally exposes explicitly allowlisted Node capabilities.
 */
export type TypeScriptExecutionMode = 'brokered' | 'trusted';

export type TypeScriptModuleSourceKind = 'inline' | 'workspace_file' | 'artifact';

export interface TypeScriptSourceProvenance {
  readonly source: string;
  readonly uri?: string;
  readonly retrievedAt?: string;
  readonly contentDigest?: string;
  readonly trust?: 'unverified' | 'low' | 'medium' | 'high' | 'authoritative';
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TypeScriptModuleSourceIdentity {
  readonly kind: TypeScriptModuleSourceKind;
  readonly identifier: string;
  readonly uri?: string;
  readonly provenance?: readonly TypeScriptSourceProvenance[];
}

export interface TypeScriptModuleSourceReceipt extends TypeScriptModuleSourceIdentity {
  readonly contentDigest: string;
  readonly sizeBytes: number;
}

export interface TypeScriptDependencyReceipt {
  readonly name: string;
  readonly version?: string;
}

export interface TypeScriptEnvironmentReceipt {
  readonly nodeVersion: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly importedPackages: readonly TypeScriptDependencyReceipt[];
  readonly importedBuiltins: readonly string[];
  readonly sourceFiles: readonly TypeScriptModuleSourceReceipt[];
  readonly moduleDigest: string;
  readonly fingerprint: string;
}

export interface RuntimeBrokerCallContext {
  executionId: string;
  requestId: string;
  signal: AbortSignal;
}

export interface RuntimeCapabilityBroker {
  search(query: JsonValue, context: RuntimeBrokerCallContext): JsonValue | Promise<JsonValue>;
  invoke(
    capability: string,
    input: JsonValue,
    context: RuntimeBrokerCallContext,
  ): JsonValue | Promise<JsonValue>;
  appServices?: RuntimeAppServicesBroker;
}

export interface RuntimeAppServicesBroker {
  readonly snapshot?: AppServicesSnapshot;
  get(
    token: string,
    context: RuntimeBrokerCallContext,
  ): JsonValue | Promise<JsonValue>;
  invoke(
    token: string,
    input: {
      readonly method?: string;
      readonly args?: JsonValue;
    },
    context: RuntimeBrokerCallContext,
  ): JsonValue | Promise<JsonValue>;
}

export interface TypeScriptExecutorOptions {
  mode?: TypeScriptExecutionMode;
  maxOutputBytes?: number;
  workingDirectory?: string;
  allowedPackages?: readonly string[];
  allowedBuiltins?: readonly string[];
  nodeExecutable?: string;
  /** Reuse digest-keyed esbuild contexts while still validating their dependency graph. */
  compilationCache?: boolean;
  /** Maximum number of compiler contexts retained by one executor instance. */
  maxCompilationCacheEntries?: number;
}

export interface TypeScriptExecutionRequest extends TypeScriptExecutorOptions {
  source: string;
  input?: JsonValue;
  filename?: string;
  entrypoint?: string;
  sourceIdentity?: TypeScriptModuleSourceIdentity;
}

export interface TypeScriptExecutionContext {
  broker?: RuntimeCapabilityBroker;
  appServices?: AppServicesSnapshot;
  signal?: AbortSignal;
}

export type TypeScriptExecutionStatus =
  | 'succeeded'
  | 'compile_failed'
  | 'runtime_failed'
  | 'aborted'
  | 'output_limit_exceeded';

export type TypeScriptExecutionStage = 'validation' | 'compile' | 'execute' | 'broker';

export interface TypeScriptExecutionDiagnostic {
  level: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  stage: TypeScriptExecutionStage;
  location?: {
    file?: string;
    line?: number;
    column?: number;
  };
}

export interface TypeScriptExecutionError {
  code: string;
  message: string;
  stage: TypeScriptExecutionStage;
  stack?: string;
}

export interface TypeScriptExecutionResult {
  ok: boolean;
  status: TypeScriptExecutionStatus;
  executionId: string;
  value?: JsonValue;
  error?: TypeScriptExecutionError;
  diagnostics: TypeScriptExecutionDiagnostic[];
  stdout: string;
  stderr: string;
  durationMs: number;
  compileDurationMs: number;
  executionDurationMs: number;
  outputBytes: number;
  mode: TypeScriptExecutionMode;
  source: TypeScriptModuleSourceReceipt;
  environment?: TypeScriptEnvironmentReceipt;
  compilation?: TypeScriptCompilationReceipt;
}

export interface TypeScriptCompilationReceipt {
  readonly cacheKey: string;
  readonly cacheStatus: 'hit' | 'miss' | 'disabled';
  /**
   * A hit means the digest-keyed esbuild context was reused and rebuilt. Esbuild
   * revalidates the complete bundled dependency graph before code is executed.
   */
  readonly dependencyGraphValidated: boolean;
}

export interface InlineModuleExecutionProvider {
  readonly id: 'inline_module';
  readonly targetType: 'inline_module';
  execute(
    request: TypeScriptExecutionRequest,
    context?: TypeScriptExecutionContext,
  ): Promise<TypeScriptExecutionResult>;
  invoke(
    request: TypeScriptExecutionRequest,
    context?: TypeScriptExecutionContext,
  ): Promise<TypeScriptExecutionResult>;
  /** Releases retained compiler contexts and idle prewarmed workers. */
  dispose(): Promise<void>;
}

export interface ChildProcessFactoryContext {
  modulePath: string;
  args: readonly string[];
  options: Parameters<typeof import('node:child_process').fork>[2] & {
    readonly windowsHide?: boolean;
  };
}

export type ChildProcessFactory = (context: ChildProcessFactoryContext) => ChildProcess;
