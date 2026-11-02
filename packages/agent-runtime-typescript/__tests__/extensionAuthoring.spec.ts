import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAllowAllPermissionBroker,
  createRuntimeKernel,
  RUNTIME_PROTOCOL_VERSION,
  type InvocationContext,
} from '@marshal/agent-runtime-core';
import {
  createRuntimeServiceContainer,
  type RuntimeServiceAccessor,
} from '@marshal/agent-runtime-composer';
import {
  LocalRuntimeExtensionPackageLoader,
  RUNTIME_EXTENSION_LIFECYCLE_SERVICE,
  type RuntimeExtensionLifecycleService,
  RuntimeExtensionManager,
} from '@marshal/agent-runtime-extensions';
import {
  createTypeScriptExtensionAuthoringBundle,
  type TypeScriptExtensionAuthoringServiceBundle,
} from '../src/index.js';

const cleanup: string[] = [];

const context: InvocationContext = {
  principal: { id: 'author-agent', kind: 'agent' },
  identity: {
    harnessId: 'test-harness',
    installationId: 'install-1',
    profileId: 'profile-1',
    userId: 'user-1',
    agentId: 'author-agent',
  },
  scope: {
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    sessionId: 'session-1',
  },
};

const otherPrincipalContext: InvocationContext = {
  ...context,
  principal: { id: 'other-agent', kind: 'agent' },
};

const otherScopeContext: InvocationContext = {
  ...context,
  scope: {
    workspaceId: 'workspace-2',
    projectId: 'project-2',
    sessionId: 'session-2',
  },
};

