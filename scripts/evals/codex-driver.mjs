#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  stat,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  REQUIRED_CONFINEMENT_COVERAGE,
  validateConfinementAttestation,
  validateConfinementProfile,
} from './security/confinement-contract.mjs';

const DRIVER_SCHEMA_VERSION = '1.0.0';
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_ARTIFACT_BYTES = 5 * 1024 * 1024;

export async function runCodexDriver(request, options = {}) {
  const started = Date.now();
  const preflight = await preflightCodexDriver(request, options);
  if (options.preflightOnly) return preflight;
  if (!preflight.supported) return unavailableResult(preflight, Date.now() - started);
  if (request.driver.allowModelInvocation !== true) {
    return unavailableResult({
      ...preflight,
      supported: false,
      blockers: ['Model invocation is disabled by driver.allowModelInvocation=false. This smoke configuration performs reproducibility preflight only.'],
    }, Date.now() - started);
  }

  const availability = preflight.availability;
  const releaseAttestations = preflight.releaseAttestations;
  const trace = [{
    event: 'codex-driver-preflight',
    protocol: DRIVER_SCHEMA_VERSION,
    availability,
    resolved: preflight.resolved,
  }];
  let liveTurnObserved = false;
  try {
    const workspaces = await materializeWorkspaces(request, preflight.fixtureManifest);
    const deadline = started + request.case.budgets.timeoutMs;
    const phaseOutputs = [];
    const observedTools = [];
    const permissions = [];
    const receipts = [];
    const generatedFiles = [];
    const phaseTimings = [];
    const tokens = { input: 0, output: 0, cached: 0 };
    let traceBytesRemaining = Math.max(1024, Math.floor(request.fixed.maxOutputBytes * 0.6));
    let toolCalls = 0;
    let currentThreadId;
    let usefulAt;

    for (const phase of request.case.phases) {
      const workspace = workspaces.get(phase.workspace);
      if (!workspace) throw new DriverError('fixture-workspace-missing', `No materialized workspace for ${phase.workspace}.`);
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new DriverError('codex-turn-timeout', 'The attempt deadline expired before the next phase.', { timeout: true });
      if ((phase.taskBoundary === 'same-task' || phase.taskBoundary === 'restart-host') && !currentThreadId) {
        throw new DriverError('phase-boundary-invalid', `${phase.id} requires a prior thread to resume.`);
      }
      const phaseStarted = Date.now();
      const invocation = await invokeCodexPhase({
        request,
        phase,
        workspace,
        threadId: phase.taskBoundary === 'new-task' ? undefined : currentThreadId,
        timeoutMs: remainingMs,
        maxBytes: traceBytesRemaining,
        options,
      });
      traceBytesRemaining -= invocation.transportBytes;
      liveTurnObserved ||= invocation.turnObserved;
      if (invocation.threadId) currentThreadId = invocation.threadId;
      trace.push(...invocation.events.map((value) => ({
        phaseId: phase.id,
        taskBoundary: phase.taskBoundary,
        observedAtMs: value.observedAtMs,
        event: value.event,
      })));
      if (invocation.stderr) trace.push({
        event: 'codex-driver-stderr',
        phaseId: phase.id,
        text: invocation.stderr,
      });
      phaseOutputs.push({ id: phase.id, output: invocation.finalOutput });
      observedTools.push(...invocation.observedTools);
      permissions.push(...invocation.permissions);
      receipts.push(...invocation.receipts);
      toolCalls += invocation.toolCalls;
      tokens.input += invocation.tokens.input;
      tokens.output += invocation.tokens.output;
      tokens.cached += invocation.tokens.cached;
      if (usefulAt === undefined && invocation.timeToUsefulResultMs !== undefined) {
        usefulAt = phaseStarted - started + invocation.timeToUsefulResultMs;
      }
      generatedFiles.push(...await captureChangedFiles({
        request,
        phase,
        workspace,
        paths: invocation.changedPaths,
      }));
      phaseTimings.push({
        phaseId: phase.id,
        taskBoundary: phase.taskBoundary,
        wallTimeMs: Date.now() - phaseStarted,
        processExitCode: invocation.exitCode,
      });
      if (!invocation.ok) {
        return resultForFailure({
          request,
          invocation,
          liveTurnObserved,
          started,
          availability,
          trace,
          phaseOutputs,
          observedTools,
          permissions,
          receipts,
          generatedFiles,
          phaseTimings,
          tokens,
          toolCalls,
          usefulAt,
          releaseAttestations,
          pricing: preflight.pricing,
        });
      }
    }

    const assertionObservations = await runObjectiveOracle({
      request,
      phaseOutputs,
      trace,
      generatedFiles,
      permissions,
      receipts,
      observedTools,
      timings: { phases: phaseTimings },
    });
    const estimatedCostUsd = estimateCost(tokens, preflight.pricing);
    return {
      evidenceClass: liveTurnObserved ? 'live' : 'unavailable',
      status: liveTurnObserved ? 'passed' : 'skipped',
      excluded: !liveTurnObserved,
      ...(!liveTurnObserved ? {
        exclusionReason: 'Codex returned without emitting a turn lifecycle event.',
        errorCategory: 'codex-no-live-turn',
      } : {}),
      finalOutput: phaseOutputs.at(-1)?.output ?? '',
      phaseOutputs,
      trace,
      generatedFiles,
      permissions,
      receipts,
      observedTools: dedupeJson(observedTools),
      uiEvidence: [],
      assertionObservations,
      timings: { phases: phaseTimings },
      availability,
      releaseAttestations,
      wallTimeMs: Date.now() - started,
      ...(usefulAt === undefined ? {} : { timeToUsefulResultMs: usefulAt }),
      toolCalls,
      retries: 0,
      tokens,
      estimatedCostUsd,
    };
  } catch (error) {
    const value = normalizeError(error);
    return {
      evidenceClass: liveTurnObserved ? 'live' : 'unavailable',
      status: value.timeout ? 'timeout' : liveTurnObserved ? 'error' : 'skipped',
      excluded: !liveTurnObserved,
      ...(!liveTurnObserved ? { exclusionReason: value.message } : {}),
      errorCategory: value.category,
      errorMessage: value.message,
      finalOutput: '',
      phaseOutputs: [],
      trace: [...trace, { event: 'codex-driver-error', ...value }],
      generatedFiles: [],
      permissions: [],
      receipts: [],
      observedTools: [],
      uiEvidence: [],
      assertionObservations: {},
      timings: {},
      availability,
      releaseAttestations,
      wallTimeMs: Date.now() - started,
      toolCalls: 0,
      retries: 0,
      tokens: { input: 0, output: 0, cached: 0 },
    };
  }
}

