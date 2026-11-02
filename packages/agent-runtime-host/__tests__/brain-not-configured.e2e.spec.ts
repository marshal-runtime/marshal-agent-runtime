import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityProvider,
  type PermissionBroker,
} from '@marshal/agent-runtime-core';
import { createRuntimeServiceContainer } from '@marshal/agent-runtime-composer';
import { RUNTIME_EXTENSION_LIFECYCLE_SERVICE } from '@marshal/agent-runtime-extensions';
import { createAgentRuntime, createRuntimeHostMaterializer } from '../src/index.js';

const cleanup: string[] = [];
afterEach(async () => {
  for (const target of cleanup.splice(0)) await fs.rm(target, { recursive: true, force: true });
});

const allowAll: PermissionBroker = { decide: () => ({ decision: 'allow' }) };

async function start(providerSources: Parameters<typeof createAgentRuntime>[0]['providerSources'] = []) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'brain-not-configured-')));
  cleanup.push(parent);
  const workspacePath = path.join(parent, 'workspace');
  await fs.mkdir(workspacePath);
  return createAgentRuntime({
    serviceContainer: createRuntimeServiceContainer(),
    workspacePath,
    protectedLifecycleResultRoot: path.join(parent, 'private'),
    permissionBroker: allowAll,
    providerSources,
  });
}

describe('a workspace with no Brain route', () => {
  it('starts the host and answers knowledge.* with "Brain not configured"', async () => {
    const runtime = await start();
    try {
      cleanup.push(runtime.stateRoot);
      const searched = await runtime.kernel.execute(
        { targetType: 'operation', target: 'knowledge.search', input: { query: 'release gate' } },
        { sessionId: 'no-brain' },
      );
      console.log('knowledge.search ->', JSON.stringify(searched).slice(0, 400));
      expect(searched.status).not.toBe('success');
      expect(JSON.stringify(searched)).toContain('Brain not configured');
      const status = await runtime.kernel.execute(
        { targetType: 'operation', target: 'knowledge.status', input: {} },
        { sessionId: 'no-brain' },
      );
      console.log('knowledge.status ->', JSON.stringify(status).slice(0, 400));
      expect(JSON.stringify(status)).toContain('Brain not configured');
    } finally {
      await runtime.dispose();
    }
  });

  it('lets a provider that supplies knowledge.search take over', async () => {
    const descriptor = {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        name: 'knowledge.search',
        version: '1.0.0',
        description: 'Brain search.',
        tags: ['knowledge'],
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object', properties: { from: { type: 'string' } }, additionalProperties: false },
        annotations: { category: 'knowledge' },
        permissions: [],
    };
    const brain: CapabilityProvider = {
      id: 'marshal.selected-intelligence',
      list: () => [descriptor],
      get: (name) => (name === 'knowledge.search' ? descriptor : undefined),
      invoke: async () => ({ output: { from: 'brain' } }),
    };
    const runtime = await start([() => ({ providers: [brain] })]);
    try {
      cleanup.push(runtime.stateRoot);
      const searched = await runtime.kernel.execute(
        { targetType: 'operation', target: 'knowledge.search', input: { query: 'x' } },
        { sessionId: 'with-brain' },
      );
      console.log('with a Brain provider ->', JSON.stringify(searched).slice(0, 300));
      expect(searched.status).toBe('success');
      expect(JSON.stringify(searched)).toContain('"from":"brain"');
    } finally {
      await runtime.dispose();
    }
  });
});

const STAGED_BRAIN = process.env.STAGED_BRAIN_PACKAGE ?? '/Users/omer/.marshal-dev/brain-release-6d1fb1d';

async function startWithExtensions(extensionsRoot: string, parent: string) {
  const workspacePath = path.join(parent, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });
  const serviceContainer = createRuntimeServiceContainer();
  const runtime = await createAgentRuntime({
    serviceContainer,
    workspacePath,
    protectedLifecycleResultRoot: path.join(parent, 'private'),
    permissionBroker: allowAll,
    providerSources: [],
    extensions: { allowedRoots: [extensionsRoot], discoveryRoots: [extensionsRoot], restore: false },
  });
  return { runtime, serviceContainer };
}

async function installPackage(
  serviceContainer: ReturnType<typeof createRuntimeServiceContainer>,
  extensionsRoot: string,
  packageRoot: string,
) {
  const materializer = await createRuntimeHostMaterializer({ allowedRoots: [extensionsRoot] });
  const materialized = await materializer.materialize({ packageRoot });
  return serviceContainer.get(RUNTIME_EXTENSION_LIFECYCLE_SERVICE).install({
    packageRoot: materialized.packageRoot,
    integrity: materialized.integrity,
  });
}

