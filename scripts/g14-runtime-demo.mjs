import { execFileSync } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const authoritativeRuntimeCommit = 'e17df0d51df61e76190f59f5ebd323ad07dc7886';
const caseNames = [
  'authoritative-runtime-g13-commit',
  'build-integrated-runtime-artifacts',
  'packed-install-and-public-api-demo',
  'pinned-dsh-command-api-event-path',
  'native-extension-install-replace-cleanup',
  'scoped-agent-authored-typescript-execution',
  'live-ui-state-promotion-and-catalog',
  'restart-restores-extension-and-ui-state',
  'ordered-journal-replay-idempotency',
  'delegated-authority-provider-replacement',
  'native-and-promoted-extension-cleanup',
];
const cases = Object.fromEntries(caseNames.map((name) => [name, 'FAIL']));
const blockers = [];
const packedPackages = {
  core: '@marshal/agent-runtime-core',
  composer: '@marshal/agent-runtime-composer',
  extensions: '@marshal/agent-runtime-extensions',
  typescript: '@marshal/agent-runtime-typescript',
  ui: '@marshal/agent-runtime-ui',
};
let packedCompilerStop;

function run(args, cwd = root) {
  const executable = process.platform === 'win32'
    ? join(dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'pnpm.js')
    : 'pnpm';
  return execFileSync(process.platform === 'win32' ? process.execPath : executable, [
    ...(process.platform === 'win32' ? [executable] : []),
    ...args,
  ], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function runNpm(args, cwd) {
  const executable = process.platform === 'win32'
    ? process.execPath
    : 'npm';
  const npmCli = process.platform === 'win32'
    ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : undefined;
  return execFileSync(executable, [
    ...(npmCli ? [npmCli] : []),
    ...args,
  ], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function runGit(args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function pass(name) {
  cases[name] = 'PASS';
}

function fail(name, error) {
  cases[name] = 'FAIL';
  blockers.push(`${name}: ${errorMessage(error)}`);
}

function errorMessage(error) {
  if (error instanceof AggregateError) {
    return `${error.message}: ${error.errors.map(errorMessage).join('; ')}`;
  }
  if (error instanceof Error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout.trim() : '';
    const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : '';
    const output = [stdout, stderr].filter(Boolean).join('\n');
    return output ? `${error.message}: ${output}` : error.message;
  }
  return String(error);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertJsonEqual(actual, expected, message) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, received ${actualJson}`);
  }
}

function createG14PermissionBroker(expectedContext, authorizationRequests) {
  const allowedTargets = new Set([
    'g14.authored.identity-authority',
    'ui.authored.create',
    'ui.authored.promote',
    'ui.authored.read',
    'ui.authored.readSnapshot',
    'ui.authored.remove',
  ]);
  const expectedPrincipal = structuredClone(expectedContext.principal);
  const expectedScope = structuredClone(expectedContext.scope);
  return {
    decide(check) {
      const authorization = {
        target: check.request.target,
        principal: structuredClone(check.context.principal),
        scope: structuredClone(check.context.scope ?? null),
        requirements: structuredClone(check.requirements),
      };
      const allowed = allowedTargets.has(authorization.target)
        && JSON.stringify(authorization.principal) === JSON.stringify(expectedPrincipal)
        && JSON.stringify(authorization.scope) === JSON.stringify(expectedScope);
      const decision = allowed
        ? {
            decision: 'allow',
            reason: 'G14 harness-local operation grant.',
            grants: [authorization.target],
          }
        : {
            decision: 'deny',
            reason: 'G14 target or invocation scope is not granted.',
            code: 'g14_scope_denied',
          };
      authorizationRequests.push({
        ...authorization,
        decision: decision.decision,
      });
      return decision;
    },
  };
}

function parseLastJson(output) {
  let start = output.lastIndexOf('{');
  while (start >= 0) {
    try {
      return JSON.parse(output.slice(start));
    } catch {
      start = output.lastIndexOf('{', start - 1);
    }
  }
  throw new Error('Command did not emit a trailing JSON report.');
}

function requirePasses(report, names) {
  assert(report?.overall === 'PASS', 'G13 overall status was not PASS');
  for (const name of names) {
    assert(report.cases?.[name] === 'PASS', `G13 case ${name} was not PASS`);
  }
}

function check(name, operation) {
  try {
    operation();
    pass(name);
  } catch (error) {
    fail(name, error);
  }
}

async function stopPackedCompiler() {
  const stop = packedCompilerStop;
  packedCompilerStop = undefined;
  await stop?.();
}

async function createPackedConsumer(temporaryRoot) {
  const packRoot = join(temporaryRoot, 'packs');
  const consumerRoot = join(temporaryRoot, 'consumer');
  await Promise.all([
    mkdir(packRoot, { recursive: true }),
    mkdir(consumerRoot, { recursive: true }),
  ]);
  for (const packageName of Object.values(packedPackages)) {
    run([
      '--filter',
      packageName,
      'pack',
      '--pack-destination',
      packRoot,
      '--silent',
    ]);
  }
  const packedFiles = await readdir(packRoot);
  const dependencies = {};
  const tarballPaths = [];
  for (const packageName of Object.values(packedPackages)) {
    const expectedFile = `marshal-${packageName.slice('@marshal/'.length)}-0.1.0.tgz`;
    assert(
      packedFiles.includes(expectedFile),
      `Packed public package ${packageName} was not produced`,
    );
    const tarballPath = join(packRoot, expectedFile);
    dependencies[packageName] = `file:${tarballPath}`;
    tarballPaths.push(tarballPath);
  }
  await writeFile(join(consumerRoot, 'package.json'), JSON.stringify({
    name: 'g14-isolated-runtime-consumer',
    private: true,
    type: 'module',
    dependencies,
  }, null, 2));
  runNpm([
    'install',
    '--offline',
    '--no-package-lock',
    '--ignore-scripts',
    ...tarballPaths,
  ], consumerRoot);
  const requireFromConsumer = createRequire(join(consumerRoot, 'package.json'));
  const modules = {};
  for (const [key, packageName] of Object.entries(packedPackages)) {
    const entrypoint = requireFromConsumer.resolve(packageName);
    assert(
      resolve(entrypoint).startsWith(resolve(consumerRoot)),
      `Public package ${packageName} did not resolve from the isolated consumer`,
    );
    modules[key] = await import(pathToFileURL(entrypoint).href);
  }
  const esbuildEntrypoint = requireFromConsumer.resolve('esbuild');
  const esbuild = await import(pathToFileURL(esbuildEntrypoint).href);
  packedCompilerStop = esbuild.stop;
  assert(
    typeof modules.core.createRuntimeKernel === 'function'
      && typeof modules.composer.createRuntimeServiceContainer === 'function'
      && typeof modules.extensions.RuntimeExtensionManager === 'function'
      && typeof modules.typescript.createTypeScriptExtensionAuthoringBundle === 'function'
      && typeof modules.ui.ReactUiAuthoredStateProvider === 'function',
    'Packed Runtime public API surface is incomplete',
  );
  return { consumerRoot, modules };
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function executeSuccess(core, kernel, target, input, context) {
  const execution = await kernel.execute({
    protocolVersion: core.RUNTIME_PROTOCOL_VERSION,
    targetType: 'operation',
    target,
    input,
  }, context);
  assert(
    execution.status === 'success',
    `${target} returned ${execution.status}: ${JSON.stringify(execution.error ?? null)}`,
  );
  return execution.result?.output;
}

async function invokeProvider(provider, target, input, context) {
  return (await provider.invoke(target, input, context)).output;
}

function authoredExtensionSource(protocolVersion) {
  return `
import {
  createRuntimeServiceToken,
  RUNTIME_AUTHORITY_PROVIDER,
  RUNTIME_IDENTITY_PROVIDER
} from '@marshal/agent-runtime-composer';

const serviceToken = createRuntimeServiceToken('@g14/authored-extension:service');
const descriptor = {
  protocolVersion: '${protocolVersion}',
  name: 'g14.authored.identity-authority',
  version: '1.0.0',
  description: 'Resolve the live Runtime identity and authority providers.',
  tags: ['g14', 'identity', 'authority'],
  permissions: [{
    permission: 'runtime.g14.identity-authority.read',
    reason: 'Resolve the harness-provided Runtime identity and authority.',
    scope: 'workspace/project/session',
    risk: 'low'
  }],
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    required: ['identity', 'authority'],
    additionalProperties: false,
    properties: {
      identity: {
        type: 'object',
        required: ['harnessId', 'installationId', 'profileId', 'userId', 'agentId'],
        additionalProperties: false,
        properties: {
          harnessId: { type: 'string' },
          installationId: { type: 'string' },
          profileId: { type: 'string' },
          userId: { type: 'string' },
          agentId: { type: 'string' }
        }
      },
      authority: {
        type: 'object',
        required: ['workspaceId', 'projectId'],
        additionalProperties: false,
        properties: {
          workspaceId: { type: 'string' },
          projectId: { type: 'string' }
        }
      }
    }
  }
};

export function activate(context) {
  return {
    serviceContributions: [{
      token: serviceToken,
      mode: 'bind',
      binding: {
        useValue: {
          marker: 'g14-authored-service',
          package: '@g14/authored-extension'
        }
      }
    }],
    capabilityProviders: [{
      id: 'g14.authored.identity-authority.provider',
      list() {
        return [descriptor];
      },
      get(name) {
        return name === descriptor.name ? descriptor : undefined;
      },
      invoke(name, input) {
        if (name !== descriptor.name) throw new Error('Unknown G14 capability.');
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) {
          throw new Error('G14 capability input must be an empty object.');
        }
        const identity = context.services.get(RUNTIME_IDENTITY_PROVIDER).resolveIdentity();
        const authority = context.services.get(RUNTIME_AUTHORITY_PROVIDER).resolveAuthority();
        if (!identity) throw new Error('Runtime identity provider returned no identity.');
        return { output: { identity, authority } };
      }
    }],
    uiApplications: [{
      id: 'g14-authored-typescript-ui',
      title: 'G14 authored TypeScript UI',
      description: 'UI published by the agent-authored TypeScript extension.',
      renderId: 'g14-authored-typescript-render',
      resource: {
        uri: 'ui://g14/authored-typescript',
        mimeType: 'text/html',
        text: '<main>G14 authored TypeScript UI</main>'
      },
      application: {
        version: '1.0.0',
        presentationModes: ['inline'],
        actions: [],
        tools: [],
        localState: { scope: 'project', schemaVersion: '1.0.0' }
      },
      tags: ['g14', 'typescript']
    }]
  };
}
`;
}

async function createRuntimeGeneration(
  modules,
  paths,
  context,
  identity,
  authority,
  authorizationRequests,
) {
  const { composer, core, extensions, typescript, ui } = modules;
  const services = composer.createRuntimeServiceContainer();
  const publication = new extensions.RuntimeExtensionUiPublicationRegistry([]);
  const authoredState = new ui.ReactUiAuthoredStateStore({
    storageRoot: paths.authoredStateRoot,
  });
  await services.bind(composer.RUNTIME_IDENTITY_PROVIDER, {
    useValue: composer.createStaticRuntimeIdentityProvider(identity),
  });
  await services.bind(composer.RUNTIME_AUTHORITY_PROVIDER, {
    useValue: composer.createStaticRuntimeAuthorityProvider(authority),
  });
  await services.bind(extensions.RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE, {
    useValue: publication,
  });
  await services.bind(ui.RUNTIME_AUTHORED_UI_STATE_SERVICE, {
    useValue: authoredState,
  });
  const kernel = core.createRuntimeKernel({
    permissionBroker: createG14PermissionBroker(context, authorizationRequests),
  });
  const manager = new extensions.RuntimeExtensionManager({
    kernel,
    services,
    loader: new extensions.LocalRuntimeExtensionPackageLoader({
      allowedRoots: [paths.authoringRoot, paths.promotionRoot],
    }),
    activationContext: context,
    stateStore: new extensions.JsonFileRuntimeExtensionStateStore(
      paths.extensionStatePath,
    ),
  });
  await services.bind(extensions.RUNTIME_EXTENSION_LIFECYCLE_SERVICE, {
    useValue: manager,
  });
  const authoring = typescript.createTypeScriptExtensionAuthoringBundle({
    workspaceRoot: paths.workspaceRoot,
    storageRoot: paths.authoringRoot,
    workingDirectory: paths.consumerRoot,
    services,
  });
  const promotion = extensions.createRuntimeAuthoredUiPromotionBundle({
    services,
    root: paths.promotionRoot,
    resourceReader: {
      read: async (snapshot) => ({
        uri: `ui://g14/promoted/${snapshot.identity.id}`,
        mimeType: 'text/html',
        text: `<main>${snapshot.title}</main>`,
      }),
    },
  });
  const registrations = [
    kernel.register(new ui.ReactUiAuthoredStateProvider(services)),
    kernel.register(promotion.provider),
  ];
  return {
    services,
    publication,
    authoredState,
    kernel,
    manager,
    authoring,
    promotion,
    registrations,
  };
}