export async function preflightCodexDriver(request, options = {}) {
  const blockers = [];
  const availability = {
    freshTaskCreation: status('unavailable', 'Not probed.'),
    phaseResume: status('unavailable', 'Not probed.'),
    pluginIsolation: status('unavailable', 'Not probed.'),
    workspaceFixtures: status('unavailable', 'Not probed.'),
    networkFixtures: status('unavailable', 'Not probed.'),
    modelInvocation: status('unavailable', 'Disabled unless driver.allowModelInvocation is explicitly true.'),
    trace: status('available', 'Codex exec JSONL events are retained verbatim.'),
    finalOutput: status('available', 'Completed agent-message events are retained per phase.'),
    generatedFiles: status('available', 'Files named by Codex file-change events are copied with bounded size.'),
    permissions: status('partial', 'Only approval and permission events exposed by Codex JSONL are available.'),
    receipts: status('partial', 'Only receipt objects present in exposed MCP results are available.'),
    timings: status('available', 'Driver and per-phase wall-clock timings are measured locally.'),
    tokens: status('available', 'Input, output, and cached token counts come from turn.completed usage.'),
    cost: status('unavailable', 'Codex exec JSONL does not expose monetary cost.'),
    uiEvidence: status('unavailable', 'codex exec has no MCP Apps renderer or screenshot/video capture surface.'),
    objectiveAssertions: status('unavailable', 'The driver does not invent deterministic case-oracle results.'),
    liveAuthorization: status('unavailable', 'Not probed.'),
    processConfinement: status('unavailable', 'Not probed.'),
    confinementLease: status('unavailable', 'No release-eligible long-lived confinement lease provider is configured.'),
  };
  const resolved = {};
  const releaseAttestations = {};
  let fixtureManifest;
  let pricing;

  try {
    validateRequest(request);
    const driver = request.driver;
    resolved.confinementLeaseProviderConfigured = driver.processConfinementLease !== undefined;
    availability.confinementLease = driver.processConfinementLease === undefined
      ? status('unavailable', 'No release-eligible long-lived confinement lease provider is configured.')
      : status('unavailable', 'A lease descriptor is present, but this command driver does not route model, desktop, and oracle work through a validated lease provider.');
    resolved.modelInvocationEnabled = driver.allowModelInvocation === true;
    availability.modelInvocation = driver.allowModelInvocation === true
      ? status('available', 'Explicitly enabled in the run configuration.')
      : status('unavailable', 'Preflight-only safety latch is active; no model turn will run.');
    const version = await runBoundedCommand(
      driver.codexCommand,
      [...driver.codexArgs, '--version'],
      { timeoutMs: driver.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS, maxBytes: 64 * 1024 },
    );
    if (!version.ok) throw new DriverError('codex-version-probe', version.message);
    const reportedVersion = version.stdout.trim();
    if (!reportedVersion.includes(request.fixed.harnessVersion)) {
      blockers.push(`Codex version mismatch: expected ${request.fixed.harnessVersion}, observed ${reportedVersion || '(empty)'}.`);
    }
    resolved.codexVersion = reportedVersion;
    availability.freshTaskCreation = status('available', 'codex exec creates a fresh persisted thread and emits thread.started.');
    availability.phaseResume = status('available', 'codex exec resume targets the exact emitted thread id in a new process.');

    const pluginEnabled = request.treatment.marshal.installed === true;
    const configProbe = await probeEffectiveConfig(request, pluginEnabled, options);
    resolved.effectivePluginEnabled = configProbe.plugins?.[driver.marshalPluginId]?.enabled === true;
    resolved.effectiveModel = configProbe.model;
    resolved.effectiveReasoning = configProbe.model_reasoning_effort;
    const expectedPluginState = pluginEnabled;
    if (resolved.effectivePluginEnabled !== expectedPluginState) {
      blockers.push(`Plugin override failed for ${driver.marshalPluginId}: expected enabled=${expectedPluginState}, observed ${String(resolved.effectivePluginEnabled)}.`);
    }
    if (configProbe.model !== request.fixed.model) blockers.push(`Effective model mismatch: expected ${request.fixed.model}, observed ${String(configProbe.model)}.`);
    if (configProbe.model_reasoning_effort !== request.fixed.reasoning) blockers.push(`Effective reasoning mismatch: expected ${request.fixed.reasoning}, observed ${String(configProbe.model_reasoning_effort)}.`);
    if (configProbe.sandbox_mode !== driver.sandbox) blockers.push(`Effective sandbox mismatch: expected ${driver.sandbox}, observed ${String(configProbe.sandbox_mode)}.`);
    if (configProbe.approval_policy !== driver.approvalPolicy) blockers.push(`Effective approval policy mismatch: expected ${driver.approvalPolicy}, observed ${String(configProbe.approval_policy)}.`);

    const toolManifest = JSON.parse(await readFile(request.inputs.toolManifest.path, 'utf8'));
    const pluginInventory = await probePluginInventory(request);
    const securityProfile = await verifyToolManifest(toolManifest, configProbe, pluginInventory, request, blockers);
    resolved.marshalSecurityProfile = securityProfile;
    availability.pluginIsolation = blockers.some((value) => value.includes('Plugin') || value.includes('plugin'))
      ? status('unavailable', 'Effective plugin configuration did not match the pinned tool manifest.')
      : status('available', `Only ${driver.marshalPluginId} changes between arms; the effective enabled-plugin set is pinned.`);

    fixtureManifest = JSON.parse(await readFile(request.inputs.fixtureManifest.path, 'utf8'));
    await verifyFixtureManifest(request, fixtureManifest);
    availability.workspaceFixtures = status('available', 'Each fixture workspace is digest-checked and copied into the attempt directory.');

    const networkFixture = JSON.parse(await readFile(request.inputs.networkFixture.path, 'utf8'));
    const networkAttestation = await verifyNetworkFixture(request, networkFixture, configProbe, toolManifest);
    resolved.networkAttestation = networkAttestation;
    releaseAttestations.networkEnforcementDigest = networkAttestation.enforcementSha256;
    availability.networkFixtures = status('available', 'The pinned deny-all guard verified the exact fixture and effective Codex config used by every phase.');

    if (driver.allowModelInvocation === true) {
      const authorization = await verifyLiveAuthorization(request);
      pricing = authorization.pricing;
      releaseAttestations.liveAuthorizationDigest = driver.liveAuthorization.sha256;
      availability.liveAuthorization = status('available', `Pinned operator authorization ${authorization.authorizationId} permits this exact run, model, corpus, and configuration.`);
      availability.cost = status('available', `Token-derived USD estimate uses the pinned ${authorization.pricing.source} pricing snapshot.`);

      const confinement = await verifyProcessConfinement(request, options);
      resolved.processConfinement = confinement;
      releaseAttestations.processConfinementProfileDigest = confinement.profileSha256;
      releaseAttestations.processConfinementMeasurementDigest = confinement.measurement;
      availability.processConfinement = status('available', `${confinement.mechanism} attests descendant confinement for Codex, Marshal/plugin children, and workspace commands.`);

      const oracleDigest = await verifyObjectiveOracle(request, options);
      releaseAttestations.objectiveOracleDigest = oracleDigest;
      availability.objectiveAssertions = status('available', 'A hash-pinned deterministic oracle must produce every non-human assertion observation.');

      if (!['default', 'bounded-agentic', 'adaptive-agentic'].includes(securityProfile.permissionProfile)
        || securityProfile.allowedPackages.includes('*')
        || securityProfile.allowedBuiltins.includes('*')) {
        blockers.push('Live release evaluation requires Marshal\'s brokered default, bounded-agentic, or adaptive-agentic profile with no wildcard package or builtin authority.');
      }
      if (request.case.targetCapabilities.includes('subagents')
        && !['bounded-agentic', 'adaptive-agentic'].includes(securityProfile.permissionProfile)) {
        blockers.push('Subagent evaluation requires the bounded-agentic or adaptive-agentic profile; default lacks delegation grants and trusted-local is overbroad.');
      }
    } else {
      availability.liveAuthorization = status('unavailable', 'Not required for model-disabled preflight; a live run needs a hash-pinned operator authorization.');
      availability.processConfinement = status('unavailable', 'Not required for model-disabled preflight; a live run needs a hash-pinned descendant-confining launcher.');
    }
  } catch (error) {
    const value = normalizeError(error);
    blockers.push(`${value.category}: ${value.message}`);
  }

  if (request?.case?.targetCapabilities?.includes('ui')) {
    blockers.push('This case requires interactive UI evidence, but codex exec has no MCP Apps render host or screenshot/video automation API. Use a separately validated desktop-host driver.');
  }
  return {
    schemaVersion: DRIVER_SCHEMA_VERSION,
    supported: blockers.length === 0,
    blockers: [...new Set(blockers)],
    availability,
    resolved,
    releaseAttestations,
    fixtureManifest,
    pricing,
  };
}

