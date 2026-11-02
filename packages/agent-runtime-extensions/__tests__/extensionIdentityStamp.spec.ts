import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createAllowAllPermissionBroker,
  createRuntimeKernel,
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityProvider,
  type InvocationContext,
} from '@marshal/agent-runtime-core';
import { createRuntimeServiceContainer } from '@marshal/agent-runtime-composer';
import {
  RUNTIME_EXTENSION_INTEGRITY_DOMAIN,
  RuntimeExtensionManager,
  type LoadedRuntimeExtensionPackage,
  type RuntimeExtensionActivationContext,
  type RuntimeExtensionConfiguration,
  type RuntimeExtensionInstallRequest,
  type RuntimeExtensionPackageLoader,
} from '../src/index.js';

/**
 * Backport verification for the two shipped-host hunks (SF2-2): the trusted
 * runtimeExtensionIdentity stamp on extension kernel executions, and
 * explicitConfiguration retention on the fresh-install path. The swarm
 * protocol's outsider-mutation rejection depends on the stamp being set by
 * the activation closure — never by capability input or caller context.
 */

const context: InvocationContext = {
  principal: { id: 'identity-stamp-test', kind: 'agent' },
  scope: { workspaceId: 'workspace-1' },
};

interface Fixture {
  readonly request: RuntimeExtensionInstallRequest;
  readonly loaded: LoadedRuntimeExtensionPackage;
}

function runtimePackage(options: {
  readonly identity: string;
  readonly version: string;
  readonly defaults?: RuntimeExtensionConfiguration;
  readonly activate: (
    activationContext: RuntimeExtensionActivationContext,
  ) => ReturnType<LoadedRuntimeExtensionPackage['module']['activate']>;
}): Fixture {
  const packageRoot = `test://${options.identity}/${options.version}`;
  const integrity = {
    algorithm: 'sha256' as const,
    domain: RUNTIME_EXTENSION_INTEGRITY_DOMAIN,
    value: createHash('sha256').update(packageRoot, 'utf8').digest('hex'),
  };
  return {
    request: { packageRoot, integrity },
    loaded: {
      metadata: {
        manifest: {
          schemaVersion: 1 as const,
          identity: options.identity,
          version: options.version,
          entrypoint: 'dist/index.cjs',
          moduleFormat: 'commonjs-bundle-v1' as const,
          ...(options.defaults ? { configuration: { defaults: options.defaults } } : {}),
        },
        integrity,
        canonicalRoot: packageRoot,
        fileCount: 2,
        totalBytes: 1,
      },
      module: { activate: options.activate },
    },
  };
}

class MapLoader implements RuntimeExtensionPackageLoader {
  readonly #packages: ReadonlyMap<string, LoadedRuntimeExtensionPackage>;
  constructor(fixtures: readonly Fixture[]) {
    this.#packages = new Map(fixtures.map((fixture) => [fixture.request.packageRoot, fixture.loaded]));
  }
  load(request: RuntimeExtensionInstallRequest): LoadedRuntimeExtensionPackage {
    const loaded = this.#packages.get(request.packageRoot);
    if (!loaded) throw new Error(`Unknown test extension ${request.packageRoot}.`);
    return loaded;
  }
}

describe('extension kernel-execute identity stamping (SF2-2 backport)', () => {
  it('stamps the manifest identity and cannot be spoofed by caller-supplied metadata', async () => {
    const observedIdentities: unknown[] = [];
    const recorder: CapabilityProvider = {
      id: 'stamp-recorder',
      list: () => [{
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        name: 'stamp.echo',
        version: '1.0.0',
        description: 'Records the invocation metadata identity.',
        outputSchema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
      }],
      invoke: (_name, _input, invocation) => {
        observedIdentities.push(invocation.metadata?.runtimeExtensionIdentity);
        return { output: { ok: true } };
      },
    };
    let capturedExecute: RuntimeExtensionActivationContext['execute'] | undefined;
    const extension = runtimePackage({
      identity: '@example/stamped',
      version: '1.0.0',
      activate: (activationContext) => {
        capturedExecute = activationContext.execute;
        return { capabilityProviders: [recorder] };
      },
    });
    const services = createRuntimeServiceContainer();
    const manager = new RuntimeExtensionManager({
      kernel: createRuntimeKernel({ permissionBroker: createAllowAllPermissionBroker() }),
      loader: new MapLoader([extension]),
      activationContext: context,
      services,
    });
    await manager.install(extension.request);
    expect(capturedExecute).toBeDefined();

    const request = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      targetType: 'operation' as const,
      target: 'stamp.echo',
      input: {},
      requestId: 'stamp-1',
    };

    // Default context: the closure stamps the manifest identity.
    await capturedExecute!(request);
    // Spoof attempt: caller-supplied metadata claims another identity — the
    // closure must override it; capability input can never set the stamp.
    await capturedExecute!(
      { ...request, requestId: 'stamp-2' },
      {
        ...context,
        metadata: { runtimeExtensionIdentity: '@evil/imposter' },
      },
    );

    expect(observedIdentities).toEqual(['@example/stamped', '@example/stamped']);

    await manager.dispose();
    await services.shutdown();
  });
});

describe('explicitConfiguration retention on install (backport)', () => {
  it('retains install-time explicit configuration across an update without configuration', async () => {
    const activatedConfigurations: RuntimeExtensionConfiguration[] = [];
    const activate = (activationContext: RuntimeExtensionActivationContext) => {
      activatedConfigurations.push({ ...activationContext.configuration });
      return {};
    };
    const v1 = runtimePackage({
      identity: '@example/configured-install',
      version: '1.0.0',
      defaults: { level: 'manifest' },
      activate,
    });
    const v2 = runtimePackage({
      identity: '@example/configured-install',
      version: '1.0.1',
      defaults: { level: 'manifest' },
      activate,
    });
    const services = createRuntimeServiceContainer();
    const manager = new RuntimeExtensionManager({
      kernel: createRuntimeKernel(),
      loader: new MapLoader([v1, v2]),
      activationContext: context,
      services,
    });

    const installed = await manager.install(v1.request, { configuration: { level: 'explicit' } });
    expect(installed.configuration).toMatchObject({ level: 'explicit' });

    // The regression: without explicitConfiguration retained on the install
    // path, an update WITHOUT a configuration falls back to manifest defaults
    // instead of re-applying the user's explicit choice.
    const updated = await manager.update('@example/configured-install', v2.request);
    expect(updated.version).toBe('1.0.1');
    expect(updated.configuration).toMatchObject({ level: 'explicit' });
    expect(activatedConfigurations.at(-1)).toMatchObject({ level: 'explicit' });

    await manager.dispose();
    await services.shutdown();
  });
});