afterEach(async () => {
  for (const root of cleanup.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('TypeScript extension authoring', () => {
  it('enforces strict bounds and scope isolation through the capability provider', async () => {
    const bundle = await makeBundle();
    const provider = bundle.provider;

    expect(provider.list).toBeDefined();
    expect((await provider.list(context)).map((descriptor) => descriptor.name).sort()).toEqual([
      'typescript.extension.candidate.get',
      'typescript.extension.candidate.install',
      'typescript.extension.candidate.list',
      'typescript.extension.candidate.materialize',
      'typescript.extension.candidate.remove',
      'typescript.extension.candidate.replace',
      'typescript.extension.draft.create',
      'typescript.extension.draft.get',
      'typescript.extension.draft.list',
      'typescript.extension.draft.update',
    ]);

    const created = await provider.invoke(
      'typescript.extension.draft.create',
      {
        schemaVersion: 1,
        draft: {
          schemaVersion: 1,
          draftId: 'draft-one',
          identity: '@example/authoring',
          version: '1.0.0',
          source: {
            kind: 'inline',
            filename: 'authoring.ts',
            source: `export function activate() { return {}; }`,
          },
          imports: { packages: [], builtins: [] },
        },
      },
      context,
    );
    expect(created.output).toMatchObject({
      draftId: 'draft-one',
      owner: { principalId: 'author-agent' },
      scope: { workspaceId: 'workspace-1' },
      source: { kind: 'inline', identifier: 'authoring.ts' },
    });

    await expect(
      provider.invoke(
        'typescript.extension.draft.create',
        {
          schemaVersion: 1,
          draft: {
            schemaVersion: 1,
            draftId: 'oversized',
            identity: '@example/oversized',
            version: '1.0.0',
            source: {
              kind: 'inline',
              filename: 'too-big.ts',
              source: 'x'.repeat(2 * 1024 * 1024 + 1),
            },
          },
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_DRAFT' });

    await expect(
      provider.invoke(
        'typescript.extension.draft.get',
        { schemaVersion: 1, draftId: 'draft-one' },
        otherPrincipalContext,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(
      provider.invoke(
        'typescript.extension.draft.list',
        { schemaVersion: 1 },
        otherScopeContext,
      ),
    ).resolves.toMatchObject({ output: { drafts: [] } });
  });

  it('materializes deterministic candidates and projects them through catalog and resources', async () => {
    const bundle = await makeBundle();
    const provider = bundle.provider;
    const created = await provider.invoke(
      'typescript.extension.draft.create',
      {
        schemaVersion: 1,
        draft: {
          schemaVersion: 1,
          draftId: 'draft-two',
          identity: '@example/materialize',
          version: '1.0.0',
          source: {
            kind: 'inline',
            filename: 'materialize.ts',
            source: `export function activate() { return {}; }`,
          },
          imports: { packages: [], builtins: [] },
          permissions: [{
            permission: 'runtime.example.materialize',
            reason: 'test',
            risk: 'low',
          }],
          contributions: {
            catalogEntries: [{
              id: 'runtime://example/catalog',
              kind: 'resource',
              title: 'Catalog entry',
              description: 'Test catalog entry.',
              action: { type: 'resource_read', uri: 'runtime://example/catalog' },
            }],
          },
        },
      },
      context,
    );
    expect(created.output.resource.uri).toMatch(/^runtime-extension-authoring:\/\/draft\//);

    const first = await provider.invoke(
      'typescript.extension.candidate.materialize',
      { schemaVersion: 1, draftId: 'draft-two' },
      context,
    );
    const second = await provider.invoke(
      'typescript.extension.candidate.materialize',
      { schemaVersion: 1, draftId: 'draft-two' },
      context,
    );

    expect(second.output).toMatchObject({
      candidateDigest: first.output.candidateDigest,
      packageRoot: first.output.packageRoot,
      materializationStatus: 'reused',
    });
    expect(first.output.resource.uri).toMatch(/^runtime-extension-authoring:\/\/candidate\//);

    const packageRoot = first.output.packageRoot;
    await expect(fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'))
      .resolves.toContain('"main":"dist/index.cjs"');
    await expect(fs.readFile(path.join(packageRoot, 'runtime-extension.json'), 'utf8'))
      .resolves.toContain('"schemaVersion":1');
    await expect(fs.readFile(path.join(packageRoot, 'dist', 'index.cjs'), 'utf8'))
      .resolves.toContain('activate');
    await expect(fs.readFile(path.join(packageRoot, 'marshal-extension-authoring.json'), 'utf8'))
      .resolves.toContain('"draftId":"draft-two"');

    await expect(bundle.resources.listResources(context)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uri: created.output.resource.uri }),
        expect.objectContaining({ uri: first.output.resource.uri }),
      ]),
    );
    await expect(bundle.catalog.list(context)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: created.output.resource.uri }),
        expect.objectContaining({ id: first.output.resource.uri }),
      ]),
    );
    await expect(bundle.resources.readResource(first.output.resource.uri, context)).resolves.toMatchObject({
      uri: first.output.resource.uri,
      mimeType: 'application/json',
    });
    await expect(bundle.catalogSource.list(context)).resolves.toEqual([
      expect.objectContaining({
        id: first.output.candidateDigest,
        origin: 'authored-typescript',
      }),
    ]);
    await expect(bundle.catalogSource.list(otherPrincipalContext)).resolves.toEqual([]);
    await expect(bundle.catalogSource.list(otherScopeContext)).resolves.toEqual([]);

    const restarted = createTypeScriptExtensionAuthoringBundle({
      workspaceRoot: bundle.workspaceRoot,
      storageRoot: bundle.storageRoot,
      services: bundle.services,
    });
    await expect(restarted.catalogSource.list(context)).resolves.toEqual([
      expect.objectContaining({
        id: first.output.candidateDigest,
        request: expect.objectContaining({ packageRoot }),
      }),
    ]);
    await restarted.dispose();
  });

  it('delegates install, replacement, rollback-safe failure, and removal to the lifecycle port', async () => {
    const kernel = createRuntimeKernel({ permissionBroker: createAllowAllPermissionBroker() });
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-authoring-workspace-'));
    const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-authoring-storage-'));
    cleanup.push(workspaceRoot, storageRoot);
    const services = createRuntimeServiceContainer();
    const manager = new RuntimeExtensionManager({
      kernel,
      loader: new LocalRuntimeExtensionPackageLoader({ allowedRoots: [storageRoot] }),
      activationContext: context,
      services,
    });
    const lifecycleBinding = await services.bind(
      RUNTIME_EXTENSION_LIFECYCLE_SERVICE,
      { useValue: manager },
    );
    const service = createTypeScriptExtensionAuthoringBundle({
      workspaceRoot,
      storageRoot,
      services,
    });

    const draftOne = await createDraft(service, 'install-one', '1.0.0', `export function activate() {
      return {
        capabilityProviders: [{
          id: 'example.authoring.provider',
          list() {
            return [{
              protocolVersion: '${RUNTIME_PROTOCOL_VERSION}',
              name: 'example.authoring.echo',
              version: '1.0.0',
              description: 'Test capability.',
              tags: ['test'],
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              outputSchema: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
                additionalProperties: false
              }
            }];
          },
          invoke() {
            return { output: { value: 'one' } };
          }
        }]
      };
    }`);
    const firstCandidate = await service.provider.invoke(
      'typescript.extension.candidate.materialize',
      { schemaVersion: 1, draftId: draftOne.draftId },
      context,
    );

    const install = await service.provider.invoke(
      'typescript.extension.candidate.install',
      { schemaVersion: 1, candidateDigest: firstCandidate.output.candidateDigest },
      context,
    );
    expect(install.output.record).toMatchObject({ identity: '@example/install-one', version: '1.0.0' });
    await expect(kernel.execute({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      targetType: 'operation',
      target: 'example.authoring.echo',
      input: {},
    }, context)).resolves.toMatchObject({ status: 'success', result: { output: { value: 'one' } } });

    const draftTwo = await createDraft(service, 'install-two', '2.0.0', `export function activate() {
      return {
        capabilityProviders: [{
          id: 'example.authoring.provider',
          list() {
            return [{
              protocolVersion: '${RUNTIME_PROTOCOL_VERSION}',
              name: 'example.authoring.echo',
              version: '2.0.0',
              description: 'Test capability.',
              tags: ['test'],
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              outputSchema: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
                additionalProperties: false
              }
            }];
          },
          invoke() {
            return { output: { value: 'two' } };
          }
        }]
      };
    }`);
    const secondCandidate = await service.provider.invoke(
      'typescript.extension.candidate.materialize',
      { schemaVersion: 1, draftId: draftTwo.draftId },
      context,
    );
    await service.provider.invoke(
      'typescript.extension.candidate.replace',
      { schemaVersion: 1, candidateDigest: secondCandidate.output.candidateDigest },
      context,
    );
    await expect(kernel.execute({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      targetType: 'operation',
      target: 'example.authoring.echo',
      input: {},
    }, context)).resolves.toMatchObject({ status: 'success', result: { output: { value: 'two' } } });

    const draftThree = await createDraft(service, 'install-three', '3.0.0', `export function activate() {
      throw new Error('boom');
    }`);
    const thirdCandidate = await service.provider.invoke(
      'typescript.extension.candidate.materialize',
      { schemaVersion: 1, draftId: draftThree.draftId },
      context,
    );
    await expect(
      service.provider.invoke(
        'typescript.extension.candidate.replace',
        { schemaVersion: 1, candidateDigest: thirdCandidate.output.candidateDigest },
        context,
      ),
    ).rejects.toMatchObject({ code: 'ACTIVATION_FAILED' });
    await expect(kernel.execute({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      targetType: 'operation',
      target: 'example.authoring.echo',
      input: {},
    }, context)).resolves.toMatchObject({ status: 'success', result: { output: { value: 'two' } } });

    await service.provider.invoke(
      'typescript.extension.candidate.remove',
      { schemaVersion: 1, candidateDigest: secondCandidate.output.candidateDigest },
      context,
    );
    await expect(kernel.execute({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      targetType: 'operation',
      target: 'example.authoring.echo',
      input: {},
    }, context)).resolves.toMatchObject({ status: 'not_found' });

    await expect(service.provider.invoke(
      'typescript.extension.candidate.list',
      { schemaVersion: 1 },
      context,
    )).resolves.toMatchObject({
      output: {
        candidates: expect.arrayContaining([
          expect.objectContaining({ candidateDigest: firstCandidate.output.candidateDigest }),
          expect.objectContaining({ candidateDigest: secondCandidate.output.candidateDigest }),
          expect.objectContaining({ candidateDigest: thirdCandidate.output.candidateDigest }),
        ]),
     },
   });
   await service.dispose();
   await manager.dispose();
   await lifecycleBinding.dispose();
   await services.shutdown();
  });

  it('commits the installed relationship only after lifecycle success and preserves it on cancellation', async () => {
   const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-authoring-workspace-'));
   const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-authoring-storage-'));
   cleanup.push(workspaceRoot, storageRoot);
   const services = createRuntimeServiceContainer();
   const controller = new AbortController();
   let installCalls = 0;
   const lifecycle: RuntimeExtensionLifecycleService = {
     restore: () => [],
     discover: () => [],
     install: async (request) => {
       installCalls += 1;
       if (installCalls === 1) controller.abort();
       return {
         identity: '@example/install-one',
         version: '1.0.0',
         integrity: request.integrity,
         entrypoint: 'dist/index.cjs',
         status: 'enabled',
         activationOrder: 0,
         configuration: {},
       };
     },
     update: async () => {
       throw new Error('not used');
     },
     configure: async () => {
       throw new Error('not used');
     },
     enable: async () => {
       throw new Error('not used');
     },
     disable: async () => {
       throw new Error('not used');
     },
     remove: async () => {},
     get: () => undefined,
     list: () => [],
   };
   await services.bind(RUNTIME_EXTENSION_LIFECYCLE_SERVICE, { useValue: lifecycle });
   const service = createTypeScriptExtensionAuthoringBundle({
     workspaceRoot,
     storageRoot,
     services,
   });
   const draft = await createDraft(service, 'cancelled-install', '1.0.0', 'export function activate() { return {}; }');
   const candidate = await service.provider.invoke(
     'typescript.extension.candidate.materialize',
     { schemaVersion: 1, draftId: draft.draftId },
     context,
   );

   await expect(service.provider.invoke(
     'typescript.extension.candidate.install',
     { schemaVersion: 1, candidateDigest: candidate.output.candidateDigest },
     { ...context, signal: controller.signal },
   )).rejects.toMatchObject({ code: 'CANCELLED' });

   const persisted = JSON.parse(await fs.readFile(path.join(storageRoot, 'authoring-state.json'), 'utf8')) as {
     installedCandidates?: readonly unknown[];
   };
   expect(persisted.installedCandidates).toEqual([]);
   await expect(fs.access(candidate.output.packageRoot)).resolves.toBeUndefined();
   await service.dispose();
   await services.shutdown();
  });
});

async function makeBundle(
  services: RuntimeServiceAccessor = createRuntimeServiceContainer(),
): Promise<TypeScriptExtensionAuthoringServiceBundle & {
  readonly workspaceRoot: string;
  readonly storageRoot: string;
  readonly services: RuntimeServiceAccessor;
}> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-authoring-workspace-'));
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-authoring-storage-'));
  cleanup.push(workspaceRoot, storageRoot);
  return Object.assign(
   createTypeScriptExtensionAuthoringBundle({
    workspaceRoot,
    storageRoot,
    services,
   }),
   { workspaceRoot, storageRoot, services },
  );
}

async function createDraft(
  bundle: TypeScriptExtensionAuthoringServiceBundle,
  draftId: string,
  version: string,
  source: string,
): Promise<{ readonly draftId: string }> {
  const response = await bundle.provider.invoke(
    'typescript.extension.draft.create',
    {
      schemaVersion: 1,
      draft: {
        schemaVersion: 1,
        draftId,
        identity: '@example/install-one',
        version,
        source: {
          kind: 'inline',
          filename: `${draftId}.ts`,
          source,
        },
        imports: { packages: [], builtins: [] },
      },
    },
    context,
  );
  expect(response.output).toMatchObject({ draftId, version });
  return { draftId };
}
