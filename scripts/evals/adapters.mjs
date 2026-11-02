import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { assert } from './core.mjs';
import { unavailableConfinementLease } from './security/confinement-lease-contract.mjs';
import { isVerifiedConfinementLeaseSummary } from './security/confinement-lease-client.mjs';

const fixtureCache = new Map();

export async function runAdapterAttempt(request, config) {
  if (config.adapter.kind === 'fixture') return runFixtureAttempt(request, config);
  if (config.adapter.kind === 'command') return runCommandAttempt(request, config);
  throw new Error('Dry-run adapters produce plans and cannot execute attempts.');
}

async function runFixtureAttempt(request, config) {
  const resultsPath = isAbsolute(config.adapter.resultsFile)
    ? resolve(config.adapter.resultsFile)
    : resolve(config.configRoot, config.adapter.resultsFile);
  let fixture = fixtureCache.get(resultsPath);
  if (!fixture) {
    fixture = JSON.parse(await readFile(resultsPath, 'utf8'));
    assert(fixture.schemaVersion === '1.0.0', 'Unexpected fixture-results schemaVersion.');
    fixtureCache.set(resultsPath, fixture);
  }
  const exact = fixture.overrides?.[request.attempt.attemptKey] ?? {};
  const byCase = fixture.byCase?.[request.case.id] ?? {};
  const byTreatment = fixture.byTreatment?.[request.treatment.id] ?? {};
  const merged = mergeResult(fixture.defaultResult ?? {}, byTreatment, byCase, exact);
  if (typeof merged.objectiveScore === 'number') {
    merged.assertionObservations = { ...merged.assertionObservations };
    for (const assertion of request.case.scoring.assertions) {
      if (assertion.kind === 'human-rubric' || merged.assertionObservations[assertion.id]) continue;
      merged.assertionObservations[assertion.id] = {
        type: 'score',
        score: merged.objectiveScore,
        grader: 'fixture-objective-signal',
        notes: 'Synthetic fixture adapter signal; never valid as live evaluation evidence.',
      };
    }
  }
  return normalizeAdapterResult({
    ...merged,
    evidenceClass: 'fixture',
    trace: [
      ...(Array.isArray(merged.trace) ? merged.trace : []),
      { event: 'fixture-adapter', attemptKey: request.attempt.attemptKey },
    ],
  });
}

async function runCommandAttempt(request, config) {
  const histories = [];
  const maximumAttempts = config.fixed.maxRetries + 1;
  for (let invocation = 1; invocation <= maximumAttempts; invocation += 1) {
    const result = await invokeCommand(request, config, invocation);
    histories.push(result.transport);
    if (result.ok) {
      return normalizeAdapterResult({
        ...result.value,
        evidenceClass: result.value.evidenceClass ?? 'live',
        retries: invocation - 1,
        trace: [
          ...(Array.isArray(result.value.trace) ? result.value.trace : []),
          { event: 'adapter-transport', invocations: histories },
        ],
      });
    }
    if (invocation === maximumAttempts) {
      return normalizeAdapterResult({
        evidenceClass: 'unavailable',
        status: result.timeout ? 'timeout' : 'error',
        errorCategory: result.timeout ? 'adapter-timeout' : result.category,
        errorMessage: result.message,
        retries: invocation - 1,
        trace: [{ event: 'adapter-transport', invocations: histories }],
      });
    }
  }
  throw new Error('Unreachable command adapter state.');
}

