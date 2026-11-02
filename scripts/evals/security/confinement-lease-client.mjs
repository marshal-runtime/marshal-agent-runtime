import { randomBytes, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
  CONFINEMENT_LEASE_FRAME_TYPES,
  computeConfinementMeasurement,
  createConfinementLeaseFrame,
  createConfinementReceiptBundle,
  validateConfinementCleanupReceipt,
  validateConfinementCommandReceipt,
  validateConfinementLeaseAttestation,
  validateConfinementLeaseFrame,
} from './confinement-lease-contract.mjs';

const DEFAULT_FRAME_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const verifiedConfinementLeaseSummaries = new WeakMap();

export function isVerifiedConfinementLeaseSummary(value) {
  if (!value || typeof value !== 'object') return false;
  const expectedDigest = verifiedConfinementLeaseSummaries.get(value);
  return typeof expectedDigest === 'string' && expectedDigest === computeConfinementMeasurement(value);
}

export async function openConfinementLease(descriptor, request, options = {}) {
  validateDescriptor(descriptor);
  assert(options.approvedProviders === undefined,
    'Approved confinement providers must come from runner-owned frozen authority, not openConfinementLease call options.');
  const descriptorSnapshot = deepFreeze(structuredClone(descriptor));
  const requestSnapshot = deepFreeze(structuredClone(request));
  const providerBytes = await readFile(descriptorSnapshot.providerFile);
  assert(sha256(providerBytes) === descriptorSnapshot.providerSha256, 'Confinement lease provider digest mismatch.');
  const child = (options.spawn ?? spawn)(descriptorSnapshot.providerCommand, descriptorSnapshot.providerArgs ?? [], {
    cwd: descriptorSnapshot.cwd ? resolve(descriptorSnapshot.cwd) : undefined,
    env: descriptorSnapshot.env ?? {},
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const requiredRoles = requiredExecutionRoles(requestSnapshot.uiRequired === true);
  const executionPlanDigest = computeConfinementMeasurement({
    attemptKey: requestSnapshot.attemptKey,
    configurationDigest: requestSnapshot.configurationDigest,
    requiredRoles,
    uiRequired: requestSnapshot.uiRequired === true,
  });
  const client = new ConfinementLeaseClient(child, descriptorSnapshot, {
    executionPlanDigest,
    requiredRoles,
    testTransport: options.spawn !== undefined,
  });
  try {
    await client.open(deepFreeze({ ...requestSnapshot, providerSha256: descriptorSnapshot.providerSha256, executionPlanDigest }));
    return client.facade();
  } catch (error) {
    client.abort();
    throw error;
  }
}

class ConfinementLeaseClient {
  #child;
  #descriptor;
  #executionPlan;
  #sequence = 0;
  #state = 'starting';
  #attestation;
  #assessment;
  #commandReceipts = [];
  #pending;
  #buffer = '';
  #stderr = [];
  #outputBytes = 0;

  constructor(child, descriptor, executionPlan) {
    this.#child = child;
    this.#descriptor = descriptor;
    this.#executionPlan = deepFreeze(structuredClone(executionPlan));
    child.stdout.on('data', (chunk) => this.#consume(chunk));
    child.stderr.on('data', (chunk) => {
      this.#outputBytes += chunk.length;
      if (this.#outputBytes <= (descriptor.maxFrameBytes ?? DEFAULT_FRAME_BYTES)) this.#stderr.push(chunk);
      else this.#fail(new Error('Confinement lease provider exceeded its output limit.'));
    });
    child.once('error', (error) => this.#fail(error));
    child.once('close', (code) => {
      if (this.#pending) this.#fail(new Error(`Confinement lease provider exited ${String(code)} before responding.`));
      if (this.#state !== 'cleaned' && this.#state !== 'aborted') this.#state = 'closed';
    });
  }

  facade() {
    const facade = Object.create(null);
    Object.defineProperties(facade, {
      execute: { enumerable: false, value: (command) => this.execute(command) },
      cleanup: { enumerable: false, value: () => this.cleanup() },
      abort: { enumerable: false, value: () => this.abort() },
      inspect: { enumerable: false, value: () => this.inspect() },
    });
    return Object.freeze(facade);
  }

  inspect() {
    return deepFreeze({
      state: this.#state,
      providerKilled: this.#child.killed === true,
      assessment: this.#assessment ? structuredClone(this.#assessment) : null,
      attestation: this.#attestation ? structuredClone(this.#attestation) : null,
      commandReceiptCount: this.#commandReceipts.length,
    });
  }

  async open(request) {
    assert(this.#state === 'starting', 'Confinement lease can only be opened once.');
    assert(typeof request.challenge === 'string' && /^[a-f0-9]{64}$/.test(request.challenge), 'Confinement lease requires a fresh 256-bit challenge.');
    assert(typeof request.attemptKey === 'string' && request.attemptKey.length > 0 && request.attemptKey.length <= 1_024,
      'Confinement lease requires an exact bounded attempt key.');
    assert(typeof request.configurationDigest === 'string' && /^[a-f0-9]{64}$/.test(request.configurationDigest),
      'Confinement lease requires the exact configuration digest.');
    const payload = await this.#request(
      CONFINEMENT_LEASE_FRAME_TYPES.openRequest,
      CONFINEMENT_LEASE_FRAME_TYPES.openResponse,
      request,
    );
    const validated = validateConfinementLeaseAttestation(payload, request);
    this.#attestation = deepFreeze(structuredClone(validated.attestation));
    this.#assessment = deepFreeze({ releaseEligible: validated.releaseEligible, blockers: [...validated.blockers] });
    this.#state = 'open';
    return this.#assessment;
  }

  async execute(command) {
    assert(this.#state === 'open', 'Confinement lease commands require an open lease.');
    const commandId = command.commandId ?? randomBytes(16).toString('hex');
    assert(typeof commandId === 'string' && /^[a-zA-Z0-9._:-]{8,128}$/.test(commandId), 'Confinement commandId is invalid.');
    assert(typeof command.role === 'string' && command.role.length > 0, 'Confinement command role is required.');
    assert(this.#executionPlan.requiredRoles.includes(command.role), 'Confinement command role is outside the exact evaluation execution plan.');
    const sequence = this.#sequence + 1;
    const commandPayload = deepFreeze(structuredClone({ ...command, commandId, leaseId: this.#attestation.leaseId,
      executionPlanDigest: this.#executionPlan.executionPlanDigest }));
    let receipt;
    try {
      const payload = await this.#request(
        CONFINEMENT_LEASE_FRAME_TYPES.commandRequest,
        CONFINEMENT_LEASE_FRAME_TYPES.commandResponse,
        commandPayload,
      );
      receipt = validateConfinementCommandReceipt(payload, {
        leaseId: this.#attestation.leaseId,
        commandId,
        sequence,
        role: command.role,
        commandSha256: computeConfinementMeasurement(commandPayload),
        enforcementMeasurement: this.#attestation.measurement,
      });
    } catch (error) {
      this.abort();
      throw error;
    }
    const receiptSnapshot = deepFreeze(structuredClone(receipt));
    this.#commandReceipts.push(receiptSnapshot);
    return receiptSnapshot;
  }

  async cleanup() {
    assert(this.#state === 'open', 'Confinement lease cleanup requires an open lease.');
    const sequence = this.#sequence + 1;
    let cleanupReceipt;
    let receiptBundle;
    try {
      const payload = await this.#request(
        CONFINEMENT_LEASE_FRAME_TYPES.cleanupRequest,
        CONFINEMENT_LEASE_FRAME_TYPES.cleanupResponse,
        { leaseId: this.#attestation.leaseId, executionPlanDigest: this.#executionPlan.executionPlanDigest },
      );
      cleanupReceipt = validateConfinementCleanupReceipt(payload, {
        leaseId: this.#attestation.leaseId,
        sequence,
        enforcementMeasurement: this.#attestation.measurement,
      });
      receiptBundle = createConfinementReceiptBundle({
        attestation: this.#attestation,
        commandReceipts: this.#commandReceipts,
        cleanupReceipt,
      });
    } catch (error) {
      this.abort();
      throw error;
    }
    this.#state = 'cleaned';
    this.#child.stdin.end();
    const observedRoles = [...new Set(this.#commandReceipts.map((receipt) => receipt.role))].sort();
    const executionBlockers = [
      ...(this.#commandReceipts.length === 0 ? ['no-command-receipts'] : []),
      ...this.#executionPlan.requiredRoles.filter((role) => !observedRoles.includes(role))
        .map((role) => `missing-command-receipt-role-${role}`),
      ...(this.#executionPlan.testTransport ? ['test-transport-not-release-capable'] : []),
      'runner-frozen-execution-plan-authority-unavailable',
      'persisted-cryptographic-confinement-verifier-unavailable',
    ];
    const blockers = [...new Set([...this.#assessment.blockers, ...executionBlockers])];
    const summary = deepFreeze({
      providerConfigured: true,
      status: 'cleaned',
      releaseEligible: false,
      attestationMeasurement: this.#attestation.measurement,
      receiptBundleDigest: receiptBundle.receiptBundleSha256,
      cleanupReceiptDigest: cleanupReceipt.receiptSha256,
      providerSha256: this.#descriptor.providerSha256,
      providerIdentityDigest: computeConfinementMeasurement({
        providerCommand: normalizedPath(this.#descriptor.providerCommand),
        providerArgs: this.#descriptor.providerArgs ?? [],
        providerSha256: this.#descriptor.providerSha256,
      }),
      providerApprovalDigest: null,
      profileSha256: this.#attestation.profileSha256,
      profileSemanticsSha256: this.#attestation.profileSemanticsSha256,
      executionPlanDigest: this.#executionPlan.executionPlanDigest,
      requiredRoles: this.#executionPlan.requiredRoles,
      observedRoles,
      commandReceiptCount: this.#commandReceipts.length,
      attemptKey: this.#attestation.attemptKey,
      configurationDigest: this.#attestation.configurationDigest,
      blockers,
    });
    verifiedConfinementLeaseSummaries.set(summary, computeConfinementMeasurement(summary));
    return deepFreeze({
      cleanupReceipt: structuredClone(cleanupReceipt),
      receiptBundle: structuredClone(receiptBundle),
      summary,
    });
  }

  abort() {
    if (this.#state === 'cleaned' || this.#state === 'aborted') return;
    this.#state = 'aborted';
    this.#child.kill();
  }

  async #request(requestType, responseType, payload) {
    assert(!this.#pending, 'Confinement lease protocol permits one outstanding request at a time.');
    const sequence = ++this.#sequence;
    const requestId = `lease-${sequence}-${randomBytes(8).toString('hex')}`;
    const frame = createConfinementLeaseFrame(requestType, requestId, sequence, payload);
    const response = new Promise((resolveValue, reject) => {
      const timer = setTimeout(() => {
        this.#pending = undefined;
        this.abort();
        reject(new Error(`Timed out waiting for confinement lease response ${requestType}.`));
      }, this.#descriptor.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      this.#pending = {
        inspect: (value) => {
          try {
            const result = validateConfinementLeaseFrame(value, { type: responseType, requestId, sequence });
            clearTimeout(timer);
            this.#pending = undefined;
            resolveValue(result);
          } catch (error) {
            clearTimeout(timer);
            this.#pending = undefined;
            reject(error);
          }
        },
        reject: (error) => {
          clearTimeout(timer);
          this.#pending = undefined;
          reject(error);
        },
      };
    });
    this.#child.stdin.write(`${JSON.stringify(frame)}\n`);
    return response;
  }

  #consume(chunk) {
    this.#outputBytes += chunk.length;
    if (this.#outputBytes > (this.#descriptor.maxFrameBytes ?? DEFAULT_FRAME_BYTES)) {
      this.#fail(new Error('Confinement lease provider exceeded its output limit.'));
      return;
    }
    this.#buffer += chunk.toString('utf8');
    let index;
    while ((index = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (!line) continue;
      let frame;
      try { frame = JSON.parse(line); }
      catch (error) {
        this.#fail(new Error(`Confinement lease provider returned invalid JSON: ${error.message}`));
        return;
      }
      if (!this.#pending) {
        this.#fail(new Error('Confinement lease provider emitted an unsolicited frame.'));
        return;
      }
      this.#pending.inspect(frame);
    }
  }

  #fail(error) {
    if (this.#pending) this.#pending.reject(error);
    this.abort();
  }
}

function validateDescriptor(descriptor) {
  assert(descriptor && typeof descriptor === 'object', 'Confinement lease provider descriptor is required.');
  assert(isAbsolute(descriptor.providerCommand ?? ''), 'Confinement lease provider command must be absolute.');
  assert(isAbsolute(descriptor.providerFile ?? ''), 'Confinement lease provider file must be absolute.');
  assert(/^[a-f0-9]{64}$/.test(descriptor.providerSha256 ?? ''), 'Confinement lease provider SHA-256 is required.');
  assert(descriptor.providerArgs === undefined || descriptor.providerArgs.every((value) => typeof value === 'string'), 'Confinement lease provider args must be strings.');
  assert(descriptor.env === undefined || (descriptor.env && typeof descriptor.env === 'object' && !Array.isArray(descriptor.env)), 'Confinement lease provider env must be an object.');
  const providerIdentity = normalizedPath(descriptor.providerFile);
  const commandIdentity = normalizedPath(descriptor.providerCommand);
  const argumentIdentities = (descriptor.providerArgs ?? []).filter(isAbsolute).map(normalizedPath);
  assert(commandIdentity === providerIdentity || argumentIdentities.includes(providerIdentity),
    'Confinement lease providerFile must identify the executable or an exact absolute command argument.');
}

function requiredExecutionRoles(uiRequired) {
  return [
    'codex-process',
    'marshal-plugin-children',
    'workspace-command-children',
    'objective-oracle',
    ...(uiRequired ? ['desktop-host', 'evidence-capture'] : []),
  ];
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedPath(value) {
  const path = resolve(value);
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