export async function digestFixtureTree(root) {
  const absolute = resolve(root);
  const entries = [];
  await walk(absolute, '');
  return sha256(JSON.stringify(entries));

  async function walk(directory, prefix) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const rel = prefix ? `${prefix}/${child.name}` : child.name;
      const path = join(directory, child.name);
      if (child.isSymbolicLink()) throw new DriverError('fixture-symlink', `Fixture tree contains a symbolic link: ${rel}`);
      if (child.isDirectory()) {
        entries.push({ path: `${rel}/`, type: 'directory' });
        await walk(path, rel);
      } else if (child.isFile()) {
        const bytes = await readFile(path);
        entries.push({ path: rel, type: 'file', bytes: bytes.length, sha256: sha256(bytes) });
      } else {
        throw new DriverError('fixture-special-file', `Fixture tree contains an unsupported special file: ${rel}`);
      }
    }
  }
}

export function digestEffectiveCodexConfig(config, marshalPluginId) {
  const normalized = structuredClone(config);
  if (normalized.plugins) delete normalized.plugins[marshalPluginId];
  return sha256(canonicalJson(normalized));
}

async function probeEffectiveConfig(request, enabled, options) {
  const driver = request.driver;
  const override = pluginOverride(driver.marshalPluginId, enabled, driver.pluginStateOverrides);
  const args = [
    ...driver.codexArgs,
    'app-server',
    '--stdio',
    '--strict-config',
    ...configArguments(request, override),
  ];
  const child = (options.spawn ?? spawn)(driver.codexCommand, args, {
    cwd: request.outputDirectory,
    env: driverEnvironment(request),
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const timeoutMs = driver.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const lines = lineCollector(child.stdout, driver.maxProbeBytes ?? 2 * 1024 * 1024);
  const stderr = [];
  let stderrBytes = 0;
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= 128 * 1024) stderr.push(chunk);
  });
  const responsePromise = waitForJsonResponse(lines, 2, timeoutMs);
  child.stdin.write(`${JSON.stringify({
    method: 'initialize',
    id: 1,
    params: { clientInfo: { name: 'marshal_eval_driver', title: 'Marshal Eval Driver', version: DRIVER_SCHEMA_VERSION } },
  })}\n`);
  child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ method: 'config/read', id: 2, params: { cwd: request.outputDirectory, includeLayers: false } })}\n`);
  try {
    const response = await responsePromise;
    if (response.error) throw new DriverError('codex-config-probe', response.error.message ?? JSON.stringify(response.error));
    return response.result?.config ?? response.result;
  } catch (error) {
    const stderrText = Buffer.concat(stderr).toString('utf8');
    throw new DriverError('codex-config-probe', `${error.message}${stderrText ? `; stderr: ${stderrText}` : ''}`);
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

async function verifyFixtureManifest(request, manifest) {
  if (manifest?.schemaVersion !== '1.0.0' || !manifest.workspaces || typeof manifest.workspaces !== 'object') {
    throw new DriverError('fixture-manifest-schema', 'Fixture manifest must have schemaVersion 1.0.0 and a workspaces object.');
  }
  const root = dirname(request.inputs.fixtureManifest.path);
  for (const phase of request.case.phases) {
    const entry = manifest.workspaces[phase.workspace];
    if (!entry?.sourcePath || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) {
      throw new DriverError('fixture-workspace-entry', `Workspace ${phase.workspace} needs sourcePath and a SHA-256 tree digest.`);
    }
    const source = resolve(root, entry.sourcePath);
    const info = await stat(source);
    if (!info.isDirectory()) throw new DriverError('fixture-workspace-entry', `Workspace source is not a directory: ${source}`);
    const actual = await digestFixtureTree(source);
    if (actual !== entry.sha256) throw new DriverError('fixture-workspace-digest', `Workspace digest mismatch for ${phase.workspace}.`);
    if (phase.fixture) {
      const fixture = manifest.fixtures?.[phase.fixture];
      if (!fixture || fixture.workspace !== phase.workspace || typeof fixture.path !== 'string') {
        throw new DriverError('fixture-entry-missing', `Fixture ${phase.fixture} must name ${phase.workspace} and a contained path.`);
      }
      const fixturePath = resolve(source, fixture.path);
      if (!isWithin(source, fixturePath)) throw new DriverError('fixture-path-escape', `Fixture ${phase.fixture} escapes its workspace.`);
      if (fixture.sha256 && sha256(await readFile(fixturePath)) !== fixture.sha256) {
        throw new DriverError('fixture-file-digest', `Fixture digest mismatch for ${phase.fixture}.`);
      }
    }
  }
}

async function verifyNetworkFixture(request, fixture, effectiveConfig, toolManifest) {
  const guard = request.driver.networkFixtureGuard;
  if (!guard?.command || !isAbsolute(guard.command) || !Array.isArray(guard.args)
    || !isAbsolute(guard.file ?? '') || !/^[a-f0-9]{64}$/.test(guard.sha256 ?? '')) {
    throw new DriverError(
      'network-fixture-guard-unavailable',
      'driver.networkFixtureGuard must pin an absolute command, args, guard file, and SHA-256 digest.',
    );
  }
  const actualGuardDigest = sha256(await readFile(guard.file));
  if (actualGuardDigest !== guard.sha256) {
    throw new DriverError('network-fixture-guard-digest', `Network guard digest mismatch for ${guard.file}.`);
  }
  const commonEnabledPlugins = toolManifest.codexCommandDriver.commonEnabledPlugins.map((value) => value.id).sort();
  const result = await runBoundedCommand(guard.command, guard.args, {
    timeoutMs: guard.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    maxBytes: 128 * 1024,
    stdin: JSON.stringify({
      schemaVersion: DRIVER_SCHEMA_VERSION,
      fixturePath: request.inputs.networkFixture.path,
      fixtureSha256: request.inputs.networkFixture.sha256,
      fixture,
      enforcement: {
        sandbox: request.driver.sandbox,
        approvalPolicy: request.driver.approvalPolicy,
        configOverrides: request.driver.configOverrides ?? [],
        commonEnabledPlugins,
        effectiveConfig,
      },
    }),
  });
  if (!result.ok) throw new DriverError('network-fixture-guard', result.message);
  let attestation;
  try { attestation = JSON.parse(result.stdout); } catch (error) {
    throw new DriverError('network-fixture-guard', `Guard returned invalid JSON: ${error.message}`);
  }
  if (attestation.ok !== true || attestation.fixtureSha256 !== request.inputs.networkFixture.sha256
    || !/^[a-f0-9]{64}$/.test(attestation.enforcementSha256 ?? '')) {
    throw new DriverError('network-fixture-guard', 'Guard did not attest the exact pinned fixture and enforcement config.');
  }
  return attestation;
}

async function verifyLiveAuthorization(request) {
  const descriptor = request.driver.liveAuthorization;
  if (!descriptor || !isAbsolute(descriptor.file ?? '') || !/^[a-f0-9]{64}$/.test(descriptor.sha256 ?? '')) {
    throw new DriverError('live-authorization-unavailable', 'Live model invocation requires driver.liveAuthorization with an absolute hash-pinned file.');
  }
  const bytes = await readFile(descriptor.file);
  if (sha256(bytes) !== descriptor.sha256) {
    throw new DriverError('live-authorization-digest', `Live authorization digest mismatch for ${descriptor.file}.`);
  }
  let authorization;
  try { authorization = JSON.parse(bytes.toString('utf8')); } catch (error) {
    throw new DriverError('live-authorization-schema', `Live authorization is not JSON: ${error.message}`);
  }
  const validPricing = authorization.pricing?.currency === 'USD'
    && authorization.pricing?.unitTokens === 1_000_000
    && ['inputUsdPerUnit', 'cachedInputUsdPerUnit', 'outputUsdPerUnit'].every((key) =>
      typeof authorization.pricing[key] === 'number' && authorization.pricing[key] >= 0)
    && typeof authorization.pricing.source === 'string'
    && authorization.pricing.source.length > 0;
  if (authorization.schemaVersion !== '1.0.0'
    || authorization.allowModelInvocation !== true
    || typeof authorization.authorizationId !== 'string'
    || typeof authorization.approvedBy !== 'string'
    || authorization.runId !== request.runId
    || authorization.corpusDigest !== request.corpusDigest
    || authorization.authorizationBindingDigest !== request.authorizationBindingDigest
    || authorization.model !== request.fixed.model
    || authorization.harnessVersion !== request.fixed.harnessVersion
    || !Number.isInteger(authorization.maxAttempts)
    || authorization.maxAttempts < request.attempt.orderIndex
    || authorization.maxAdapterInvocationsPerAttempt !== request.fixed.maxRetries + 1
    || !validPricing) {
    throw new DriverError('live-authorization-schema', 'Live authorization must bind this run, corpus, authorization-safe configuration digest, model, harness, attempt budget, approver, and USD pricing snapshot.');
  }
  const approvedAt = Date.parse(authorization.approvedAt);
  const expiresAt = Date.parse(authorization.expiresAt);
  const now = Date.now();
  if (!Number.isFinite(approvedAt) || approvedAt > now || !Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new DriverError('live-authorization-expired', 'Live authorization timestamps are invalid, not yet active, or expired.');
  }
  return authorization;
}

async function verifyProcessConfinement(request, options = {}) {
  const descriptor = request.driver.processConfinement;
  if (!descriptor?.launcherCommand || !isAbsolute(descriptor.launcherCommand)
    || !Array.isArray(descriptor.launcherArgs)
    || !isAbsolute(descriptor.launcherFile ?? '')
    || !/^[a-f0-9]{64}$/.test(descriptor.launcherSha256 ?? '')
    || !isAbsolute(descriptor.profileFile ?? '')
    || !/^[a-f0-9]{64}$/.test(descriptor.profileSha256 ?? '')) {
    throw new DriverError('process-confinement-unavailable', 'Live evaluation requires a hash-pinned descendant-confining launcher and profile.');
  }
  if (options.allowTestConfinement !== true
    && /(?:[\\/]__tests__[\\/]|fake|fixture)/i.test(descriptor.launcherFile)) {
    throw new DriverError('process-confinement-test-launcher', 'Checked-in test/fixture launchers cannot authorize a live evaluation.');
  }
  if (sha256(await readFile(descriptor.launcherFile)) !== descriptor.launcherSha256) {
    throw new DriverError('process-confinement-launcher-digest', `Confinement launcher digest mismatch for ${descriptor.launcherFile}.`);
  }
  if (sha256(await readFile(descriptor.profileFile)) !== descriptor.profileSha256) {
    throw new DriverError('process-confinement-profile-digest', `Confinement profile digest mismatch for ${descriptor.profileFile}.`);
  }
  const profile = JSON.parse(await readFile(descriptor.profileFile, 'utf8'));
  let validatedProfile;
  try {
    validatedProfile = validateConfinementProfile(profile, request.fixed.os);
  } catch (error) {
    throw new DriverError('process-confinement-profile', error.message);
  }
  const challenge = randomBytes(32).toString('hex');
  const result = await runBoundedCommand(
    descriptor.launcherCommand,
    [...descriptor.launcherArgs, '--attest', descriptor.profileFile],
    {
      timeoutMs: descriptor.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      maxBytes: 128 * 1024,
      stdin: JSON.stringify({
        schemaVersion: DRIVER_SCHEMA_VERSION,
        challenge,
        profileSha256: descriptor.profileSha256,
        profileSemanticsSha256: validatedProfile.semanticsSha256,
        requiredCoverage: REQUIRED_CONFINEMENT_COVERAGE,
      }),
    },
  );
  if (!result.ok) throw new DriverError('process-confinement-attestation', result.message);
  let attestation;
  try { attestation = JSON.parse(result.stdout); } catch (error) {
    throw new DriverError('process-confinement-attestation', `Confinement launcher returned invalid JSON: ${error.message}`);
  }
  try {
    return validateConfinementAttestation(attestation, {
      challenge,
      profileSha256: descriptor.profileSha256,
      profileSemanticsSha256: validatedProfile.semanticsSha256,
      mechanism: validatedProfile.profile.mechanism,
    });
  } catch (error) {
    throw new DriverError('process-confinement-attestation', error.message);
  }
}

async function verifyObjectiveOracle(request, options = {}) {
  const descriptor = request.driver.objectiveOracle;
  if (!descriptor?.command || !isAbsolute(descriptor.command)
    || !Array.isArray(descriptor.args)
    || !isAbsolute(descriptor.file ?? '')
    || !/^[a-f0-9]{64}$/.test(descriptor.sha256 ?? '')) {
    throw new DriverError('objective-oracle-unavailable', 'Live evaluation requires a hash-pinned deterministic objective oracle.');
  }
  if (options.allowTestConfinement !== true
    && /(?:[\\/]__tests__[\\/]|fake|fixture)/i.test(descriptor.file)) {
    throw new DriverError('objective-oracle-test-fixture', 'Checked-in fake/test objective oracles cannot authorize a live evaluation.');
  }
  if (sha256(await readFile(descriptor.file)) !== descriptor.sha256) {
    throw new DriverError('objective-oracle-digest', `Objective oracle digest mismatch for ${descriptor.file}.`);
  }
  const confined = confinedChildInvocation(request.driver, descriptor.command, [...descriptor.args, '--preflight']);
  const result = await runBoundedCommand(confined.command, confined.args, {
    timeoutMs: descriptor.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    maxBytes: 256 * 1024,
    env: driverEnvironment(request),
    stdin: JSON.stringify({ schemaVersion: DRIVER_SCHEMA_VERSION, case: request.case }),
  });
  if (!result.ok) throw new DriverError('objective-oracle-preflight', result.message);
  let response;
  try { response = JSON.parse(result.stdout); } catch (error) {
    throw new DriverError('objective-oracle-preflight', `Objective oracle preflight returned invalid JSON: ${error.message}`);
  }
  const expectedIds = request.case.scoring.assertions
    .filter((assertion) => assertion.kind !== 'human-rubric')
    .map((assertion) => assertion.id)
    .sort();
  if (response?.schemaVersion !== '1.0.0'
    || response.ok !== true
    || response.caseId !== request.case.id
    || canonicalJson(response.assertionIds) !== canonicalJson(expectedIds)) {
    throw new DriverError('objective-oracle-preflight', 'Objective oracle does not exactly cover the selected case assertions.');
  }
  return descriptor.sha256;
}

async function runObjectiveOracle(values) {
  const descriptor = values.request.driver.objectiveOracle;
  const objectiveIds = values.request.case.scoring.assertions
    .filter((assertion) => assertion.kind !== 'human-rubric')
    .map((assertion) => assertion.id);
  if (objectiveIds.length === 0) return {};
  const confined = confinedChildInvocation(values.request.driver, descriptor.command, descriptor.args);
  const result = await runBoundedCommand(confined.command, confined.args, {
    timeoutMs: descriptor.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    maxBytes: descriptor.maxBytes ?? 2 * 1024 * 1024,
    env: driverEnvironment(values.request),
    stdin: JSON.stringify({
      schemaVersion: DRIVER_SCHEMA_VERSION,
      runId: values.request.runId,
      attempt: values.request.attempt,
      case: values.request.case,
      outputDirectory: values.request.outputDirectory,
      finalOutput: values.phaseOutputs.at(-1)?.output ?? '',
      phaseOutputs: values.phaseOutputs,
      trace: values.trace,
      generatedFiles: values.generatedFiles,
      permissions: values.permissions,
      receipts: values.receipts,
      observedTools: values.observedTools,
      timings: values.timings,
      hostFacts: values.hostFacts ?? {},
    }),
  });
  if (!result.ok) throw new DriverError('objective-oracle', result.message);
  let response;
  try { response = JSON.parse(result.stdout); } catch (error) {
    throw new DriverError('objective-oracle', `Objective oracle returned invalid JSON: ${error.message}`);
  }
  const observations = response?.assertionObservations;
  if (response?.schemaVersion !== '1.0.0' || !observations || typeof observations !== 'object') {
    throw new DriverError('objective-oracle', 'Objective oracle response must contain assertionObservations.');
  }
  const observedIds = Object.keys(observations).sort();
  if (canonicalJson(observedIds) !== canonicalJson([...objectiveIds].sort())) {
    throw new DriverError('objective-oracle', `Objective oracle must return exactly these assertion ids: ${objectiveIds.join(', ')}.`);
  }
  for (const [id, observation] of Object.entries(observations)) {
    if (!observation || typeof observation !== 'object' || typeof observation.type !== 'string') {
      throw new DriverError('objective-oracle', `Objective oracle returned an invalid observation for ${id}.`);
    }
  }
  return observations;
}

function estimateCost(tokens, pricing) {
  if (!pricing) return undefined;
  const uncachedInput = Math.max(0, tokens.input - tokens.cached);
  return (
    uncachedInput * pricing.inputUsdPerUnit
    + tokens.cached * pricing.cachedInputUsdPerUnit
    + tokens.output * pricing.outputUsdPerUnit
  ) / pricing.unitTokens;
}

async function probePluginInventory(request) {
  const result = await runBoundedCommand(
    request.driver.codexCommand,
    [...request.driver.codexArgs, 'plugin', 'list', '--json'],
    { timeoutMs: request.driver.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS, maxBytes: 2 * 1024 * 1024 },
  );
  if (!result.ok) throw new DriverError('codex-plugin-inventory', result.message);
  try { return JSON.parse(result.stdout); } catch (error) {
    throw new DriverError('codex-plugin-inventory', `Plugin inventory was not JSON: ${error.message}`);
  }
}

async function verifyToolManifest(manifest, config, inventory, request, blockers) {
  const expected = manifest?.codexCommandDriver;
  if (manifest?.schemaVersion !== '1.0.0'
    || !expected
    || !Array.isArray(expected.commonEnabledPlugins)
    || !expected.marshalPlugin
    || !expected.marshalPlugin.securityProfile
    || !/^[a-f0-9]{64}$/.test(expected.effectiveConfigWithoutMarshalSha256 ?? '')) {
    throw new DriverError(
      'tool-manifest-schema',
      'Tool manifest must pin commonEnabledPlugins, the Marshal plugin tree and security profile, and effectiveConfigWithoutMarshalSha256.',
    );
  }
  if (expected.marshalPlugin.id !== request.driver.marshalPluginId) {
    blockers.push(`Tool manifest Marshal plugin id ${String(expected.marshalPlugin.id)} does not match driver ${request.driver.marshalPluginId}.`);
  }
  const enabled = Object.entries(config.plugins ?? {})
    .filter(([, value]) => value?.enabled === true)
    .map(([id]) => id)
    .sort();
  const expectedEnabled = expected.commonEnabledPlugins.map((value) => value.id);
  if (request.treatment.marshal.installed) expectedEnabled.push(request.driver.marshalPluginId);
  expectedEnabled.sort();
  if (JSON.stringify(enabled) !== JSON.stringify(expectedEnabled)) {
    blockers.push(`Effective enabled plugins do not match the pinned tool manifest. Expected ${expectedEnabled.join(', ') || '(none)'}; observed ${enabled.join(', ') || '(none)'}.`);
  }
  const installed = new Map((inventory.installed ?? []).map((value) => [value.pluginId, value]));
  for (const plugin of [...expected.commonEnabledPlugins, expected.marshalPlugin]) {
    const actual = installed.get(plugin.id);
    if (!actual?.installed) {
      blockers.push(`Pinned plugin ${plugin.id} is not installed.`);
      continue;
    }
    if (actual.version !== plugin.version) blockers.push(`Plugin ${plugin.id} version mismatch: expected ${plugin.version}, observed ${String(actual.version)}.`);
  }
  const marshal = installed.get(expected.marshalPlugin.id);
  let actualSecurityProfile;
  if (marshal?.source?.path && expected.marshalPlugin.sha256) {
    const actualDigest = await digestFixtureTree(marshal.source.path);
    if (actualDigest !== expected.marshalPlugin.sha256) blockers.push(`Marshal plugin tree digest mismatch for ${marshal.source.path}.`);
    actualSecurityProfile = await readMarshalSecurityProfile(marshal.source.path);
    if (canonicalJson(actualSecurityProfile) !== canonicalJson(expected.marshalPlugin.securityProfile)) {
      blockers.push(`Marshal plugin security profile mismatch: expected ${canonicalJson(expected.marshalPlugin.securityProfile)}, observed ${canonicalJson(actualSecurityProfile)}.`);
    }
  } else if (expected.marshalPlugin.sha256) {
    blockers.push(`Marshal plugin ${expected.marshalPlugin.id} has no local source path to verify.`);
  }
  const configDigest = digestEffectiveCodexConfig(config, request.driver.marshalPluginId);
  if (configDigest !== expected.effectiveConfigWithoutMarshalSha256) {
    blockers.push(`Effective Codex config digest mismatch: expected ${expected.effectiveConfigWithoutMarshalSha256}, observed ${configDigest}.`);
  }
  return actualSecurityProfile ?? expected.marshalPlugin.securityProfile;
}

export async function readMarshalSecurityProfile(pluginRoot) {
  const mcp = JSON.parse(await readFile(join(pluginRoot, '.mcp.json'), 'utf8'));
  const serverMap = mcp?.mcpServers ?? mcp?.mcp_servers ?? mcp;
  const servers = Object.values(serverMap ?? {});
  if (servers.length !== 1) {
    throw new DriverError('marshal-security-profile', 'Marshal plugin must declare exactly one MCP server for evaluation.');
  }
  const env = servers[0]?.env ?? {};
  const permissionProfile = ['trusted-local', 'bounded-agentic', 'adaptive-agentic'].includes(env.MARSHAL_RUNTIME_PERMISSION_PROFILE)
    ? env.MARSHAL_RUNTIME_PERMISSION_PROFILE
    : 'default';
  return {
    permissionProfile,
    allowedPackages: parseAllowlist(env.MARSHAL_RUNTIME_ALLOWED_PACKAGES),
    allowedBuiltins: parseAllowlist(env.MARSHAL_RUNTIME_ALLOWED_BUILTINS),
  };
}

function parseAllowlist(value) {
  if (typeof value !== 'string') return [];
  return [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))].sort();
}

async function materializeWorkspaces(request, manifest) {
  const root = dirname(request.inputs.fixtureManifest.path);
  const targetRoot = join(request.outputDirectory, 'driver-workspaces');
  await mkdir(targetRoot, { recursive: true });
  const result = new Map();
  for (const workspaceUri of new Set(request.case.phases.map((phase) => phase.workspace))) {
    const source = resolve(root, manifest.workspaces[workspaceUri].sourcePath);
    const target = join(targetRoot, safeSegment(workspaceUri));
    await cp(source, target, { recursive: true, errorOnExist: true, force: false });
    result.set(workspaceUri, target);
  }
  return result;
}

async function invokeCodexPhase({ request, phase, workspace, threadId, timeoutMs, maxBytes, options }) {
  const driver = request.driver;
  const override = pluginOverride(driver.marshalPluginId, request.treatment.marshal.installed === true, driver.pluginStateOverrides);
  const common = [
    '--json',
    '--strict-config',
    '-m', request.fixed.model,
    ...configArguments(request, override),
  ];
  const args = threadId
    ? [...driver.codexArgs, 'exec', 'resume', ...common, ...(driver.skipGitRepoCheck ? ['--skip-git-repo-check'] : []), threadId, '-']
    : [
        ...driver.codexArgs,
        'exec',
        ...common,
        '-C', workspace,
        '--sandbox', driver.sandbox,
        '--ask-for-approval', driver.approvalPolicy,
        ...(driver.skipGitRepoCheck ? ['--skip-git-repo-check'] : []),
        '-',
      ];
  const started = Date.now();
  const confined = confinedChildInvocation(driver, driver.codexCommand, args);
  const child = (options.spawn ?? spawn)(confined.command, confined.args, {
    cwd: workspace,
    env: driverEnvironment(request),
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = await collectJsonlProcess(child, {
    stdin: phase.prompt,
    timeoutMs,
    maxBytes,
  });
  const parsed = parseCodexEvents(output.events, started);
  return {
    ...parsed,
    ok: output.exitCode === 0 && parsed.turnCompleted && !parsed.turnFailed,
    timeout: output.timeout,
    transportBytes: output.bytes,
    exitCode: output.exitCode,
    stderr: output.stderr,
    errorCategory: output.timeout ? 'codex-turn-timeout'
      : output.outputLimit ? 'codex-jsonl-output-limit'
        : parsed.protocolErrors.length ? 'codex-jsonl-protocol'
          : parsed.turnFailed ? 'codex-turn-failed'
            : output.exitCode === 0 ? 'codex-turn-incomplete' : 'codex-exit',
    errorMessage: output.timeout ? `Codex phase exceeded the remaining ${timeoutMs}ms attempt budget.`
        : output.outputLimit ? `Codex phase exceeded the remaining ${maxBytes} byte trace budget.`
        : parsed.protocolErrors[0] ?? parsed.failureMessage ?? output.stderr ?? `Codex exited ${String(output.exitCode)}.`,
  };
}

function confinedChildInvocation(driver, command, args) {
  const confinement = driver.processConfinement;
  if (!confinement) throw new DriverError('process-confinement-unavailable', 'Live Codex phases cannot launch outside the configured confinement wrapper.');
  return {
    command: confinement.launcherCommand,
    args: [
      ...confinement.launcherArgs,
      '--run',
      confinement.profileFile,
      command,
      ...args,
    ],
  };
}

function parseCodexEvents(events, started) {
  let threadId;
  let turnObserved = false;
  let turnCompleted = false;
  let turnFailed = false;
  let failureMessage;
  let finalOutput = '';
  let useful;
  let toolCalls = 0;
  const tokens = { input: 0, output: 0, cached: 0 };
  const observedTools = [];
  const permissions = [];
  const receipts = [];
  const changedPaths = [];
  const protocolErrors = [];
  const wrapped = [];
  for (const entry of events) {
    const event = entry.value;
    wrapped.push({ observedAtMs: entry.observedAtMs, event });
    if (event.type === 'driver.invalid_jsonl' || event.type === 'driver.spawn_error') {
      protocolErrors.push(event.error ?? event.message ?? 'Invalid Codex JSONL event.');
    }
    if (event.type === 'thread.started') threadId = event.thread_id ?? event.threadId ?? event.thread?.id;
    if (event.type === 'turn.started') turnObserved = true;
    if (event.type === 'turn.completed') {
      turnObserved = true;
      turnCompleted = true;
      addUsage(tokens, event.usage);
    }
    if (event.type === 'turn.failed' || event.type === 'error') {
      turnFailed = true;
      failureMessage = event.message ?? event.error?.message ?? JSON.stringify(event.error ?? event);
    }
    const item = event.item;
    if (!item || (event.type !== 'item.completed' && event.type !== 'item.started')) continue;
    const type = String(item.type ?? '');
    if (event.type === 'item.completed' && (type === 'agent_message' || type === 'agentMessage')) {
      finalOutput = item.text ?? item.message ?? finalOutput;
      if (useful === undefined && finalOutput) useful = Math.max(0, entry.observedAtMs - started);
    }
    if (isToolItem(type)) {
      if (event.type === 'item.completed') toolCalls += 1;
      observedTools.push(toolIdentity(item));
    }
    if (/permission|approval/i.test(type)) permissions.push(item);
    if (type === 'file_change' || type === 'fileChange') changedPaths.push(...filePaths(item));
    receipts.push(...findReceipts(item));
  }
  if (!turnCompleted && !turnFailed) protocolErrors.push('Codex JSONL ended without turn.completed or turn.failed.');
  return {
    events: wrapped,
    threadId,
    turnObserved,
    turnCompleted,
    turnFailed,
    failureMessage,
    finalOutput,
    timeToUsefulResultMs: useful,
    toolCalls,
    tokens,
    observedTools: dedupeJson(observedTools),
    permissions,
    receipts: dedupeJson(receipts),
    changedPaths: [...new Set(changedPaths)],
    protocolErrors,
  };
}

async function captureChangedFiles({ request, phase, workspace, paths }) {
  const output = [];
  let total = 0;
  const limit = request.driver.maxArtifactBytes ?? DEFAULT_ARTIFACT_BYTES;
  for (const raw of paths) {
    const source = isAbsolute(raw) ? resolve(raw) : resolve(workspace, raw);
    if (!isWithin(workspace, source)) continue;
    let info;
    try { info = await lstat(source); } catch { continue; }
    if (!info.isFile() || info.isSymbolicLink()) continue;
    total += info.size;
    if (total > limit) throw new DriverError('generated-files-output-limit', `Changed files exceeded ${limit} bytes.`);
    const rel = relative(workspace, source);
    const target = join(request.outputDirectory, 'captured-files', safeSegment(phase.id), rel);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { force: false, errorOnExist: true });
    output.push({
      name: `${phase.id}-${basename(source)}`,
      path: relative(request.outputDirectory, target),
      mediaType: mediaType(source),
      redacted: false,
    });
  }
  return output;
}

function resultForFailure(values) {
  return {
    evidenceClass: values.liveTurnObserved ? 'live' : 'unavailable',
    status: values.invocation.timeout ? 'timeout' : values.liveTurnObserved ? 'error' : 'skipped',
    excluded: !values.liveTurnObserved,
    ...(!values.liveTurnObserved ? { exclusionReason: values.invocation.errorMessage } : {}),
    errorCategory: values.invocation.errorCategory,
    errorMessage: values.invocation.errorMessage,
    finalOutput: values.phaseOutputs.at(-1)?.output ?? '',
    phaseOutputs: values.phaseOutputs,
    trace: values.trace,
    generatedFiles: values.generatedFiles,
    permissions: values.permissions,
    receipts: values.receipts,
    observedTools: dedupeJson(values.observedTools),
    uiEvidence: [],
    assertionObservations: {},
    timings: { phases: values.phaseTimings },
    availability: values.availability,
    releaseAttestations: values.releaseAttestations ?? {},
    wallTimeMs: Date.now() - values.started,
    ...(values.usefulAt === undefined ? {} : { timeToUsefulResultMs: values.usefulAt }),
    toolCalls: values.toolCalls,
    retries: 0,
    tokens: values.tokens,
    ...(estimateCost(values.tokens, values.pricing) === undefined
      ? {}
      : { estimatedCostUsd: estimateCost(values.tokens, values.pricing) }),
  };
}

function unavailableResult(preflight, wallTimeMs = 0) {
  return {
    evidenceClass: 'unavailable',
    status: 'skipped',
    excluded: true,
    exclusionReason: preflight.blockers.join(' '),
    errorCategory: 'codex-driver-preflight-unsupported',
    errorMessage: preflight.blockers.join(' '),
    finalOutput: '',
    phaseOutputs: [],
    trace: [{ event: 'codex-driver-preflight', supported: false, blockers: preflight.blockers }],
    generatedFiles: [],
    permissions: [],
    receipts: [],
    observedTools: [],
    uiEvidence: [],
    assertionObservations: {},
    timings: {},
    availability: preflight.availability,
    releaseAttestations: preflight.releaseAttestations ?? {},
    wallTimeMs,
    toolCalls: 0,
    retries: 0,
    tokens: { input: 0, output: 0, cached: 0 },
  };
}

function validateRequest(request) {
  if (request?.schemaVersion !== '1.0.0') throw new DriverError('driver-request-schema', 'Expected request schemaVersion 1.0.0.');
  if (!/^[a-f0-9]{64}$/.test(request.corpusDigest ?? '')
    || !/^[a-f0-9]{64}$/.test(request.configurationDigest ?? '')
    || !/^[a-f0-9]{64}$/.test(request.authorizationBindingDigest ?? '')) {
    throw new DriverError('driver-request-digests', 'The command request must bind exact corpus, configuration, and authorization-safe configuration digests.');
  }
  if (request.fixed?.harness !== 'codex') throw new DriverError('driver-harness', 'fixed.harness must be codex.');
  if (!Array.isArray(request.case?.phases) || request.case.phases.length === 0) throw new DriverError('driver-phases', 'At least one case phase is required.');
  if (!Array.isArray(request.case?.scoring?.assertions)) throw new DriverError('driver-assertions', 'Case scoring assertions are required.');
  if (!Number.isInteger(request.attempt?.orderIndex) || request.attempt.orderIndex < 1) throw new DriverError('driver-attempt-order', 'attempt.orderIndex is required for authorization budget enforcement.');
  if (request.case.phases.length > request.case.budgets.maxTurns) throw new DriverError('driver-turn-budget', 'Case phases exceed maxTurns.');
  for (const phase of request.case.phases) {
    if (!['new-task', 'same-task', 'restart-host'].includes(phase.taskBoundary)) throw new DriverError('driver-phase-boundary', `Unsupported task boundary: ${String(phase.taskBoundary)}.`);
    if (typeof phase.workspace !== 'string' || !phase.workspace.startsWith('fixture://')) throw new DriverError('driver-phase-workspace', `Phase ${String(phase.id)} must name a fixture:// workspace.`);
    if (typeof phase.prompt !== 'string') throw new DriverError('driver-phase-prompt', `Phase ${String(phase.id)} needs a string prompt.`);
  }
  const driver = request.driver;
  if (!driver || typeof driver !== 'object') throw new DriverError('driver-options', 'Command config must provide adapter.driverOptions.');
  if (!isAbsolute(driver.codexCommand ?? '')) throw new DriverError('driver-options', 'driver.codexCommand must be an absolute executable path.');
  if (!Array.isArray(driver.codexArgs) || !driver.codexArgs.every((value) => typeof value === 'string')) throw new DriverError('driver-options', 'driver.codexArgs must be an exact string array.');
  if (driver.configOverrides !== undefined && (!Array.isArray(driver.configOverrides) || !driver.configOverrides.every((value) => typeof value === 'string'))) throw new DriverError('driver-options', 'driver.configOverrides must be a string array.');
  if (driver.pluginStateOverrides !== undefined && (
    typeof driver.pluginStateOverrides?.enabled !== 'string'
    || typeof driver.pluginStateOverrides?.disabled !== 'string'
  )) throw new DriverError('driver-options', 'driver.pluginStateOverrides must provide exact enabled and disabled strings.');
  if (driver.allowModelInvocation !== undefined && typeof driver.allowModelInvocation !== 'boolean') throw new DriverError('driver-options', 'driver.allowModelInvocation must be boolean when supplied.');
  if (driver.allowModelInvocation === true) {
    if (!Array.isArray(driver.environmentAllowlist)
      || driver.environmentAllowlist.some((value) => typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))) {
      throw new DriverError('driver-options', 'Live evaluation requires an explicit environmentAllowlist of environment-variable names.');
    }
    const secretNames = driver.environmentAllowlist.filter((value) => /(?:TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL|API_KEY)/i.test(value));
    if (secretNames.length > 0) {
      throw new DriverError('driver-environment-secret', `Live child environment cannot inherit secret-bearing variables: ${secretNames.join(', ')}.`);
    }
  }
  if (typeof driver.marshalPluginId !== 'string' || !driver.marshalPluginId.includes('@')) throw new DriverError('driver-options', 'driver.marshalPluginId must be a full plugin id such as marshal-runtime@personal.');
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(driver.sandbox)) throw new DriverError('driver-options', 'driver.sandbox is invalid.');
  if (!['untrusted', 'on-request', 'never'].includes(driver.approvalPolicy)) throw new DriverError('driver-options', 'driver.approvalPolicy is invalid.');
  if (!isAbsolute(request.outputDirectory ?? '')) throw new DriverError('driver-output-directory', 'outputDirectory must be absolute.');
  for (const name of ['toolManifest', 'fixtureManifest', 'networkFixture']) {
    if (!isAbsolute(request.inputs?.[name]?.path ?? '') || !/^[a-f0-9]{64}$/.test(request.inputs?.[name]?.sha256 ?? '')) {
      throw new DriverError('driver-inputs', `${name} must have an absolute path and SHA-256 digest.`);
    }
  }
}