async function invokeCommand(request, config, invocation) {
  const started = Date.now();
  const timeoutMs = request.case.budgets.timeoutMs;
  const cwd = config.adapter.cwd
    ? resolve(config.configRoot, config.adapter.cwd)
    : config.configRoot;
  return new Promise((resolveResult) => {
    const child = spawn(config.adapter.command, config.adapter.args ?? [], {
      cwd,
      env: {
        ...process.env,
        MARSHAL_EVAL_RUN_ID: request.runId,
        MARSHAL_EVAL_ATTEMPT_KEY: request.attempt.attemptKey,
        MARSHAL_EVAL_INVOCATION: String(invocation),
      },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let exceeded = false;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolveResult({
        ok: false,
        timeout: true,
        category: 'adapter-timeout',
        message: `Adapter exceeded ${timeoutMs}ms.`,
        transport: { invocation, wallTimeMs: Date.now() - started, timeout: true },
      });
    }, timeoutMs);
    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > config.fixed.maxOutputBytes) {
        exceeded = true;
        child.kill();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', (error) => finish({
      ok: false,
      category: 'adapter-launch',
      message: error.message,
    }));
    child.on('close', (code, signal) => {
      if (exceeded) {
        finish({
          ok: false,
          category: 'adapter-output-limit',
          message: `Adapter exceeded ${config.fixed.maxOutputBytes} output bytes.`,
        });
        return;
      }
      const stdoutText = Buffer.concat(stdout).toString('utf8');
      const stderrText = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        finish({
          ok: false,
          category: 'adapter-exit',
          message: `Adapter exited ${code ?? 'without a code'}${signal ? ` (${signal})` : ''}: ${stderrText.slice(0, 2_000)}`,
          stdout: stdoutText,
          stderr: stderrText,
        });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(stdoutText), stdout: stdoutText, stderr: stderrText });
      } catch (error) {
        finish({
          ok: false,
          category: 'adapter-protocol',
          message: `Adapter did not return one JSON document: ${error.message}`,
          stdout: stdoutText,
          stderr: stderrText,
        });
      }
    });
    child.stdin.end(JSON.stringify(request));

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({
        ...result,
        timeout: false,
        transport: {
          invocation,
          wallTimeMs: Date.now() - started,
          timeout: false,
          category: result.category,
          stdoutBytes: Buffer.concat(stdout).length,
          stderrBytes: Buffer.concat(stderr).length,
          stderr: result.stderr,
        },
      });
    }
  });
}

function normalizeAdapterResult(value) {
  const status = value.status ?? 'passed';
  assert(['passed', 'failed', 'timeout', 'error', 'skipped'].includes(status), `Invalid adapter status: ${status}`);
  assert(['live', 'fixture', 'unavailable'].includes(value.evidenceClass), `Invalid adapter evidenceClass: ${value.evidenceClass}`);
  const tokens = value.tokens ?? {};
  return {
    evidenceClass: value.evidenceClass,
    status,
    excluded: value.excluded === true,
    exclusionReason: value.exclusionReason,
    errorCategory: value.errorCategory,
    errorMessage: value.errorMessage,
    finalOutput: typeof value.finalOutput === 'string' ? value.finalOutput : '',
    phaseOutputs: Array.isArray(value.phaseOutputs) ? value.phaseOutputs : [],
    trace: Array.isArray(value.trace) ? value.trace : [],
    generatedFiles: Array.isArray(value.generatedFiles) ? value.generatedFiles : [],
    permissions: Array.isArray(value.permissions) ? value.permissions : [],
    receipts: Array.isArray(value.receipts) ? value.receipts : [],
    observedTools: Array.isArray(value.observedTools) ? value.observedTools : [],
    uiEvidence: Array.isArray(value.uiEvidence) ? value.uiEvidence : [],
    assertionObservations: value.assertionObservations ?? {},
    timings: value.timings ?? {},
    availability: value.availability ?? {},
    releaseAttestations: value.releaseAttestations ?? {},
    confinementLease: normalizeConfinementLeaseSummary(value.confinementLease),
    wallTimeMs: integer(value.wallTimeMs, 0),
    timeToUsefulResultMs: optionalInteger(value.timeToUsefulResultMs),
    toolCalls: integer(value.toolCalls, 0),
    retries: integer(value.retries, 0),
    estimatedCostUsd: optionalNumber(value.estimatedCostUsd),
    tokens: {
      input: integer(tokens.input, 0),
      output: integer(tokens.output, 0),
      cached: integer(tokens.cached, 0),
    },
  };
}

