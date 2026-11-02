import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { digestFixtureTree, preflightCodexDriver, runCodexDriver } from '../codex-driver.mjs';
import { attestOfflineNetworkPolicy } from '../offline-network-guard.mjs';
import { sha256 } from '../core.mjs';

const fakeCodex = resolve('scripts/evals/__tests__/fixtures/fake-codex.mjs');
const offlineNetworkGuard = resolve('scripts/evals/offline-network-guard.mjs');
const confinementLauncher = resolve('scripts/evals/__tests__/fixtures/fake-confinement-launcher.mjs');
const objectiveOracle = resolve('scripts/evals/__tests__/fixtures/fake-objective-oracle.mjs');

test('Codex driver isolates plugin arms, creates fresh tasks, resumes exact ids, and extracts exposed evidence', async () => {
  const fixture = await createProtocolFixture();
  const priorLog = process.env.FAKE_CODEX_LOG;
  process.env.FAKE_CODEX_LOG = fixture.logPath;
  try {
    const result = await runCodexDriver(fixture.request, { allowTestConfinement: true });
    assert.equal(result.evidenceClass, 'live');
    assert.equal(result.status, 'passed');
    assert.equal(result.phaseOutputs.length, 2);
    assert.match(result.finalOutput, /phase two/);
    assert.deepEqual(result.tokens, { input: 20, output: 8, cached: 4 });
    assert.equal(result.toolCalls, 2);
    assert.deepEqual(result.receipts.map((value) => value.id), ['receipt-fresh', 'receipt-resume']);
    assert.equal(result.generatedFiles.length, 2);
    assert.equal(result.availability.cost.status, 'available');
    assert.equal(result.estimatedCostUsd, 0.0000568);
    assert.deepEqual(Object.keys(result.assertionObservations), ['protocol-observation']);
    assert.equal(result.releaseAttestations.liveAuthorizationDigest.length, 64);
    assert.equal(result.releaseAttestations.processConfinementMeasurementDigest.length, 64);
    assert.equal(result.availability.confinementLease.status, 'unavailable');
    assert.equal(result.availability.uiEvidence.status, 'unavailable');

    const calls = (await readFile(fixture.logPath, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].resumed, false);
    assert.equal(calls[1].resumed, true);
    assert.equal(calls[1].threadId, calls[0].threadId);
    assert.equal(calls.every((call) => call.args.includes('plugins."marshal-runtime@test".enabled=true')), true);
    assert.equal(calls[0].args.includes('fixture-model'), true);
  } finally {
    if (priorLog === undefined) delete process.env.FAKE_CODEX_LOG;
    else process.env.FAKE_CODEX_LOG = priorLog;
  }
});

test('baseline preflight disables only Marshal and preserves the pinned empty common plugin set', async () => {
  const fixture = await createProtocolFixture({ treatmentId: 'codex-baseline', installed: false });
  const preflight = await preflightCodexDriver(fixture.request, { allowTestConfinement: true });
  assert.equal(preflight.supported, true, preflight.blockers.join('\n'));
  assert.equal(preflight.resolved.effectivePluginEnabled, false);
  assert.equal(preflight.availability.pluginIsolation.status, 'available');
});

test('UI-required cases fail preflight explicitly and never become live evidence', async () => {
  const fixture = await createProtocolFixture({ targetCapabilities: ['ui'] });
  const result = await runCodexDriver(fixture.request, { allowTestConfinement: true });
  assert.equal(result.evidenceClass, 'unavailable');
  assert.equal(result.status, 'skipped');
  assert.equal(result.excluded, true);
  assert.equal(result.errorCategory, 'codex-driver-preflight-unsupported');
  assert.match(result.errorMessage, /no MCP Apps render host/i);
  assert.equal(result.availability.uiEvidence.status, 'unavailable');
});

test('missing external network guard is an actionable unsupported preflight, not live evidence', async () => {
  const fixture = await createProtocolFixture();
  delete fixture.request.driver.networkFixtureGuard;
  const result = await runCodexDriver(fixture.request, { allowTestConfinement: true });
  assert.equal(result.evidenceClass, 'unavailable');
  assert.equal(result.status, 'skipped');
  assert.match(result.errorMessage, /networkFixtureGuard/);
});