function configArguments(request, plugin) {
  const driver = request.driver;
  return [
    '-c', `model=${tomlString(request.fixed.model)}`,
    '-c', `model_reasoning_effort=${tomlString(request.fixed.reasoning)}`,
    '-c', `sandbox_mode=${tomlString(driver.sandbox)}`,
    '-c', `approval_policy=${tomlString(driver.approvalPolicy)}`,
    '-c', plugin,
    ...(driver.configOverrides ?? []).flatMap((value) => ['-c', value]),
  ];
}

function pluginOverride(id, enabled, configured) {
  // A full-table override is required for plugin ids containing `@`; dotted
  // `-c` paths preserve the quote characters as part of the id in Codex 0.144.
  // Generated real profiles therefore pin both arm-specific table values.
  if (configured) return enabled ? configured.enabled : configured.disabled;
  const escaped = id.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `plugins."${escaped}".enabled=${enabled ? 'true' : 'false'}`;
}

function driverEnvironment(request) {
  const inherited = {};
  for (const name of request.driver.environmentAllowlist ?? []) {
    if (process.env[name] !== undefined) inherited[name] = process.env[name];
  }
  return {
    ...inherited,
    MARSHAL_EVAL_RUN_ID: request.runId,
    MARSHAL_EVAL_ATTEMPT_KEY: request.attempt.attemptKey,
    MARSHAL_RUNTIME_MEMORY_DB: join(request.outputDirectory, 'marshal-state', 'memory.sqlite'),
  };
}

