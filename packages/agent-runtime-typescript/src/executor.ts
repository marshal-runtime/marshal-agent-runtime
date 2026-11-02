import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  CompilationFailure,
  createInlineModuleCompilationSession,
  type CompileInlineModuleResult,
  type InlineModuleCompilationSession,
} from './compiler.js';
import { cloneJson } from './json.js';
import type { AppServicesSnapshot } from './appServices.js';
import type {
  ChildProcessFactory,
  JsonValue,
  RuntimeAppServicesBroker,
  RuntimeCapabilityBroker,
  TypeScriptExecutionContext,
  TypeScriptExecutionDiagnostic,
  TypeScriptExecutionError,
  TypeScriptCompilationReceipt,
  TypeScriptEnvironmentReceipt,
  TypeScriptExecutionMode,
  TypeScriptExecutionRequest,
  TypeScriptExecutionResult,
  TypeScriptExecutionStatus,
  TypeScriptExecutorOptions,
  TypeScriptModuleSourceReceipt,
} from './types.js';
import { INLINE_MODULE_WORKER_SOURCE } from './workerSource.js';

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_COMPILATION_CACHE_ENTRIES = 32;
const BROKER_ABORT_DRAIN_TIMEOUT_MS = 2_000;
// Trusted modules act with the user's local authority, so they see the user's
// identity, home, and locale (os.homedir(), ~/ paths, CLIs spawned from them);
// credentials and app-specific variables stay out.
const TRUSTED_WORKER_ENVIRONMENT_KEYS = [
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
] as const;

function trustedWorkerEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(TRUSTED_WORKER_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));
}

interface WorkerBrokerRequest {
  kind: 'broker.request';
  id: string;
  method: 'search' | 'invoke' | 'appServices.get' | 'appServices.invoke';
  params: {
    query?: JsonValue;
    capability?: string;
    token?: string;
    input?: JsonValue;
    method?: string;
    args?: JsonValue;
  };
}

interface WorkerExecutionResult {
  kind: 'execution.result';
  ok: boolean;
  value?: JsonValue;
  error?: {
    code?: string;
    message?: string;
    stack?: string;
  };
}

interface WorkerReady {
  kind: 'worker.ready';
}

type WorkerMessage = WorkerBrokerRequest | WorkerExecutionResult | WorkerReady;

interface ForcedFailure {
  status: TypeScriptExecutionStatus;
  error: TypeScriptExecutionError;
}

interface PreparedWorker {
  child: ChildProcess;
}

export class DirectTypeScriptExecutor {
  private readonly defaults: TypeScriptExecutorOptions;
  private readonly childProcessFactory: ChildProcessFactory;
  private readonly compilationSessions = new Map<
    string,
    Promise<InlineModuleCompilationSession>
  >();
  private readonly preparedWorkers = new Map<string, Array<Promise<PreparedWorker>>>();
  private disposed = false;
  private disposal: Promise<void> | undefined;

  constructor(
    defaults: TypeScriptExecutorOptions = {},
    childProcessFactory: ChildProcessFactory = ({ modulePath, args, options }) =>
      fork(modulePath, [...args], options),
  ) {
    this.defaults = { ...defaults };
    this.childProcessFactory = childProcessFactory;
  }

