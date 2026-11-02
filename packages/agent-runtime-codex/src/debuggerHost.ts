import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  RuntimeCompositionRegistry,
  RuntimeCompositionServiceDescriptor,
  RuntimeServiceAccessor,
  RuntimeServiceBindingHandle,
  RuntimeServiceToken,
} from '@marshal/runtime';
import {
  RUNTIME_EXTENSION_LIFECYCLE_SERVICE,
  type RuntimeExtensionLifecycleService,
} from '@marshal/runtime/extensions';

const DEBUGGER_EXTENSION_IDENTITY = '@marshal/agentic-debugger-extension';
const DEBUGGER_HOST_SERVICE_KEY = 'marshal.agentic-debugger.host-adapter';
const DEBUGGER_NATIVE_ENTRYPOINT = path.join('dist', 'runtime', 'native-host.mjs');
const DEBUGGER_PROVIDER_ID = '@marshal/codex:agentic-debugger-native';

interface DebuggerHostAdapter {
  invoke(input: unknown): Promise<unknown>;
  readSource?(scope: unknown, debuggerSessionId: string, sourcePath: string): Promise<unknown>;
  subscribe?(
    scope: unknown,
    debuggerSessionId: string,
    listener: (event: unknown) => void,
  ): () => void;
  disposeScope?(scopeKey: string): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

const DEBUGGER_HOST_SERVICE = Object.freeze({
  key: DEBUGGER_HOST_SERVICE_KEY,
  token: Symbol.for(DEBUGGER_HOST_SERVICE_KEY) as RuntimeServiceToken<DebuggerHostAdapter>,
  contract: Object.freeze({
    name: DEBUGGER_HOST_SERVICE_KEY,
    version: '1.0.0',
    declaration: `export interface IDebuggerHostAdapter {
  invoke(input: unknown): Promise<unknown>;
}`,
    methods: Object.freeze([
      Object.freeze({
        name: 'invoke',
        input: 'unknown',
        output: 'unknown',
        description: 'Invoke the native debugger adapter from the installed extension package.',
      }),
    ]),
  }),
}) satisfies RuntimeCompositionServiceDescriptor<DebuggerHostAdapter>;

/** Register Codex's package-backed debugger service before extension health is evaluated. */
export async function registerCodexDebuggerHostAdapter(
  services: RuntimeServiceAccessor,
  compositionRegistry: RuntimeCompositionRegistry,
): Promise<RuntimeServiceBindingHandle> {
  const existing = compositionRegistry.snapshot().services.find(
    ({ service }) => service.key === DEBUGGER_HOST_SERVICE_KEY,
  );
  if (existing?.selectedProviderId !== undefined) {
    return Object.freeze({ dispose: async () => undefined });
  }

  const adapter = new CodexDebuggerHostAdapter(services);
  let binding: RuntimeServiceBindingHandle;
  try {
    binding = await compositionRegistry.registerProvider({
      provider: {
        id: DEBUGGER_PROVIDER_ID,
        service: DEBUGGER_HOST_SERVICE,
        contract: DEBUGGER_HOST_SERVICE.contract,
      },
      binding: { useValue: adapter },
    });
  } catch (error) {
    await adapter.dispose();
    throw error;
  }

  return Object.freeze({
    dispose: async () => {
      const failures: unknown[] = [];
      await captureFailure(failures, () => binding.dispose());
      await captureFailure(failures, () => adapter.dispose());
      throwFailures(failures, 'Failed to dispose the Codex debugger host service.');
    },
  });
}

class CodexDebuggerHostAdapter implements DebuggerHostAdapter {
  private adapter: DebuggerHostAdapter | undefined;
  private loading: Promise<DebuggerHostAdapter> | undefined;
  private disposed = false;

  constructor(private readonly services: RuntimeServiceAccessor) {}

  async invoke(input: unknown): Promise<unknown> {
    return (await this.getAdapter()).invoke(input);
  }

  async readSource(scope: unknown, debuggerSessionId: string, sourcePath: string): Promise<unknown> {
    const adapter = await this.getAdapter();
    if (!adapter.readSource) {
      throw Object.assign(new Error('The debugger host does not expose source reads.'), {
        code: 'CAPABILITY_NOT_SUPPORTED',
      });
    }
    return adapter.readSource(scope, debuggerSessionId, sourcePath);
  }

  subscribe(
    scope: unknown,
    debuggerSessionId: string,
    listener: (event: unknown) => void,
  ): () => void {
    return this.adapter?.subscribe?.(scope, debuggerSessionId, listener) ?? (() => undefined);
  }

  async disposeScope(scopeKey: string): Promise<void> {
    await this.adapter?.disposeScope?.(scopeKey);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const adapter = this.adapter ?? await this.loading?.catch(() => undefined);
    this.adapter = undefined;
    this.loading = undefined;
    await adapter?.dispose?.();
  }

  private async getAdapter(): Promise<DebuggerHostAdapter> {
    if (this.disposed) throw new Error('The Codex debugger host service is disposed.');
    if (this.adapter) return this.adapter;
    this.loading ??= this.loadAdapter().catch((error) => {
      this.loading = undefined;
      throw error;
    });
    this.adapter = await this.loading;
    return this.adapter;
  }

  private async loadAdapter(): Promise<DebuggerHostAdapter> {
    const lifecycle = this.services.tryGet<RuntimeExtensionLifecycleService>(
      RUNTIME_EXTENSION_LIFECYCLE_SERVICE,
    );
    const record = lifecycle?.get(DEBUGGER_EXTENSION_IDENTITY);
    if (!record) {
      throw Object.assign(new Error('The debugger extension is not installed.'), {
        code: 'WORKER_UNAVAILABLE',
      });
    }
    const entrypoint = path.resolve(record.request.packageRoot, DEBUGGER_NATIVE_ENTRYPOINT);
    const module: unknown = await import(pathToFileURL(entrypoint).href);
    if (!module || typeof module !== 'object') {
      throw new Error('The debugger native host module is invalid.');
    }
    const Constructor = Reflect.get(module, 'NativeDebuggerHostAdapter');
    if (typeof Constructor !== 'function') {
      throw new Error('The debugger native host module does not export NativeDebuggerHostAdapter.');
    }
    const adapter: unknown = Reflect.construct(Constructor, []);
    if (!adapter || typeof adapter !== 'object' || typeof Reflect.get(adapter, 'invoke') !== 'function') {
      throw new Error('The debugger native host module returned an invalid adapter.');
    }
    return adapter as DebuggerHostAdapter;
  }
}

async function captureFailure(
  failures: unknown[],
  operation: () => void | Promise<void> | undefined,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    failures.push(error);
  }
}

function throwFailures(failures: readonly unknown[], message: string): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}

