import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { PermissionCheck } from '@marshal/agent-runtime-core';
import type {
  RuntimeExtensionAutopilotService,
  RuntimeExtensionAutopilotSnapshot,
  RuntimeExtensionLifecycleRecord,
} from '@marshal/agent-runtime-extensions';

const STATE_VERSION = 1;
const MAX_EXTENSIONS = 256;
const MAX_PROVIDER_IDS = 256;
const MAX_STATE_BYTES = 256 * 1024;
const STATE_LOCK_TIMEOUT_MS = 5_000;
const STATE_LOCK_RETRY_MS = 25;

interface MutableAutopilotEntry {
  enabled: boolean;
  capabilityProviderIds: string[];
  contributedCapabilityPrefixes: string[];
}

interface PersistedAutopilotState {
  version: 1;
  globalEnabled: boolean;
  extensions: Record<string, MutableAutopilotEntry>;
}

/** File-backed Codex policy that grants only capabilities owned by runtime extensions. */
export class CodexExtensionAutopilotPolicy implements RuntimeExtensionAutopilotService {
  private queue = Promise.resolve();

  private constructor(
    private readonly statePath: string,
    private state: PersistedAutopilotState,
  ) {}

  static async open(statePath: string): Promise<CodexExtensionAutopilotPolicy> {
    return new CodexExtensionAutopilotPolicy(statePath, await readState(statePath));
  }