test('deny-all guard rejects an effective config with an enabled user MCP server', async () => {
  const fixture = await createProtocolFixture();
  const networkFixture = JSON.parse(await readFile(fixture.request.inputs.networkFixture.path, 'utf8'));
  await assert.rejects(() => attestOfflineNetworkPolicy({
    schemaVersion: '1.0.0',
    fixturePath: fixture.request.inputs.networkFixture.path,
    fixtureSha256: fixture.request.inputs.networkFixture.sha256,
    fixture: networkFixture,
    enforcement: {
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      configOverrides: fixture.request.driver.configOverrides,
      commonEnabledPlugins: [],
      effectiveConfig: {
        approval_policy: 'never',
        sandbox_mode: 'workspace-write',
        web_search: 'disabled',
        sandbox_workspace_write: { network_access: false },
        features: { apps: false },
        apps: { _default: { enabled: false, open_world_enabled: false } },
        mcp_servers: { remote: { enabled: true, url: 'https://example.invalid/mcp' } },
      },
    },
  }), /Enabled user MCP servers are forbidden/);
});

test('model invocation is deny-by-default after a successful preflight', async () => {
  const fixture = await createProtocolFixture();
  fixture.request.driver.allowModelInvocation = false;
  const result = await runCodexDriver(fixture.request, { allowTestConfinement: true });
  assert.equal(result.evidenceClass, 'unavailable');
  assert.equal(result.status, 'skipped');
  assert.match(result.exclusionReason, /Model invocation is disabled/);
});

test('live invocation fails closed without explicit operator authorization and descendant confinement', async () => {
  const fixture = await createProtocolFixture();
  delete fixture.request.driver.liveAuthorization;
  delete fixture.request.driver.processConfinement;
  const result = await runCodexDriver(fixture.request, { allowTestConfinement: true });
  assert.equal(result.evidenceClass, 'unavailable');
  assert.match(result.errorMessage, /liveAuthorization|authorization/i);
});

test('live invocation rejects wildcard trusted-local plugin authority', async () => {
  const fixture = await createProtocolFixture({ permissionProfile: 'trusted-local' });
  const result = await runCodexDriver(fixture.request, { allowTestConfinement: true });
  assert.equal(result.evidenceClass, 'unavailable');
  assert.match(result.errorMessage, /default-deny|wildcard/i);
});

test('subagent cases require and accept bounded non-wildcard profiles', async () => {
  const defaultProfile = await createProtocolFixture({ targetCapabilities: ['subagents'] });
  const rejected = await runCodexDriver(defaultProfile.request, { allowTestConfinement: true });
  assert.equal(rejected.evidenceClass, 'unavailable');
  assert.match(rejected.errorMessage, /bounded-agentic or adaptive-agentic profile/i);

  const bounded = await createProtocolFixture({ targetCapabilities: ['subagents'], permissionProfile: 'bounded-agentic' });
  const accepted = await runCodexDriver(bounded.request, { allowTestConfinement: true });
  assert.equal(accepted.evidenceClass, 'live', accepted.errorMessage);

  const adaptive = await createProtocolFixture({ targetCapabilities: ['subagents'], permissionProfile: 'adaptive-agentic' });
  const adaptiveAccepted = await runCodexDriver(adaptive.request, { allowTestConfinement: true });
  assert.equal(adaptiveAccepted.evidenceClass, 'live', adaptiveAccepted.errorMessage);
});

test('live invocation rejects secret-bearing environment passthrough', async () => {
  const fixture = await createProtocolFixture();
  fixture.request.driver.environmentAllowlist.push('OPENAI_API_KEY');
  const result = await runCodexDriver(fixture.request, { allowTestConfinement: true });
  assert.equal(result.evidenceClass, 'unavailable');
  assert.match(result.errorMessage, /secret-bearing variables|OPENAI_API_KEY/i);
});

test('checked-in protocol confinement launcher cannot authorize production live evidence', async () => {
  const fixture = await createProtocolFixture();
  const result = await runCodexDriver(fixture.request);
  assert.equal(result.evidenceClass, 'unavailable');
  assert.match(result.errorMessage, /test\/fixture launchers/i);
});