async function collectJsonlProcess(child, options) {
  const started = Date.now();
  let bytes = 0;
  let outputLimit = false;
  let timeout = false;
  let buffer = '';
  const events = [];
  const stderr = [];
  const timer = setTimeout(() => {
    timeout = true;
    child.kill();
  }, options.timeoutMs);
  child.stdout.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > options.maxBytes) {
      outputLimit = true;
      child.kill();
      return;
    }
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try { events.push({ value: JSON.parse(line), observedAtMs: Date.now() }); }
      catch (error) { events.push({ value: { type: 'driver.invalid_jsonl', line, error: error.message }, observedAtMs: Date.now() }); }
    }
  });
  child.stderr.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > options.maxBytes) {
      outputLimit = true;
      child.kill();
      return;
    }
    stderr.push(chunk);
  });
  child.stdin.end(options.stdin);
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolveExit(code));
  }).catch((error) => {
    events.push({ value: { type: 'driver.spawn_error', message: error.message }, observedAtMs: Date.now() });
    return null;
  });
  clearTimeout(timer);
  if (buffer.trim()) {
    try { events.push({ value: JSON.parse(buffer), observedAtMs: Date.now() }); }
    catch (error) { events.push({ value: { type: 'driver.invalid_jsonl', line: buffer, error: error.message }, observedAtMs: Date.now() }); }
  }
  return {
    started,
    events,
    exitCode,
    timeout,
    outputLimit,
    stderr: Buffer.concat(stderr).toString('utf8').slice(0, 16_000),
    bytes,
  };
}