  refresh(): Promise<void> {
    const operation = this.queue.then(async () => {
      this.state = await withStateLock(
        this.statePath,
        () => readState(this.statePath),
      );
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  snapshot(): RuntimeExtensionAutopilotSnapshot {
    return Object.freeze({
      globalEnabled: this.state.globalEnabled,
      extensions: Object.freeze(Object.entries(this.state.extensions)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([identity, entry]) => Object.freeze({
          identity,
          enabled: entry.enabled,
          capabilityProviderIds: Object.freeze([...entry.capabilityProviderIds]),
          contributedCapabilityPrefixes: Object.freeze([...entry.contributedCapabilityPrefixes]),
        }))),
    });
  }

  setGlobal(enabled: boolean): Promise<void> {
    return this.update((state) => {
      if (state.globalEnabled === enabled) return false;
      state.globalEnabled = enabled;
      return true;
    });
  }

  setExtension(
    identity: string,
    enabled: boolean,
    capabilityProviderIds: readonly string[] = [],
    contributedCapabilityPrefixes: readonly string[] = [],
  ): Promise<void> {
    const normalizedIdentity = requireIdentity(identity);
    return this.update((state) => {
      const previous = state.extensions[normalizedIdentity];
      const nextProviderIds = normalizeProviderIds(
        capabilityProviderIds.length > 0
          ? capabilityProviderIds
          : previous?.capabilityProviderIds ?? [],
      );
      const nextCapabilityPrefixes = normalizeCapabilityPrefixes(
        contributedCapabilityPrefixes.length > 0
          ? contributedCapabilityPrefixes
          : previous?.contributedCapabilityPrefixes ?? [],
      );
      if (previous?.enabled === enabled
        && arraysEqual(previous.capabilityProviderIds, nextProviderIds)
        && arraysEqual(previous.contributedCapabilityPrefixes, nextCapabilityPrefixes)) {
        return false;
      }
      state.extensions[normalizedIdentity] = {
        enabled,
        capabilityProviderIds: nextProviderIds,
        contributedCapabilityPrefixes: nextCapabilityPrefixes,
      };
      return true;
    });
  }

  syncExtensions(records: readonly RuntimeExtensionLifecycleRecord[]): Promise<void> {
    return this.update((state) => {
      let changed = false;
      const installedIdentities = new Set<string>();
      for (const record of records.slice(0, MAX_EXTENSIONS)) {
        installedIdentities.add(record.identity);
        const previous = state.extensions[record.identity];
        const providerIds = normalizeProviderIds(record.capabilityProviderIds);
        const capabilityPrefixes = normalizeCapabilityPrefixes(record.contributedCapabilityPrefixes ?? []);
        if (previous
          && arraysEqual(previous.capabilityProviderIds, providerIds)
          && arraysEqual(previous.contributedCapabilityPrefixes, capabilityPrefixes)) continue;
        state.extensions[record.identity] = {
          enabled: previous?.enabled ?? false,
          capabilityProviderIds: providerIds,
          contributedCapabilityPrefixes: capabilityPrefixes,
        };
        changed = true;
      }
      for (const identity of Object.keys(state.extensions)) {
        if (installedIdentities.has(identity)) continue;
        delete state.extensions[identity];
        changed = true;
      }
      return changed;
    });
  }

  async resolveGrants(check: PermissionCheck): Promise<readonly {
    principalId: string;
    permission: string;
    capability: string;
  }[]> {
    await this.refresh();
    const providerId = check.capability.provider.id;
    const matchingExtension = Object.values(this.state.extensions).find(
      (entry) => (this.state.globalEnabled || entry.enabled)
        && (entry.capabilityProviderIds.includes(providerId)
          || entry.contributedCapabilityPrefixes.some(
            (prefix) => check.capability.name.startsWith(prefix),
          )),
    );
    return matchingExtension ? [grantFor(check)] : [];
  }

  private update(mutator: (state: PersistedAutopilotState) => boolean): Promise<void> {
    const operation = this.queue.then(async () => {
      await withStateLock(this.statePath, async () => {
        const next = cloneState(await readState(this.statePath));
        if (!mutator(next)) {
          this.state = next;
          return;
        }
        await writeStateAtomically(this.statePath, next);
        this.state = next;
      });
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

}

async function withStateLock<T>(statePath: string, operation: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const lockPath = `${statePath}.lock`;
  const deadline = Date.now() + STATE_LOCK_TIMEOUT_MS;
  for (;;) {
    const token = randomUUID();
    const candidatePath = `${lockPath}.${process.pid}.${token}.candidate`;
    try {
      await fs.writeFile(candidatePath, JSON.stringify({ pid: process.pid, token }), {
        encoding: 'utf8',
        flag: 'wx',
      });
      try {
        await fs.link(candidatePath, lockPath);
      } finally {
        await unlinkIfPresent(candidatePath);
      }
    } catch (error) {
      await unlinkIfPresent(candidatePath);
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = await readLockOwner(lockPath);
      if (owner && !isProcessAlive(owner.pid)) {
        await reclaimDeadLock(lockPath);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for the extension autopilot state lock.');
      }
      await delay(STATE_LOCK_RETRY_MS);
      continue;
    }
    try {
      return await operation();
    } finally {
      const owner = await readLockOwner(lockPath);
      if (owner?.token === token) await unlinkIfPresent(lockPath);
    }
  }
}

async function reclaimDeadLock(lockPath: string): Promise<void> {
  const reclaimPath = `${lockPath}.reclaiming`;
  try {
    // A fixed rename target makes reclamation atomic: concurrent reclaimers cannot
    // apply an old dead-owner decision to a newly acquired live lock.
    await fs.rename(lockPath, reclaimPath);
    await unlinkIfPresent(reclaimPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'EEXIST' && code !== 'EPERM') throw error;
  }
}

async function writeStateAtomically(
  statePath: string,
  state: PersistedAutopilotState,
): Promise<void> {
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await fs.rename(temporaryPath, statePath);
  } finally {
    await unlinkIfPresent(temporaryPath);
  }
}

async function readLockOwner(lockPath: string): Promise<{ pid: number; token: string } | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(lockPath, 'utf8')) as Record<string, unknown>;
    return Number.isSafeInteger(value.pid) && typeof value.token === 'string'
      ? { pid: value.pid as number, token: value.token }
      : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  await fs.unlink(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

function grantFor(check: PermissionCheck): {
  principalId: string;
  permission: string;
  capability: string;
} {
  return {
    principalId: check.context.principal.id,
    permission: '*',
    capability: check.capability.name,
  };
}

function cloneState(state: PersistedAutopilotState): PersistedAutopilotState {
  return {
    version: STATE_VERSION,
    globalEnabled: state.globalEnabled,
    extensions: Object.fromEntries(Object.entries(state.extensions).map(([identity, entry]) => [
      identity,
      {
        enabled: entry.enabled,
        capabilityProviderIds: [...entry.capabilityProviderIds],
        contributedCapabilityPrefixes: [...entry.contributedCapabilityPrefixes],
      },
    ])),
  };
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function readState(statePath: string): Promise<PersistedAutopilotState> {
  try {
    const stat = await fs.stat(statePath);
    if (stat.size > MAX_STATE_BYTES) throw new Error('Extension autopilot state is too large.');
    return normalizeState(JSON.parse(await fs.readFile(statePath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw error;
  }
}

function normalizeState(value: unknown): PersistedAutopilotState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyState();
  const record = value as Record<string, unknown>;
  const rawExtensions = record.extensions && typeof record.extensions === 'object'
    && !Array.isArray(record.extensions)
    ? record.extensions as Record<string, unknown>
    : {};
  const extensions: PersistedAutopilotState['extensions'] = {};
  for (const [identity, rawEntry] of Object.entries(rawExtensions).slice(0, MAX_EXTENSIONS)) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue;
    const entry = rawEntry as Record<string, unknown>;
    extensions[requireIdentity(identity)] = {
      enabled: entry.enabled === true,
      capabilityProviderIds: normalizeProviderIds(
        Array.isArray(entry.capabilityProviderIds) ? entry.capabilityProviderIds : [],
      ),
      contributedCapabilityPrefixes: normalizeCapabilityPrefixes(
        Array.isArray(entry.contributedCapabilityPrefixes) ? entry.contributedCapabilityPrefixes : [],
      ),
    };
  }
  return { version: STATE_VERSION, globalEnabled: record.globalEnabled === true, extensions };
}

function emptyState(): PersistedAutopilotState {
  return { version: STATE_VERSION, globalEnabled: false, extensions: {} };
}

function requireIdentity(identity: string): string {
  const value = identity.trim();
  if (!value || value.length > 256) throw new Error('Extension identity is invalid.');
  return value;
}

function normalizeProviderIds(values: readonly unknown[]): string[] {
  return [...new Set(values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value.length <= 256))]
    .slice(0, MAX_PROVIDER_IDS)
    .sort();
}

function normalizeCapabilityPrefixes(values: readonly unknown[]): string[] {
  return [...new Set(values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value.length <= 256))]
    .slice(0, MAX_PROVIDER_IDS)
    .sort();
}