async function closeRuntimeGeneration(generation) {
  for (const registration of [...generation.registrations].reverse()) {
    registration.dispose();
  }
  await generation.manager.dispose();
  await generation.authoring.dispose();
  await generation.services.shutdown();
}

async function runRuntimeSequence(temporaryRoot) {
  const { consumerRoot, modules } = await createPackedConsumer(temporaryRoot);
  const { core, composer } = modules;
  pass('packed-install-and-public-api-demo');
  const identity = {
    harnessId: 'g14-harness',
    installationId: 'g14-installation',
    profileId: 'g14-profile',
    userId: 'g14-user',
    agentId: 'g14-author-agent',
  };
  const authority = {
    workspaceId: 'g14-workspace',
    projectId: 'g14-project',
  };
  const context = {
    principal: { id: identity.agentId, kind: 'agent' },
    identity,
    scope: {
      ...authority,
      sessionId: 'g14-session',
    },
  };
  const replacementIdentity = {
    harnessId: 'g14-replacement-harness',
    installationId: 'g14-replacement-installation',
    profileId: 'g14-replacement-profile',
    userId: 'g14-replacement-user',
    agentId: 'g14-replacement-agent',
  };
  const replacementAuthority = {
    workspaceId: 'g14-replacement-workspace',
    projectId: 'g14-replacement-project',
  };
  const paths = {
    consumerRoot,
    workspaceRoot: join(consumerRoot, 'workspace'),
    authoringRoot: join(consumerRoot, 'runtime-state', 'authored-typescript'),
    promotionRoot: join(consumerRoot, 'runtime-state', 'promoted-ui'),
    authoredStateRoot: join(consumerRoot, 'runtime-state', 'authored-ui-state'),
    extensionStatePath: join(
      consumerRoot,
      'runtime-state',
      'extension-state',
      'state.json',
    ),
  };
  const authorizationRequests = [];
  await Promise.all([
    mkdir(paths.workspaceRoot, { recursive: true }),
    mkdir(paths.authoringRoot, { recursive: true }),
    mkdir(paths.promotionRoot, { recursive: true }),
  ]);

  const first = await createRuntimeGeneration(
    modules,
    paths,
    context,
    identity,
    authority,
    authorizationRequests,
  );
  const draft = await invokeProvider(
    first.authoring.provider,
    'typescript.extension.draft.create',
    {
      schemaVersion: 1,
      draft: {
        schemaVersion: 1,
        draftId: 'g14-authored-extension',
        identity: '@g14/authored-extension',
        version: '1.0.0',
        source: {
          kind: 'inline',
          filename: 'g14-authored-extension.ts',
          source: authoredExtensionSource(core.RUNTIME_PROTOCOL_VERSION),
        },
        imports: {
          packages: ['@marshal/agent-runtime-composer'],
          builtins: [],
        },
      },
    },
    context,
  );
  assertJsonEqual(draft.owner, {
    principalId: context.principal.id,
    principalKind: context.principal.kind,
    ...identity,
  }, 'Authored TypeScript draft did not preserve Runtime identity');
  assertJsonEqual(draft.scope, context.scope, 'Authored TypeScript draft scope mismatch');
  const candidateSummary = await invokeProvider(
    first.authoring.provider,
    'typescript.extension.candidate.materialize',
    { schemaVersion: 1, draftId: draft.draftId },
    context,
  );
  const candidate = candidateSummary.sidecar;
  assert(
    candidate.compilation.importedPackages.includes(
      '@marshal/agent-runtime-composer',
    ),
    'Authored TypeScript candidate did not record its Runtime composer import',
  );
  const discovered = await first.manager.discover({
    candidates: [{
      request: {
        packageRoot: candidateSummary.packageRoot,
        integrity: candidateSummary.integrity,
      },
    }],
  });
  assert(
    discovered.some((record) =>
      record.identity === '@g14/authored-extension'
      && record.status === 'enabled'),
    'Agent-authored TypeScript package discovery did not install the extension',
  );
  const authoredServiceToken = composer.createRuntimeServiceToken(
    '@g14/authored-extension:service',
  );
  assertJsonEqual(
    first.services.get(authoredServiceToken),
    {
      marker: 'g14-authored-service',
      package: '@g14/authored-extension',
    },
    'Discovered TypeScript extension service contribution was not bound',
  );
  const discoveredCapabilities = await first.kernel.runtimeSearch({
    protocolVersion: core.RUNTIME_PROTOCOL_VERSION,
    query: 'g14.authored',
  }, context);
  assert(
    discoveredCapabilities.matches?.some((match) =>
      match.capability?.name === 'g14.authored.identity-authority'),
    'Discovered TypeScript extension capability was not searchable',
  );
  const firstResolution = await executeSuccess(
    core,
    first.kernel,
    'g14.authored.identity-authority',
    {},
    context,
  );
  assertJsonEqual(
    firstResolution,
    { identity, authority },
    'Agent-authored TypeScript extension did not resolve live Runtime providers',
  );
  const grantedAuthorization = authorizationRequests.find((authorization) =>
    authorization.target === 'g14.authored.identity-authority'
    && authorization.decision === 'allow');
  assert(
    grantedAuthorization,
    'Authored TypeScript capability authorization was not recorded as granted',
  );
  assertJsonEqual(
    grantedAuthorization.principal,
    context.principal,
    'Authored capability grant principal mismatch',
  );
  assertJsonEqual(
    grantedAuthorization.scope,
    context.scope,
    'Authored capability grant scope mismatch',
  );
  assertJsonEqual(
    grantedAuthorization.requirements,
    [{
      permission: 'runtime.g14.identity-authority.read',
      reason: 'Resolve the harness-provided Runtime identity and authority.',
      scope: 'workspace/project/session',
      risk: 'low',
    }],
    'Authored capability permission requirements mismatch',
  );
  const outOfScopeContext = {
    ...context,
    scope: {
      ...context.scope,
      sessionId: 'g14-out-of-scope-session',
    },
  };
  const deniedProbe = await first.kernel.execute({
    protocolVersion: core.RUNTIME_PROTOCOL_VERSION,
    targetType: 'operation',
    target: 'g14.authored.identity-authority',
    input: {},
  }, outOfScopeContext);
  assert(
    deniedProbe.status === 'denied'
      && deniedProbe.error?.code === 'g14_scope_denied',
    'Out-of-scope authored capability probe was not denied',
  );
  const deniedAuthorization = authorizationRequests.at(-1);
  assert(
    deniedAuthorization?.target === 'g14.authored.identity-authority'
      && deniedAuthorization.decision === 'deny',
    'Out-of-scope authorization denial was not recorded',
  );
  assertJsonEqual(
    deniedAuthorization.scope,
    outOfScopeContext.scope,
    'Denied authorization probe scope mismatch',
  );
  const firstAuthoredResource = await first.manager.resources.readResource(
    'ui://g14/authored-typescript',
    context,
  );
  assert(
    firstAuthoredResource.text === '<main>G14 authored TypeScript UI</main>',
    'Agent-authored TypeScript UI resource was not live',
  );
  pass('scoped-agent-authored-typescript-execution');

  const createdUi = await executeSuccess(
    core,
    first.kernel,
    'ui.authored.create',
    {
    identity: { id: 'g14-promoted-ui' },
    title: 'G14 promoted UI',
    description: 'Runtime-authored UI promoted to a native extension.',
    tags: ['g14', 'promoted'],
    metadata: { source: 'g14-demo' },
    application: {
      version: '1.0.0',
      presentationModes: ['inline'],
      actions: [],
      tools: [],
      localState: { scope: 'project', schemaVersion: '1.0.0' },
    },
    props: { phase: 'live' },
    provenance: {
      kind: 'authored_typescript',
      sourceDigest: 'a'.repeat(64),
      componentId: 'b'.repeat(64),
      renderId: 'c'.repeat(64),
      componentDigest: 'd'.repeat(64),
      renderDigest: 'e'.repeat(64),
    },
    initialState: { count: 1 },
    },
    context,
  );
  const snapshot = createdUi.application;
  assert(
    (await first.authoredState.read(snapshot.identity.id, context))
      ?.snapshotDigest === snapshot.snapshotDigest,
    'Authored UI capability did not use the bound state service',
  );
  const promotionRequest = {
    applicationId: snapshot.identity.id,
    snapshotDigest: snapshot.snapshotDigest,
    packageIdentity: '@g14/promoted-ui',
    packageVersion: '1.0.0',
    catalogEntryId: 'g14-promoted-ui-catalog',
  };
  const promotion = await executeSuccess(
    core,
    first.kernel,
    'ui.authored.promote',
    promotionRequest,
    context,
  );
  assert(promotion.action === 'installed', 'Authored UI was not promoted');
  const liveCatalog = await first.promotion.catalogSource.list(context);
  assert(
    liveCatalog.length === 1
      && liveCatalog[0].id === promotionRequest.catalogEntryId
      && liveCatalog[0].identity === promotionRequest.packageIdentity,
    'Promoted UI catalog entry was not live',
  );
  const liveApplications = await first.publication.listApplications(context);
  assert(
    liveApplications.some((application) =>
      application.id === 'g14-authored-typescript-ui'
      && application.ownerId === '@g14/authored-extension'),
    'Agent-authored TypeScript UI application was not published',
  );
  assert(
    liveApplications.some((application) =>
      application.id === snapshot.identity.id
      && application.ownerId === promotionRequest.packageIdentity),
    'Promoted UI application was not published',
  );
  const promotedResource = await first.manager.resources.readResource(
    `ui://g14/promoted/${snapshot.identity.id}`,
    context,
  );
  assert(
    promotedResource.text === '<main>G14 promoted UI</main>',
    'Promoted UI resource was not readable',
  );
  pass('live-ui-state-promotion-and-catalog');

  await closeRuntimeGeneration(first);

  const restarted = await createRuntimeGeneration(
    modules,
    paths,
    context,
    identity,
    authority,
    authorizationRequests,
  );
  const restoredRecords = await restarted.manager.restore();
  assert(
    restoredRecords.length === 2
      && restoredRecords.some((record) =>
        record.identity === '@g14/authored-extension'
        && record.status === 'enabled')
      && restoredRecords.some((record) =>
        record.identity === promotionRequest.packageIdentity
        && record.status === 'enabled'),
    'Restart did not restore both enabled extensions',
  );
  assertJsonEqual(
    restarted.services.get(authoredServiceToken),
    {
      marker: 'g14-authored-service',
      package: '@g14/authored-extension',
    },
    'Restart did not restore the TypeScript extension service contribution',
  );
  const restartedCandidateList = await invokeProvider(
    restarted.authoring.provider,
    'typescript.extension.candidate.list',
    { schemaVersion: 1 },
    context,
  );
  assert(
    restartedCandidateList.candidates.some((entry) =>
      entry.candidateDigest === candidateSummary.candidateDigest),
    'Restart did not restore the authored TypeScript candidate',
  );
  const restartedResolution = await executeSuccess(
    core,
    restarted.kernel,
    'g14.authored.identity-authority',
    {},
    context,
  );
  assertJsonEqual(
    restartedResolution,
    { identity, authority },
    'Restarted TypeScript extension did not resolve Runtime providers',
  );
  const restartedRead = await executeSuccess(
    core,
    restarted.kernel,
    'ui.authored.read',
    { id: snapshot.identity.id },
    context,
  );
  const restartedSnapshot = restartedRead.application;
  assert(
    restartedSnapshot?.snapshotDigest === snapshot.snapshotDigest
      && restartedSnapshot?.state.count === 1,
    'Restart did not restore authored UI state',
  );
  const restartedImmutableSnapshot = await executeSuccess(
    core,
    restarted.kernel,
    'ui.authored.readSnapshot',
    {
      id: snapshot.identity.id,
      snapshotDigest: snapshot.snapshotDigest,
    },
    context,
  );
  assert(
    restartedImmutableSnapshot.application?.snapshotDigest
      === snapshot.snapshotDigest,
    'Restart did not restore the immutable authored UI snapshot',
  );
  const restartedApplications = await restarted.publication.listApplications(
    context,
  );
  assert(
    restartedApplications.length === 2
      && restartedApplications.some((application) =>
        application.id === 'g14-authored-typescript-ui')
      && restartedApplications.some((application) =>
        application.id === snapshot.identity.id),
    'Restart did not restore both UI applications',
  );
  const restartedCatalog = await restarted.promotion.catalogSource.list(context);
  assert(
    restartedCatalog.length === 1
      && restartedCatalog[0].id === promotionRequest.catalogEntryId,
    'Restart did not restore the promoted UI catalog',
  );
  pass('restart-restores-extension-and-ui-state');

  const journal = core.createInMemoryRuntimeEventJournal();
  const checkpoints = core.createInMemoryRuntimeEventCheckpointStore();
  await journal.append({
    streamId: 'g14',
    eventId: 'effect-1',
    type: 'external.effect',
    occurredAt: new Date(0).toISOString(),
    payload: { value: 'once' },
  });
  let effects = 0;
  const consumer = {
    idempotencyKey: () => 'g14-effect',
    handle: () => {
      effects += 1;
    },
  };
  await core.replayRuntimeEvents(
    journal,
    checkpoints,
    'g14',
    'g14-consumer',
    consumer,
    { maxEvents: 10 },
  );
  await core.replayRuntimeEvents(
    journal,
    checkpoints,
    'g14',
    'g14-consumer',
    consumer,
    { maxEvents: 10 },
  );
  assert(effects === 1, `Expected one external effect, observed ${effects}`);
  pass('ordered-journal-replay-idempotency');

  await restarted.services.replace(composer.RUNTIME_IDENTITY_PROVIDER, {
    useValue: composer.createStaticRuntimeIdentityProvider(replacementIdentity),
  });
  await restarted.services.replace(composer.RUNTIME_AUTHORITY_PROVIDER, {
    useValue: composer.createStaticRuntimeAuthorityProvider(replacementAuthority),
  });
  const replacedResolution = await executeSuccess(
    core,
    restarted.kernel,
    'g14.authored.identity-authority',
    {},
    context,
  );
  assertJsonEqual(
    replacedResolution,
    {
      identity: replacementIdentity,
      authority: replacementAuthority,
    },
    'Authored TypeScript extension did not observe identity-authority replacement',
  );
  pass('delegated-authority-provider-replacement');

  await restarted.manager.disable('@g14/authored-extension');
  assert(
    restarted.manager.get('@g14/authored-extension')?.status === 'disabled',
    'Authored TypeScript extension did not disable explicitly',
  );
  assert(
    restarted.services.tryGet(authoredServiceToken) === undefined,
    'Authored TypeScript service contribution survived disable',
  );
  const disabledCapability = await restarted.kernel.execute({
    protocolVersion: core.RUNTIME_PROTOCOL_VERSION,
    targetType: 'operation',
    target: 'g14.authored.identity-authority',
    input: {},
  }, context);
  assert(
    disabledCapability.status === 'not_found',
    'Authored TypeScript capability survived disable',
  );
  await invokeProvider(
    restarted.authoring.provider,
    'typescript.extension.candidate.remove',
    { schemaVersion: 1, candidateDigest: candidateSummary.candidateDigest },
    context,
  );
  assert(
    restarted.manager.get('@g14/authored-extension') === undefined,
    'Authored TypeScript extension survived uninstall',
  );
  await restarted.manager.disable(promotionRequest.packageIdentity);
  assert(
    restarted.manager.get(promotionRequest.packageIdentity)?.status === 'disabled',
    'Promoted UI extension did not disable explicitly',
  );
  await restarted.manager.remove(promotionRequest.packageIdentity);
  assert(
    restarted.manager.get(promotionRequest.packageIdentity) === undefined,
    'Promoted UI extension survived uninstall',
  );
  const removedUiState = await executeSuccess(
    core,
    restarted.kernel,
    'ui.authored.remove',
    {
      id: snapshot.identity.id,
      expectedVersion: snapshot.version,
    },
    context,
  );
  assert(removedUiState.removed === true, 'Authored UI state was not removed');
  assert(restarted.manager.list().length === 0, 'Extension records survived cleanup');
  const removedCapability = await restarted.kernel.execute({
    protocolVersion: core.RUNTIME_PROTOCOL_VERSION,
    targetType: 'operation',
    target: 'g14.authored.identity-authority',
    input: {},
  }, context);
  assert(
    removedCapability.status === 'not_found',
    'Agent-authored TypeScript capability survived cleanup',
  );
  assert(
    (await restarted.publication.listApplications(context)).length === 0,
    'Published UI applications survived cleanup',
  );
  assert(
    (await restarted.manager.resources.listResources(context)).length === 0,
    'Extension resources survived cleanup',
  );
  assert(
    (await restarted.promotion.catalogSource.list(context)).length === 0,
    'Promoted UI catalog entry survived cleanup',
  );
  assert(
    (await executeSuccess(
      core,
      restarted.kernel,
      'ui.authored.read',
      { id: snapshot.identity.id },
      context,
    )).application === undefined,
    'Authored UI live state survived cleanup',
  );
  await closeRuntimeGeneration(restarted);
  await stopPackedCompiler();
  await rm(temporaryRoot, { recursive: true, force: true });
  assert(!await pathExists(temporaryRoot), 'Temporary Runtime package roots survived cleanup');
  pass('native-and-promoted-extension-cleanup');
}