test('checked-in offline workspaces cover every frozen phase', async () => {
  const manifestPath = resolve('docs/evals/fixtures/offline-v1/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const caseFiles = ['routing', 'memory', 'execution', 'ui', 'control']
    .map((family) => resolve(`docs/evals/v1/cases/${family}.json`));
  const cases = (await Promise.all(caseFiles.map(async (path) => JSON.parse(await readFile(path, 'utf8')))))
    .flatMap((set) => set.cases);
  for (const item of cases) {
    for (const phase of item.phases) {
      const workspace = manifest.workspaces[phase.workspace];
      assert(workspace, `${item.id} has no offline workspace for ${phase.workspace}`);
      assert.equal(await digestFixtureTree(resolve(dirname(manifestPath), workspace.sourcePath)), workspace.sha256);
      if (phase.fixture) {
        const fixture = manifest.fixtures[phase.fixture];
        assert(fixture, `${item.id} has no fixture entry for ${phase.fixture}`);
        assert.equal(fixture.workspace, phase.workspace);
      }
    }
  }
});

async function createProtocolFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'marshal-codex-driver-'));
  const source = join(root, 'workspace-source');
  const marshalPlugin = join(root, 'plugins', 'marshal-runtime');
  const inputs = join(root, 'inputs');
  const output = join(root, 'attempt');
  await mkdir(join(source, '.git'), { recursive: true });
  await mkdir(inputs, { recursive: true });
  await mkdir(output, { recursive: true });
  await writeFile(join(source, 'fixture.txt'), 'pinned fixture contents', 'utf8');
  await mkdir(marshalPlugin, { recursive: true });
  await writeFile(join(marshalPlugin, 'plugin.json'), '{"name":"marshal-runtime@test"}', 'utf8');
  const trusted = options.permissionProfile === 'trusted-local';
  const boundedAgentic = options.permissionProfile === 'bounded-agentic';
  const adaptiveAgentic = options.permissionProfile === 'adaptive-agentic';
  await writeJson(join(marshalPlugin, '.mcp.json'), {
    mcpServers: {
      marshal: {
        command: 'fake',
        env: trusted ? {
          MARSHAL_RUNTIME_PERMISSION_PROFILE: 'trusted-local',
          MARSHAL_RUNTIME_ALLOWED_PACKAGES: '*',
          MARSHAL_RUNTIME_ALLOWED_BUILTINS: '*',
        } : boundedAgentic
          ? { MARSHAL_RUNTIME_PERMISSION_PROFILE: 'bounded-agentic' }
          : adaptiveAgentic
            ? { MARSHAL_RUNTIME_PERMISSION_PROFILE: 'adaptive-agentic' }
            : {},
      },
    },
  });
  process.env.FAKE_CODEX_PLUGIN_PATH = marshalPlugin;

  const fixtureDigest = await digestFixtureTree(source);
  const fixtureManifest = {
    schemaVersion: '1.0.0',
    workspaces: {
      'fixture://project': { sourcePath: '../workspace-source', sha256: fixtureDigest },
    },
    fixtures: {
      'fixture-data': {
        workspace: 'fixture://project',
        path: 'fixture.txt',
        sha256: sha256('pinned fixture contents'),
      },
    },
  };
  const toolManifest = {
    schemaVersion: '1.0.0',
    codexCommandDriver: {
      commonEnabledPlugins: [],
      marshalPlugin: {
        id: 'marshal-runtime@test',
        version: '0.1.0-test',
        sha256: await digestFixtureTree(marshalPlugin),
        securityProfile: trusted
          ? { permissionProfile: 'trusted-local', allowedPackages: ['*'], allowedBuiltins: ['*'] }
          : {
              permissionProfile: boundedAgentic
                ? 'bounded-agentic'
                : adaptiveAgentic
                  ? 'adaptive-agentic'
                  : 'default',
              allowedPackages: [],
              allowedBuiltins: [],
            },
      },
      effectiveConfigWithoutMarshalSha256: sha256(canonicalJson({
        approval_policy: 'never',
        apps: { _default: { enabled: false, open_world_enabled: false } },
        features: { apps: false },
        mcp_servers: {},
        model: 'fixture-model',
        model_reasoning_effort: 'fixture-reasoning',
        plugins: {},
        sandbox_mode: 'workspace-write',
        sandbox_workspace_write: { network_access: false },
        web_search: 'disabled',
      })),
    },
  };
  const networkFixture = {
    schemaVersion: '1.0.0',
    mode: 'deny-all-agent-network',
    policy: { appsEnabled: false, externalMcpServers: [], sandboxNetworkAccess: false, webSearch: 'disabled' },
  };
  const files = {
    toolManifest: join(inputs, 'tools.json'),
    fixtureManifest: join(inputs, 'fixtures.json'),
    networkFixture: join(inputs, 'network.json'),
  };
  await writeJson(files.toolManifest, toolManifest);
  await writeJson(files.fixtureManifest, fixtureManifest);
  await writeJson(files.networkFixture, networkFixture);
  const corpusDigest = '1'.repeat(64);
  const configurationDigest = '2'.repeat(64);
  const authorizationBindingDigest = '3'.repeat(64);
  const confinementProfile = join(inputs, 'confinement-profile.json');
  await writeJson(confinementProfile, {
    schemaVersion: '1.0.0',
    profileId: 'protocol-fixture-kernel-policy',
    platforms: ['test-x64'],
    mechanism: 'kernel-process-tree-sandbox',
    testOnly: false,
    enforcementMode: 'kernel',
    denyByDefault: true,
    descendantInheritance: 'mandatory',
    externalDataEgress: 'deny-except-model-transport',
    modelTransportIsolation: 'parent-only',
    filesystemOutsideAttempt: 'read-only',
    coverage: ['codex-process', 'marshal-plugin-children', 'workspace-command-children', 'objective-oracle'],
  });
  const authorizationFile = join(inputs, 'live-authorization.json');
  await writeJson(authorizationFile, {
    schemaVersion: '1.0.0',
    authorizationId: 'test-authorization',
    approvedBy: 'test-operator',
    approvedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    allowModelInvocation: true,
    runId: 'fixture-driver-run',
    corpusDigest,
    authorizationBindingDigest,
    model: 'fixture-model',
    harnessVersion: '0.144.6-test',
    maxAttempts: 100,
    maxAdapterInvocationsPerAttempt: 1,
    pricing: {
      currency: 'USD',
      unitTokens: 1000000,
      inputUsdPerUnit: 1,
      cachedInputUsdPerUnit: 0.2,
      outputUsdPerUnit: 5,
      source: 'test-pricing-snapshot',
    },
  });

  const installed = options.installed ?? true;
  const treatmentId = options.treatmentId ?? 'codex-marshal';
  const request = {
    schemaVersion: '1.0.0',
    runId: 'fixture-driver-run',
    corpusDigest,
    configurationDigest,
    authorizationBindingDigest,
    attempt: {
      attemptKey: `driver-case/${treatmentId}/r1`,
      treatmentId,
      orderIndex: 1,
    },
    case: {
      id: 'driver-case',
      targetCapabilities: options.targetCapabilities ?? ['typescript'],
      phases: [
        { id: 'first', taskBoundary: 'new-task', workspace: 'fixture://project', fixture: 'fixture-data', prompt: 'phase one' },
        { id: 'second', taskBoundary: 'same-task', workspace: 'fixture://project', prompt: 'phase two' },
      ],
      budgets: { timeoutMs: 30_000, maxTurns: 2 },
      scoring: {
        assertions: [
          { id: 'protocol-observation', kind: 'trace', weight: 1 },
        ],
      },
    },
    treatment: {
      id: treatmentId,
      marshal: { installed, promptForced: false, capabilities: {} },
    },
    fixed: {
      harness: 'codex',
      harnessVersion: '0.144.6-test',
      model: 'fixture-model',
      reasoning: 'fixture-reasoning',
      os: 'test-x64',
      maxOutputBytes: 1024 * 1024,
      maxRetries: 0,
    },
    inputs: Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, path]) => [
      name,
      { path: resolve(path), sha256: sha256(await readFile(path)) },
    ]))),
    outputDirectory: resolve(output),
    driver: {
      codexCommand: process.execPath,
      codexArgs: [fakeCodex],
      marshalPluginId: 'marshal-runtime@test',
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      allowModelInvocation: true,
      environmentAllowlist: ['PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'FAKE_CODEX_LOG', 'FAKE_CODEX_PLUGIN_PATH'],
      configOverrides: [
        'apps._default.enabled=false',
        'apps._default.open_world_enabled=false',
        'features.apps=false',
        'sandbox_workspace_write.network_access=false',
        'web_search="disabled"',
      ],
      skipGitRepoCheck: false,
      networkFixtureGuard: {
        command: process.execPath,
        args: [offlineNetworkGuard],
        file: offlineNetworkGuard,
        sha256: sha256(await readFile(offlineNetworkGuard)),
      },
      liveAuthorization: {
        file: authorizationFile,
        sha256: sha256(await readFile(authorizationFile)),
      },
      processConfinement: {
        launcherCommand: process.execPath,
        launcherArgs: [confinementLauncher],
        launcherFile: confinementLauncher,
        launcherSha256: sha256(await readFile(confinementLauncher)),
        profileFile: confinementProfile,
        profileSha256: sha256(await readFile(confinementProfile)),
      },
      objectiveOracle: {
        command: process.execPath,
        args: [objectiveOracle],
        file: objectiveOracle,
        sha256: sha256(await readFile(objectiveOracle)),
      },
    },
  };
  return { root, request, logPath: join(root, 'codex-calls.jsonl') };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  return value;
}