  async execute(
    request: TypeScriptExecutionRequest,
    context: TypeScriptExecutionContext = {},
  ): Promise<TypeScriptExecutionResult> {
    if (this.disposed) throw new Error('TypeScript executor has been disposed.');
    const startedAt = performance.now();
    const executionId = randomUUID();
    const mode = request.mode ?? this.defaults.mode ?? 'brokered';
    const maxOutputBytes =
      request.maxOutputBytes ?? this.defaults.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const workingDirectory = path.resolve(
      request.workingDirectory ?? this.defaults.workingDirectory ?? process.cwd(),
    );
    const filename = request.filename ?? 'inline-module.ts';
    const source = sourceReceipt(request, filename);
    const allowedPackages = new Set([
      ...(this.defaults.allowedPackages ?? []),
      ...(request.allowedPackages ?? []),
    ]);
    const allowedBuiltins = new Set(
      [...(this.defaults.allowedBuiltins ?? []), ...(request.allowedBuiltins ?? [])].map((name) =>
        name.startsWith('node:') ? name.slice(5) : name,
      ),
    );
    const diagnostics: TypeScriptExecutionDiagnostic[] = [];
    const compilationCacheEnabled =
      request.compilationCache ?? this.defaults.compilationCache ?? true;
    const maxCompilationCacheEntries =
      request.maxCompilationCacheEntries ??
      this.defaults.maxCompilationCacheEntries ??
      DEFAULT_MAX_COMPILATION_CACHE_ENTRIES;

    const validationError = validateRequest(
      request,
      maxOutputBytes,
      maxCompilationCacheEntries,
    );
    if (validationError) {
      return failureResult({
        executionId,
        mode,
        status: 'compile_failed',
        error: validationError,
        diagnostics: [diagnosticForError(validationError)],
        startedAt,
        source,
      });
    }
    if (context.signal?.aborted) {
      const error = executionError(
        'ABORTED',
        'Execution was aborted before it started.',
        'execute',
      );
      return failureResult({
        executionId,
        mode,
        status: 'aborted',
        error,
        diagnostics: [diagnosticForError(error)],
        startedAt,
        source,
      });
    }

    let input: JsonValue;
    try {
      input = cloneJson(request.input ?? null, 'Inline module input');
    } catch (error) {
      const validation = executionError(
        'INPUT_NOT_SERIALIZABLE',
        error instanceof Error ? error.message : String(error),
        'validation',
      );
      return failureResult({
        executionId,
        mode,
        status: 'compile_failed',
        error: validation,
        diagnostics: [diagnosticForError(validation)],
        startedAt,
        source,
      });
    }

    const compileStartedAt = performance.now();
    let compiledCode: string;
    let compiledRequiredBuiltins: string[] = [];
    let environment: TypeScriptEnvironmentReceipt | undefined;
    let compilation: TypeScriptCompilationReceipt | undefined;
    const appServices = context.appServices ?? context.broker?.appServices?.snapshot;
    try {
      const compileRequest = {
        source: request.source,
        filename,
        workingDirectory,
        mode,
        allowedPackages,
        allowedBuiltins,
        sourceKind: request.sourceIdentity?.kind,
        workspaceRoot: workingDirectory,
        appServices,
      };
      const cacheKey = compilationCacheKey({
        source,
        filename,
        workingDirectory,
        mode,
        allowedPackages,
        allowedBuiltins,
        appServicesDeclarations: appServices?.declarations,
      });
      let cacheStatus: TypeScriptCompilationReceipt['cacheStatus'] = 'disabled';
      let session: InlineModuleCompilationSession;
      if (compilationCacheEnabled) {
        const cached = this.compilationSessions.get(cacheKey);
        if (cached) {
          cacheStatus = 'hit';
          this.compilationSessions.delete(cacheKey);
          this.compilationSessions.set(cacheKey, cached);
          session = await cached;
        } else {
          cacheStatus = 'miss';
          const created = createInlineModuleCompilationSession(compileRequest);
          this.compilationSessions.set(cacheKey, created);
          created.catch(() => this.compilationSessions.delete(cacheKey));
          this.evictCompilationSessions(maxCompilationCacheEntries);
          session = await created;
        }
      } else {
        session = await createInlineModuleCompilationSession(compileRequest);
      }
      let compiled: CompileInlineModuleResult;
      try {
        compiled = await session.compile();
      } finally {
        if (!compilationCacheEnabled) await session.dispose();
      }
      compilation = {
        cacheKey,
        cacheStatus,
        dependencyGraphValidated: true,
      };
      compiledCode = compiled.code;
      compiledRequiredBuiltins = compiled.requiredBuiltins;
      environment = await createEnvironmentReceipt(
        workingDirectory,
        mode,
        source,
        compiled.localFiles,
        compiled.importedPackages,
        compiledRequiredBuiltins,
      );
      diagnostics.push(...compiled.diagnostics);
    } catch (error) {
      const compilationFailure =
        error instanceof CompilationFailure
          ? error
          : new CompilationFailure(
              'COMPILE_ERROR',
              error instanceof Error ? error.message : String(error),
              [],
            );
      const executionFailure = executionError(
        compilationFailure.code,
        compilationFailure.message,
        'compile',
      );
      return failureResult({
        executionId,
        mode,
        status: 'compile_failed',
        error: executionFailure,
        diagnostics:
          compilationFailure.diagnostics.length > 0
            ? compilationFailure.diagnostics
            : [diagnosticForError(executionFailure)],
        startedAt,
        compileDurationMs: performance.now() - compileStartedAt,
        source,
        compilation,
      });
    }
    const compileDurationMs = performance.now() - compileStartedAt;

    if (context.signal?.aborted) {
      const error = executionError(
        'ABORTED',
        'Execution was aborted during compilation.',
        'execute',
      );
      return failureResult({
        executionId,
        mode,
        status: 'aborted',
        error,
        diagnostics: [...diagnostics, diagnosticForError(error)],
        startedAt,
        compileDurationMs,
        source,
        compilation,
      });
    }

    return await this.runWorker({
      executionId,
      mode,
      filename,
      input,
      compiledCode,
      workingDirectory,
      maxOutputBytes,
      allowedPackages: [...allowedPackages],
      allowedBuiltins: [...new Set([...allowedBuiltins, ...compiledRequiredBuiltins])],
      nodeExecutable: request.nodeExecutable ?? this.defaults.nodeExecutable,
      broker: context.broker,
      appServicesBroker: context.broker?.appServices,
      appServices,
      signal: context.signal,
      diagnostics,
      startedAt,
      compileDurationMs,
      entrypoint: request.entrypoint,
      source,
      environment,
      compilation,
    });
  }