async function main() {
  check('authoritative-runtime-g13-commit', () => {
    const head = runGit(['rev-parse', 'HEAD']).trim();
    const resolved = runGit(['rev-parse', authoritativeRuntimeCommit]).trim();
    assert(
      resolved === authoritativeRuntimeCommit,
      'Authoritative Runtime+G13 commit is unavailable',
    );
    assert(
      head !== authoritativeRuntimeCommit,
      'G14 HEAD must be a proper descendant of the authoritative G13 commit',
    );
    runGit([
      'merge-base',
      '--is-ancestor',
      authoritativeRuntimeCommit,
      'HEAD',
    ]);
  });

  check('build-integrated-runtime-artifacts', () => {
    run(['--filter', '@marshal/runtime...', 'build']);
  });

  let g13Report;
  try {
    g13Report = parseLastJson(
      run(['exec', 'node', 'scripts/g13-conformance.mjs']),
    );
  } catch (error) {
    fail('pinned-dsh-command-api-event-path', error);
    fail('native-extension-install-replace-cleanup', error);
  }
  if (g13Report) {
    check('pinned-dsh-command-api-event-path', () => {
      requirePasses(g13Report, [
        'dsh-pinned-plugin-command',
        'dsh-pinned-plugin-api-proxy',
        'dsh-pinned-plugin-event-bridge',
      ]);
    });
    check('native-extension-install-replace-cleanup', () => {
      requirePasses(g13Report, [
        'native-install-discovery-activation-contributions',
        'native-configuration',
        'native-disable-enable',
        'native-replacement',
        'native-uninstall',
        'native-service-capability-event-ui-catalog-cleanup',
      ]);
    });
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'marshal-runtime-g14-'));
  try {
    await runRuntimeSequence(temporaryRoot);
  } catch (error) {
    blockers.push(`runtime-demo-sequence: ${errorMessage(error)}`);
  } finally {
    await stopPackedCompiler();
    if (await pathExists(temporaryRoot)) {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  const overall = Object.values(cases).every((value) => value === 'PASS')
    ? 'PASS'
    : 'FAIL';
  process.stdout.write(JSON.stringify({
    overall,
    authoritativeRuntimeCommit,
    cases,
    ...(blockers.length ? { blockers } : {}),
  }));
  if (overall !== 'PASS') process.exitCode = 1;
}

await main();