async function runBoundedCommand(command, args, options) {
  const child = spawn(command, args, {
    env: options.env,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  let bytes = 0;
  let timeout = false;
  let limit = false;
  const collect = (target) => (chunk) => {
    bytes += chunk.length;
    if (bytes > options.maxBytes) {
      limit = true;
      child.kill();
    } else target.push(chunk);
  };
  child.stdout.on('data', collect(stdout));
  child.stderr.on('data', collect(stderr));
  const timer = setTimeout(() => {
    timeout = true;
    child.kill();
  }, options.timeoutMs);
  child.stdin.end(options.stdin ?? '');
  const outcome = await new Promise((resolveOutcome) => {
    child.once('error', (error) => resolveOutcome({ code: null, error }));
    child.once('close', (code) => resolveOutcome({ code }));
  });
  clearTimeout(timer);
  const stdoutText = Buffer.concat(stdout).toString('utf8');
  const stderrText = Buffer.concat(stderr).toString('utf8');
  return {
    ok: outcome.code === 0 && !timeout && !limit,
    stdout: stdoutText,
    stderr: stderrText,
    message: outcome.error?.message ?? (timeout ? `Command exceeded ${options.timeoutMs}ms.` : limit ? `Command exceeded ${options.maxBytes} bytes.` : `Command exited ${String(outcome.code)}: ${stderrText}`),
  };
}

function lineCollector(stream, maxBytes) {
  let buffer = '';
  let bytes = 0;
  const waiters = [];
  stream.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      for (const waiter of waiters.splice(0)) waiter.reject(new Error(`Probe exceeded ${maxBytes} bytes.`));
      return;
    }
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let value;
      try { value = JSON.parse(line); } catch { continue; }
      for (const waiter of [...waiters]) waiter.inspect(value);
    }
  });
  return waiters;
}

