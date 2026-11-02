import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createRuntimeServiceContainer,
  RuntimeCompositionRegistry,
  type RuntimeServiceToken,
} from '@marshal/runtime';
import {
  RUNTIME_EXTENSION_LIFECYCLE_SERVICE,
  type RuntimeExtensionLifecycleService,
} from '@marshal/runtime/extensions';
import { registerCodexDebuggerHostAdapter } from '../debuggerHost.js';

const DEBUGGER_HOST_TOKEN = Symbol.for(
  'marshal.agentic-debugger.host-adapter',
) as RuntimeServiceToken<{ invoke(input: unknown): Promise<unknown> }>;

describe('Codex debugger host service', () => {
  it('loads the native adapter from the installed debugger package and disposes it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'marshal-codex-debugger-host-'));
    const nativeRoot = path.join(root, 'dist', 'runtime');
    const services = createRuntimeServiceContainer();
    const compositionRegistry = new RuntimeCompositionRegistry({ container: services });
    let lifecycleBinding: Awaited<ReturnType<typeof services.bind>> | undefined;
    let debuggerBinding: Awaited<ReturnType<typeof registerCodexDebuggerHostAdapter>> | undefined;

    try {
      await fs.mkdir(nativeRoot, { recursive: true });
      await fs.writeFile(
        path.join(nativeRoot, 'native-host.mjs'),
        `export class NativeDebuggerHostAdapter {
  async invoke() { return { source: 'native-fixture' }; }
  async dispose() { globalThis.__marshalCodexDebuggerDisposed = true; }
}\n`,
        'utf8',
      );
      delete (globalThis as Record<string, unknown>).__marshalCodexDebuggerDisposed;
      lifecycleBinding = await services.bind(RUNTIME_EXTENSION_LIFECYCLE_SERVICE, {
        useValue: lifecycleFixture(root),
      });
      debuggerBinding = await registerCodexDebuggerHostAdapter(services, compositionRegistry);

      expect(compositionRegistry.snapshot().services).toEqual([
        expect.objectContaining({
          service: expect.objectContaining({ key: 'marshal.agentic-debugger.host-adapter' }),
          selectedProviderId: '@marshal/codex:agentic-debugger-native',
        }),
      ]);
      const host = services.get(DEBUGGER_HOST_TOKEN);
      await expect(host.invoke({ capability: 'debug.adapter.list' })).resolves.toEqual({
        source: 'native-fixture',
      });

      await debuggerBinding.dispose();
      debuggerBinding = undefined;
      expect(services.tryGet(DEBUGGER_HOST_TOKEN)).toBeUndefined();
      expect((globalThis as Record<string, unknown>).__marshalCodexDebuggerDisposed).toBe(true);
    } finally {
      await debuggerBinding?.dispose();
      await lifecycleBinding?.dispose();
      await services.shutdown();
      delete (globalThis as Record<string, unknown>).__marshalCodexDebuggerDisposed;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the service honest when the debugger extension is not installed', async () => {
    const services = createRuntimeServiceContainer();
    const compositionRegistry = new RuntimeCompositionRegistry({ container: services });
    const debuggerBinding = await registerCodexDebuggerHostAdapter(services, compositionRegistry);

    try {
      await expect(services.get(DEBUGGER_HOST_TOKEN).invoke({})).rejects.toMatchObject({
        code: 'WORKER_UNAVAILABLE',
        message: 'The debugger extension is not installed.',
      });
    } finally {
      await debuggerBinding.dispose();
      await services.shutdown();
    }
  });
});

function lifecycleFixture(packageRoot: string): RuntimeExtensionLifecycleService {
  return {
    get: (identity) => identity === '@marshal/agentic-debugger-extension'
      ? ({ request: { packageRoot } } as ReturnType<RuntimeExtensionLifecycleService['get']>)
      : undefined,
  } as RuntimeExtensionLifecycleService;
}