  /** Releases retained compiler contexts and idle prewarmed workers. */
  async dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    const sessions = [...this.compilationSessions.values()];
    const workers = [...this.preparedWorkers.values()].flat();
    this.compilationSessions.clear();
    this.preparedWorkers.clear();
    this.disposal = Promise.allSettled([
      ...sessions.map(async (session) => (await session).dispose()),
      ...workers.map(async (worker) => terminatePreparedWorker((await worker).child)),
    ]).then(() => undefined);
    return this.disposal;
  }

  private evictCompilationSessions(maxEntries: number): void {
    while (this.compilationSessions.size > maxEntries) {
      const oldest = this.compilationSessions.entries().next().value as
        | [string, Promise<InlineModuleCompilationSession>]
        | undefined;
      if (!oldest) return;
      this.compilationSessions.delete(oldest[0]);
      void oldest[1].then((session) => session.dispose()).catch(() => undefined);
    }
  }

  private async acquirePreparedWorker(
    mode: TypeScriptExecutionMode,
    workingDirectory: string,
    nodeExecutable?: string,
  ): Promise<PreparedWorker> {
    // Trusted code observes process state, so it always receives a freshly
    // started worker with the requested cwd. Brokered workers expose neither
    // process nor require and are safe to prewarm before the next invocation.
    if (mode === 'trusted') return this.prepareWorker(mode, workingDirectory, nodeExecutable);
    const poolKey = workerPoolKey(mode, workingDirectory, nodeExecutable);
    const pool = this.preparedWorkers.get(poolKey) ?? [];
    this.preparedWorkers.set(poolKey, pool);
    let candidate = pool.shift();
    while (candidate) {
      try {
        const prepared = await candidate;
        if (prepared.child.exitCode === null && prepared.child.connected) {
          this.replenishPreparedWorker(poolKey, mode, workingDirectory, nodeExecutable);
          return prepared;
        }
      } catch {
        // A prewarmed process may have reached its idle timeout. Replace it.
      }
      candidate = pool.shift();
    }
    const prepared = await this.prepareWorker(mode, workingDirectory, nodeExecutable);
    this.replenishPreparedWorker(poolKey, mode, workingDirectory, nodeExecutable);
    return prepared;
  }

  private replenishPreparedWorker(
    poolKey: string,
    mode: TypeScriptExecutionMode,
    workingDirectory: string,
    nodeExecutable?: string,
  ): void {
    const pool = this.preparedWorkers.get(poolKey) ?? [];
    this.preparedWorkers.set(poolKey, pool);
    if (pool.length === 0) pool.push(this.prepareWorker(mode, workingDirectory, nodeExecutable));
  }

  private async prepareWorker(
    mode: TypeScriptExecutionMode,
    workingDirectory: string,
    nodeExecutable?: string,
  ): Promise<PreparedWorker> {
    // Permission checks resolve the worker entrypoint to its canonical path.
    // macOS commonly reports /var/... from os.tmpdir(), while /var is a
    // symlink to /private/var; granting the non-canonical path makes Node deny
    // the entrypoint before the worker can signal readiness.
    const temporaryDirectory = await realpath(
      await mkdtemp(path.join(tmpdir(), 'agent-runtime-ts-worker-')),
    );
    const workerPath = path.join(temporaryDirectory, 'worker.mjs');
    await writeFile(workerPath, INLINE_MODULE_WORKER_SOURCE, 'utf8');
    const execArgv = ['--no-warnings', '--enable-source-maps'];
    if (mode === 'brokered') {
      execArgv.push('--permission', `--allow-fs-read=${temporaryDirectory}`);
    }
    const child = this.childProcessFactory({
      modulePath: workerPath,
      args: [],
      options: {
        // Brokered modules cannot observe process.cwd(); keeping their idle
        // worker out of the workspace avoids locking disposable workspaces on
        // Windows. Trusted modules retain the configured working directory.
        cwd: mode === 'brokered' ? temporaryDirectory : workingDirectory,
        execPath: nodeExecutable,
        execArgv,
        windowsHide: true,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          TMP: process.env.TMP,
          TEMP: process.env.TEMP,
          ...(mode === 'trusted' ? trustedWorkerEnvironment() : {}),
        },
        serialization: 'json',
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    });
    child.once('exit', () => {
      void rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    });
    return await new Promise((resolve, reject) => {
      const ready = (message: WorkerMessage) => {
        if (message?.kind !== 'worker.ready') return;
        cleanup();
        resolve({ child });
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const exited = (code: number | null) => {
        cleanup();
        reject(new Error(`TypeScript worker exited before readiness (${code ?? 'signal'}).`));
      };
      const cleanup = () => {
        child.off('message', ready);
        child.off('error', failed);
        child.off('exit', exited);
      };
      child.on('message', ready);
      child.once('error', failed);
      child.once('exit', exited);
    });
  }

  private async runWorker(configuration: {
    executionId: string;
    mode: TypeScriptExecutionMode;
    filename: string;
    input: JsonValue;
    compiledCode: string;
    workingDirectory: string;
    maxOutputBytes: number;
    allowedPackages: string[];
    allowedBuiltins: string[];
    nodeExecutable?: string;
    broker?: RuntimeCapabilityBroker;
    appServicesBroker?: RuntimeAppServicesBroker;
    appServices?: AppServicesSnapshot;
    signal?: AbortSignal;
    diagnostics: TypeScriptExecutionDiagnostic[];
    startedAt: number;
    compileDurationMs: number;
    entrypoint?: string;
    source: TypeScriptModuleSourceReceipt;
    environment?: TypeScriptEnvironmentReceipt;
    compilation?: TypeScriptCompilationReceipt;
  }): Promise<TypeScriptExecutionResult> {
    const executeStartedAt = performance.now();
    const { child } = await this.acquirePreparedWorker(
      configuration.mode,
      configuration.workingDirectory,
      configuration.nodeExecutable,
    );
    return new Promise((resolve) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let capturedOutputBytes = 0;
      let observedOutputBytes = 0;
      let workerResult: WorkerExecutionResult | undefined;
      let forcedFailure: ForcedFailure | undefined;
      let settled = false;
      const brokerController = new AbortController();
      const pendingBrokerRequests = new Set<Promise<void>>();

      const makeResult = (): TypeScriptExecutionResult => {
        const durationMs = performance.now() - configuration.startedAt;
        const executionDurationMs = performance.now() - executeStartedAt;
        if (forcedFailure) {
          return {
            ok: false,
            status: forcedFailure.status,
            executionId: configuration.executionId,
            error: forcedFailure.error,
            diagnostics: [...configuration.diagnostics, diagnosticForError(forcedFailure.error)],
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
            durationMs,
            compileDurationMs: configuration.compileDurationMs,
            executionDurationMs,
            outputBytes: observedOutputBytes,
            mode: configuration.mode,
            source: configuration.source,
            environment: configuration.environment,
            compilation: configuration.compilation,
          };
        }
        if (workerResult?.ok) {
          return {
            ok: true,
            status: 'succeeded',
            executionId: configuration.executionId,
            value: workerResult.value ?? null,
            diagnostics: configuration.diagnostics,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
            durationMs,
            compileDurationMs: configuration.compileDurationMs,
            executionDurationMs,
            outputBytes: observedOutputBytes,
            mode: configuration.mode,
            source: configuration.source,
            environment: configuration.environment,
            compilation: configuration.compilation,
          };
        }
        const workerError = executionError(
          workerResult?.error?.code ?? 'CHILD_EXITED',
          workerResult?.error?.message ?? 'Inline module worker exited without a result.',
          workerResult?.error?.code === 'BROKER_ERROR' ? 'broker' : 'execute',
          workerResult?.error?.stack,
        );
        return {
          ok: false,
          status: 'runtime_failed',
          executionId: configuration.executionId,
          error: workerError,
          diagnostics: [
            ...configuration.diagnostics,
            diagnosticForError(workerError, configuration.filename),
          ],
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          durationMs,
          compileDurationMs: configuration.compileDurationMs,
          executionDurationMs,
          outputBytes: observedOutputBytes,
          mode: configuration.mode,
          source: configuration.source,
          environment: configuration.environment,
          compilation: configuration.compilation,
        };
      };

      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (!brokerController.signal.aborted) {
          brokerController.abort(forcedFailure?.error ?? 'module execution completed');
        }
        configuration.signal?.removeEventListener('abort', abort);
        const result = makeResult();
        if (!forcedFailure || pendingBrokerRequests.size === 0) {
          resolve(result);
          return;
        }
        // A forced module stop must not race retries ahead of provider-owned
        // abort cleanup. The drain is bounded so a broken adapter cannot block
        // completion after cancellation or another definitive failure.
        void drainBrokerRequests(
          [...pendingBrokerRequests],
          BROKER_ABORT_DRAIN_TIMEOUT_MS,
        ).then(() => resolve(result));
      };

      const terminate = (failure: ForcedFailure) => {
        if (forcedFailure || settled) {
          return;
        }
        forcedFailure = failure;
        if (!brokerController.signal.aborted) brokerController.abort(failure.error);
        child.kill('SIGKILL');
      };

      const abort = () => {
        terminate({
          status: 'aborted',
          error: executionError('ABORTED', 'Execution was aborted.', 'execute'),
        });
      };
      configuration.signal?.addEventListener('abort', abort, { once: true });
      if (configuration.signal?.aborted) abort();

      const capture = (chunk: Buffer | string, target: Buffer[]) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        observedOutputBytes += bytes.length;
        const remaining = configuration.maxOutputBytes - capturedOutputBytes;
        if (remaining > 0) {
          const captured = bytes.subarray(0, remaining);
          target.push(captured);
          capturedOutputBytes += captured.length;
        }
        if (observedOutputBytes > configuration.maxOutputBytes) {
          terminate({
            status: 'output_limit_exceeded',
            error: executionError(
              'OUTPUT_LIMIT_EXCEEDED',
              `Execution output exceeded ${configuration.maxOutputBytes} bytes.`,
              'execute',
            ),
          });
        }
      };

      child.stdout?.on('data', (chunk: Buffer | string) => capture(chunk, stdout));
      child.stderr?.on('data', (chunk: Buffer | string) => capture(chunk, stderr));
      child.on('error', (error) => {
        terminate({
          status: 'runtime_failed',
          error: executionError('CHILD_PROCESS_ERROR', error.message, 'execute', error.stack),
        });
        finish();
      });
      child.on('exit', finish);
      child.on('message', (message: WorkerMessage) => {
        if (!message || typeof message !== 'object') {
          return;
        }
        if (message.kind === 'broker.request') {
          const pending = handleBrokerRequest(child, message, {
            executionId: configuration.executionId,
            broker: configuration.broker,
            appServicesBroker: configuration.appServicesBroker,
            signal: brokerController.signal,
          });
          pendingBrokerRequests.add(pending);
          void pending.finally(() => pendingBrokerRequests.delete(pending));
          return;
        }
        if (message.kind === 'execution.result') {
          workerResult = message;
          child.disconnect();
        }
      });

      child.send({
        kind: 'execution.start',
        configuration: {
          mode: configuration.mode,
          filename: configuration.filename,
          entrypoint: configuration.entrypoint,
          input: configuration.input,
          compiledCode: configuration.compiledCode,
          requireBase: path.join(configuration.workingDirectory, 'package.json'),
          allowedPackages: configuration.allowedPackages,
          allowedBuiltins: configuration.allowedBuiltins,
          appServices: cloneJson(
            configuration.appServices ?? { services: [] },
            'App services snapshot',
          ),
        },
      });
    });
  }
}