function waitForJsonResponse(waiters, id, timeoutMs) {
  return new Promise((resolveValue, reject) => {
    const waiter = {
      inspect(value) {
        if (value.id !== id) return;
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        clearTimeout(timer);
        resolveValue(value);
      },
      reject,
    };
    const timer = setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      reject(new Error(`Timed out waiting for app-server response ${id}.`));
    }, timeoutMs);
    waiters.push(waiter);
  });
}

function addUsage(target, usage = {}) {
  target.input += integer(usage.input_tokens ?? usage.inputTokens);
  target.output += integer(usage.output_tokens ?? usage.outputTokens);
  target.cached += integer(usage.cached_input_tokens ?? usage.cachedInputTokens);
}

function isToolItem(type) {
  return ['command_execution', 'commandExecution', 'mcp_tool_call', 'mcpToolCall', 'web_search', 'webSearch', 'collab_agent_tool_call', 'collabAgentToolCall', 'dynamic_tool_call', 'dynamicToolCall'].includes(type);
}

function toolIdentity(item) {
  return {
    type: item.type,
    ...(item.server ? { server: item.server } : {}),
    ...(item.tool ? { tool: item.tool } : {}),
    ...(item.command ? { command: item.command } : {}),
    ...(item.query ? { query: item.query } : {}),
    ...(item.plugin_id || item.pluginId ? { pluginId: item.plugin_id ?? item.pluginId } : {}),
  };
}