function normalizeConfinementLeaseSummary(value) {
  if (!isVerifiedConfinementLeaseSummary(value)) {
    return unavailableConfinementLease(value?.releaseEligible === true
      ? 'External adapters cannot self-assert release-eligible confinement; no runner-verified lease receipt was present.'
      : 'No runner-verified release-eligible confinement lease receipt was present.');
  }
  const providerConfigured = value.providerConfigured === true;
  const status = ['unavailable', 'attested', 'cleaned', 'error'].includes(value.status) ? value.status : 'unavailable';
  const attestationMeasurement = digestOrNull(value.attestationMeasurement);
  const receiptBundleDigest = digestOrNull(value.receiptBundleDigest);
  const cleanupReceiptDigest = digestOrNull(value.cleanupReceiptDigest);
  const providerSha256 = digestOrNull(value.providerSha256);
  const providerIdentityDigest = digestOrNull(value.providerIdentityDigest);
  const providerApprovalDigest = digestOrNull(value.providerApprovalDigest);
  const profileSha256 = digestOrNull(value.profileSha256);
  const profileSemanticsSha256 = digestOrNull(value.profileSemanticsSha256);
  const executionPlanDigest = digestOrNull(value.executionPlanDigest);
  const requiredRoles = normalizedRoles(value.requiredRoles);
  const observedRoles = normalizedRoles(value.observedRoles);
  const commandReceiptCount = Number.isInteger(value.commandReceiptCount) && value.commandReceiptCount >= 0
    ? value.commandReceiptCount : 0;
  const attemptKey = typeof value.attemptKey === 'string' && value.attemptKey.length <= 1_024 ? value.attemptKey : null;
  const configurationDigest = digestOrNull(value.configurationDigest);
  const declaredBlockers = Array.isArray(value.blockers) ? value.blockers.filter((item) => typeof item === 'string') : [];
  const complete = providerConfigured
    && status === 'cleaned'
    && attestationMeasurement !== null
    && receiptBundleDigest !== null
    && cleanupReceiptDigest !== null
    && providerSha256 !== null
    && providerIdentityDigest !== null
    && providerApprovalDigest !== null
    && profileSha256 !== null
    && profileSemanticsSha256 !== null
    && executionPlanDigest !== null
    && requiredRoles.length > 0
    && requiredRoles.every((role) => observedRoles.includes(role))
    && commandReceiptCount >= requiredRoles.length
    && attemptKey !== null
    && configurationDigest !== null
    && declaredBlockers.length === 0;
  const falseClaim = value.releaseEligible === true && !complete;
  return {
    providerConfigured,
    status,
    releaseEligible: value.releaseEligible === true && complete,
    attestationMeasurement,
    receiptBundleDigest,
    cleanupReceiptDigest,
    providerSha256,
    providerIdentityDigest,
    providerApprovalDigest,
    profileSha256,
    profileSemanticsSha256,
    executionPlanDigest,
    requiredRoles,
    observedRoles,
    commandReceiptCount,
    attemptKey,
    configurationDigest,
    blockers: [
      ...declaredBlockers,
      ...(falseClaim ? ['Adapter claimed a release-eligible lease without complete attestation, receipt-bundle, and cleanup digests.'] : []),
    ],
  };
}

function digestOrNull(value) {
  return /^[a-f0-9]{64}$/.test(value ?? '') ? value : null;
}

function normalizedRoles(value) {
  if (!Array.isArray(value) || value.length > 16) return [];
  const roles = value.filter((role) => typeof role === 'string' && /^[a-z0-9-]{1,64}$/.test(role));
  return roles.length === value.length ? [...new Set(roles)].sort() : [];
}

function mergeResult(...values) {
  const merged = Object.assign({}, ...values);
  merged.assertionObservations = Object.assign(
    {},
    ...values.map((value) => value.assertionObservations ?? {}),
  );
  return merged;
}

function integer(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function optionalInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function optionalNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