describe('an extension that supplies knowledge.* after the host started', () => {
  it('replaces the "Brain not configured" answers, and they return when it is disabled', async () => {
    const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'brain-extension-')));
    cleanup.push(parent);
    const extensionsRoot = path.join(parent, 'extensions');
    const packageRoot = path.join(extensionsRoot, 'fake-brain');
    await fs.mkdir(path.join(packageRoot, 'dist'), { recursive: true });
    const names = ['knowledge.search', 'knowledge.schema', 'knowledge.health'];
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@fixture/brain', version: '1.0.0', type: 'commonjs', main: 'dist/index.cjs' }));
    await fs.writeFile(path.join(packageRoot, 'runtime-extension.json'), JSON.stringify({
      schemaVersion: 1, identity: '@fixture/brain', version: '1.0.0', entrypoint: 'dist/index.cjs', moduleFormat: 'commonjs-bundle-v1',
      contributes: { capabilities: names },
    }));
    await fs.writeFile(path.join(packageRoot, 'dist', 'index.cjs'), `
const names = ${JSON.stringify(names)};
const describe = (name) => ({ protocolVersion: '1.0.0', name, version: '1.0.0', description: name, tags: ['knowledge'],
  inputSchema: { type: 'object' }, outputSchema: { type: 'object', properties: { from: { type: 'string' } }, additionalProperties: false } });
module.exports = { activate() { return { capabilityProviders: [{
  id: 'marshal.selected-intelligence',
  list() { return names.map(describe); },
  get(name) { return names.includes(name) ? describe(name) : undefined; },
  invoke(name) { return { output: { from: 'extension:' + name } }; },
}] }; } };
`);
    const { runtime, serviceContainer } = await startWithExtensions(extensionsRoot, parent);
    try {
      cleanup.push(runtime.stateRoot);
      const ask = (target: string) => runtime.kernel.execute(
        { targetType: 'operation', target, input: { query: 'x' } }, { sessionId: 'ext' });
      const providerOf = (answered: Awaited<ReturnType<typeof ask>>) => answered.receipt?.provider.id;
      const before = await ask('knowledge.search');
      expect(providerOf(before)).toBe('marshal.brain-not-configured');
      expect(JSON.stringify(before)).toContain('Brain not configured');

      await installPackage(serviceContainer, extensionsRoot, await fs.realpath(packageRoot));
      for (const name of names) {
        const answered = await ask(name);
        expect(answered.status, name).toBe('success');
        expect(providerOf(answered)).toBe('marshal.selected-intelligence');
        expect(JSON.stringify(answered)).toContain(`extension:${name}`);
      }
      const status = await runtime.kernel.execute(
        { targetType: 'operation', target: 'knowledge.status', input: {} }, { sessionId: 'ext' });
      expect(providerOf(status)).toBe('marshal.brain-not-configured');

      await serviceContainer.get(RUNTIME_EXTENSION_LIFECYCLE_SERVICE).disable('@fixture/brain');
      const after = await ask('knowledge.search');
      expect(providerOf(after)).toBe('marshal.brain-not-configured');
      expect(JSON.stringify(after)).toContain('Brain not configured');
    } finally {
      await runtime.dispose();
    }
  });

  it.skipIf(!existsSync(STAGED_BRAIN))('activates the real staged Brain bundle and serves knowledge.search, knowledge.schema and knowledge.health', async () => {
    const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'brain-real-')));
    cleanup.push(parent);
    const extensionsRoot = path.join(parent, 'extensions');
    const packageRoot = path.join(extensionsRoot, 'brain');
    await fs.mkdir(extensionsRoot, { recursive: true });
    await fs.cp(STAGED_BRAIN, packageRoot, { recursive: true });
    const manifestPath = path.join(packageRoot, 'runtime-extension.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.configuration.defaults.cloudEnabled = true;
    manifest.configuration.defaults.brainRoutes = { workspace: { cloudUrl: 'https://brain.invalid', cloudAudience: 'https://brain.invalid' } };
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    const { runtime, serviceContainer } = await startWithExtensions(extensionsRoot, parent);
    try {
      cleanup.push(runtime.stateRoot);
      const installed = await installPackage(serviceContainer, extensionsRoot, await fs.realpath(packageRoot));
      expect(installed).toMatchObject({ identity: '@marshal/brain', status: 'enabled' });
      const found = await runtime.kernel.search({ query: 'knowledge', limit: 100 }, { sessionId: 'real-brain' });
      const providers: Record<string, string> = {};
      for (const match of found.matches) {
        if (match.capability.name.startsWith('knowledge.')) providers[match.capability.name] = match.capability.provider.id;
      }
      console.log('staged Brain provider per tool ->', JSON.stringify(providers));
      for (const name of ['knowledge.search', 'knowledge.schema', 'knowledge.health']) {
        expect(providers[name], name).toBe('marshal.selected-intelligence');
      }
      expect(Object.entries(providers).filter(([, id]) => id === 'marshal.brain-not-configured').map(([name]) => name))
        .not.toContain('knowledge.search');
    } finally {
      await runtime.dispose();
    }
  });
});