function filePaths(item) {
  const values = [];
  for (const change of item.changes ?? []) {
    if (typeof change.path === 'string') values.push(change.path);
    if (typeof change.file_path === 'string') values.push(change.file_path);
  }
  if (typeof item.path === 'string') values.push(item.path);
  return values;
}

function findReceipts(value, depth = 0, seen = new Set()) {
  if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return [];
  seen.add(value);
  const found = [];
  for (const [key, child] of Object.entries(value)) {
    if (/^receipts?$/i.test(key)) found.push(...(Array.isArray(child) ? child : [child]));
    else found.push(...findReceipts(child, depth + 1, seen));
  }
  return found.filter((item) => item && typeof item === 'object');
}

function mediaType(path) {
  const extension = path.toLowerCase().split('.').pop();
  return extension === 'json' ? 'application/json'
    : extension === 'md' ? 'text/markdown; charset=utf-8'
      : ['txt', 'ts', 'tsx', 'js', 'mjs', 'css', 'html', 'csv'].includes(extension) ? 'text/plain; charset=utf-8'
        : 'application/octet-stream';
}

function status(value, reason) {
  return { status: value, reason };
}

function normalizeError(error) {
  if (error instanceof DriverError) return { category: error.category, message: error.message, timeout: error.timeout };
  return { category: 'codex-driver-error', message: error instanceof Error ? error.message : String(error), timeout: false };
}

class DriverError extends Error {
  constructor(category, message, options = {}) {
    super(message);
    this.category = category;
    this.timeout = options.timeout === true;
  }
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function integer(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  return value;
}

function safeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
}

function isWithin(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function dedupeJson(values) {
  return [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    const args = process.argv.slice(2);
    if (args.some((value) => !['--preflight', '--help', '-h'].includes(value))) throw new Error(`Unknown argument: ${args.find((value) => !['--preflight', '--help', '-h'].includes(value))}`);
    if (args.includes('--help') || args.includes('-h')) {
      process.stdout.write('Usage: node scripts/evals/codex-driver.mjs [--preflight] < request.json\n');
    } else {
      const request = JSON.parse(await readStdin());
      const result = await runCodexDriver(request, { preflightOnly: args.includes('--preflight') });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  }
}