async function drainBrokerRequests(
  requests: readonly Promise<void>[],
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.allSettled(requests).then(() => undefined),
      new Promise<void>((resolvePromise) => {
        timer = setTimeout(resolvePromise, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function terminatePreparedWorker(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolvePromise) => {
    const done = () => resolvePromise();
    child.once('exit', done);
    child.once('error', done);
    if (!child.kill('SIGKILL')) done();
  });
}

async function handleBrokerRequest(
  child: ChildProcess,
  message: WorkerBrokerRequest,
  configuration: {
    executionId: string;
    broker?: RuntimeCapabilityBroker;
    appServicesBroker?: RuntimeAppServicesBroker;
    signal?: AbortSignal;
  },
): Promise<void> {
  const respond = (response: object) => {
    if (child.connected) {
      child.send({ kind: 'broker.response', id: message.id, ...response });
    }
  };
  if (
    (message.method === 'search' || message.method === 'invoke') &&
    !configuration.broker
  ) {
    respond({
      ok: false,
      error: { code: 'BROKER_UNAVAILABLE', message: 'No runtime capability broker was supplied.' },
    });
    return;
  }

  const controller = new AbortController();
  const abort = () => controller.abort(configuration.signal?.reason);
  if (configuration.signal?.aborted) abort();
  else configuration.signal?.addEventListener('abort', abort, { once: true });
  try {
    const brokerContext = {
      executionId: configuration.executionId,
      requestId: message.id,
      signal: controller.signal,
    };
    let value: JsonValue;
    if (message.method === 'search') {
      value = await configuration.broker!.search(message.params.query ?? null, brokerContext);
    } else if (message.method === 'invoke') {
      value = await configuration.broker!.invoke(
        message.params.capability ?? '',
        message.params.input ?? null,
        brokerContext,
      );
    } else {
      if (!configuration.appServicesBroker) {
        respond({
          ok: false,
          error: {
            code: 'APP_SERVICES_BROKER_UNAVAILABLE',
            message: 'No runtime app services broker was supplied.',
          },
        });
        return;
      }
      value = message.method === 'appServices.get'
        ? await configuration.appServicesBroker.get(message.params.token ?? '', brokerContext)
        : await configuration.appServicesBroker.invoke(
            message.params.token ?? '',
            {
              method: message.params.method,
              args: message.params.args ?? [],
            },
            brokerContext,
          );
    }
    respond({ ok: true, value: cloneJson(value, 'Capability broker result') });
  } catch (error) {
    respond({
      ok: false,
      error: {
        code:
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : 'BROKER_ERROR',
        message: error instanceof Error ? error.message : String(error),
      },
    });
  } finally {
    configuration.signal?.removeEventListener('abort', abort);
  }
}

function validateRequest(
  request: TypeScriptExecutionRequest,
  maxOutputBytes: number,
  maxCompilationCacheEntries: number,
): TypeScriptExecutionError | undefined {
  if (typeof request.source !== 'string' || request.source.trim().length === 0) {
    return executionError(
      'SOURCE_REQUIRED',
      'A non-empty source string is required.',
      'validation',
    );
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0) {
    return executionError(
      'INVALID_OUTPUT_LIMIT',
      'maxOutputBytes must be a non-negative safe integer.',
      'validation',
    );
  }
  if (!Number.isSafeInteger(maxCompilationCacheEntries) || maxCompilationCacheEntries < 1) {
    return executionError(
      'INVALID_COMPILATION_CACHE_LIMIT',
      'maxCompilationCacheEntries must be a positive safe integer.',
      'validation',
    );
  }
  return undefined;
}

function executionError(
  code: string,
  message: string,
  stage: TypeScriptExecutionError['stage'],
  stack?: string,
): TypeScriptExecutionError {
  return { code, message, stage, stack };
}

function diagnosticForError(
  error: TypeScriptExecutionError,
  filename?: string,
): TypeScriptExecutionDiagnostic {
  const location = filename ? sourceLocationFromStack(error.stack, filename) : undefined;
  return {
    level: 'error',
    code: error.code,
    message: error.message,
    stage: error.stage,
    location,
  };
}

function sourceLocationFromStack(
  stack: string | undefined,
  filename: string,
): TypeScriptExecutionDiagnostic['location'] | undefined {
  if (!stack) return undefined;
  const normalizedStack = stack.replace(/\\/g, '/');
  const normalizedFilename = filename.replace(/\\/g, '/');
  const escaped = normalizedFilename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}:(\\d+):(\\d+)`).exec(normalizedStack);
  if (!match) return undefined;
  return { file: filename, line: Number(match[1]), column: Number(match[2]) };
}

function failureResult(configuration: {
  executionId: string;
  mode: TypeScriptExecutionMode;
  status: TypeScriptExecutionStatus;
  error: TypeScriptExecutionError;
  diagnostics: TypeScriptExecutionDiagnostic[];
  startedAt: number;
  compileDurationMs?: number;
  source: TypeScriptModuleSourceReceipt;
  compilation?: TypeScriptCompilationReceipt;
}): TypeScriptExecutionResult {
  const durationMs = performance.now() - configuration.startedAt;
  return {
    ok: false,
    status: configuration.status,
    executionId: configuration.executionId,
    error: configuration.error,
    diagnostics: configuration.diagnostics,
    stdout: '',
    stderr: '',
    durationMs,
    compileDurationMs: configuration.compileDurationMs ?? 0,
    executionDurationMs: 0,
    outputBytes: 0,
    mode: configuration.mode,
    source: configuration.source,
    compilation: configuration.compilation,
  };
}

function compilationCacheKey(configuration: {
  source: TypeScriptModuleSourceReceipt;
  filename: string;
  workingDirectory: string;
  mode: TypeScriptExecutionMode;
  allowedPackages: ReadonlySet<string>;
  allowedBuiltins: ReadonlySet<string>;
  appServicesDeclarations?: string;
}): string {
  const input = {
    compilerContract: 1,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    sourceKind: configuration.source.kind,
    sourceDigest: configuration.source.contentDigest,
    filename: path.resolve(configuration.filename),
    workingDirectory: configuration.workingDirectory,
    mode: configuration.mode,
    allowedPackages: [...configuration.allowedPackages].sort(),
    allowedBuiltins: [...configuration.allowedBuiltins].sort(),
    appServicesDeclarations: configuration.appServicesDeclarations,
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
}

function workerPoolKey(
  mode: TypeScriptExecutionMode,
  _workingDirectory: string,
  nodeExecutable?: string,
): string {
  return JSON.stringify({ mode, nodeExecutable: nodeExecutable ?? process.execPath });
}

function sourceReceipt(
  request: TypeScriptExecutionRequest,
  filename: string,
): TypeScriptModuleSourceReceipt {
  const bytes = Buffer.from(typeof request.source === 'string' ? request.source : '', 'utf8');
  const identity = request.sourceIdentity ?? {
    kind: 'inline' as const,
    identifier: filename,
  };
  return {
    ...identity,
    contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    sizeBytes: bytes.length,
  };
}

async function createEnvironmentReceipt(
  workingDirectory: string,
  mode: TypeScriptExecutionMode,
  entrySource: TypeScriptModuleSourceReceipt,
  localFiles: readonly { path: string; contentDigest: string; sizeBytes: number }[],
  importedPackageNames: readonly string[],
  importedBuiltins: readonly string[],
): Promise<TypeScriptEnvironmentReceipt> {
  const importedPackages = await Promise.all(
    importedPackageNames.map(async (name) => ({
      name,
      version: await resolvePackageVersion(name, workingDirectory),
    })),
  );
  const sourceFiles: TypeScriptModuleSourceReceipt[] = [
    entrySource,
    ...localFiles.map((file) => ({
      kind: 'workspace_file' as const,
      identifier: file.path,
      contentDigest: file.contentDigest,
      sizeBytes: file.sizeBytes,
    })),
  ];
  const moduleDigest = `sha256:${createHash('sha256')
    .update(
      JSON.stringify(
        sourceFiles.map(({ identifier, contentDigest }) => ({ identifier, contentDigest })),
      ),
    )
    .digest('hex')}`;
  const fingerprintInput = {
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    mode,
    importedPackages,
    importedBuiltins: [...importedBuiltins].sort(),
    moduleDigest,
  };
  return {
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    importedPackages,
    importedBuiltins: [...importedBuiltins].sort(),
    sourceFiles,
    moduleDigest,
    fingerprint: `sha256:${createHash('sha256')
      .update(JSON.stringify(fingerprintInput))
      .digest('hex')}`,
  };
}

async function resolvePackageVersion(
  packageName: string,
  workingDirectory: string,
): Promise<string | undefined> {
  try {
    const runtimeRequire = createRequire(path.join(workingDirectory, 'package.json'));
    let current = path.dirname(runtimeRequire.resolve(packageName));
    while (true) {
      const manifestPath = path.join(current, 'package.json');
      try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
          name?: unknown;
          version?: unknown;
        };
        if (manifest.name === packageName && typeof manifest.version === 'string') {
          return manifest.version;
        }
      } catch {
        // Continue toward the filesystem root until the owning package is found.
      }
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  } catch {
    return undefined;
  }
}

export function createTypeScriptExecutor(
  options: TypeScriptExecutorOptions = {},
): DirectTypeScriptExecutor {
  return new DirectTypeScriptExecutor(options);
}

export async function executeTypeScriptModule(
  request: TypeScriptExecutionRequest,
  context: TypeScriptExecutionContext = {},
): Promise<TypeScriptExecutionResult> {
  const executor = new DirectTypeScriptExecutor();
  try {
    return await executor.execute(request, context);
  } finally {
    await executor.dispose();
  }
}
