import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface CodexHarnessIdentity {
  readonly harnessId: 'codex';
  readonly installationId: string;
  readonly profileId?: string;
  readonly userId?: string;
  readonly agentId?: string;
}

export interface CodexPrincipal {
  readonly id: string;
  readonly kind: string;
  readonly claims?: Readonly<Record<string, unknown>>;
}

type ConfiguredIdentity = Readonly<{
  installationId?: unknown;
  profileId?: unknown;
  userId?: unknown;
  agentId?: unknown;
}> | undefined;

/** Resolve only adapter-owned, stable identity inputs; task IDs never partition users. */
export function resolveCodexHarnessIdentity(
  configured?: ConfiguredIdentity,
  environment: NodeJS.ProcessEnv = process.env,
): CodexHarnessIdentity {
  const installation = codexInstallationIdentity(environment);
  const installationId = stableIdentifier(configured?.installationId)
    ?? installation.installationId;
  const profileId = stableIdentifier(configured?.profileId)
    ?? stableIdentifier(environment.MARSHAL_RUNTIME_PROFILE_ID);
  const userId = stableIdentifier(configured?.userId)
    ?? stableIdentifier(environment.MARSHAL_RUNTIME_USER_ID);
  const agentId = stableIdentifier(configured?.agentId);
  return {
    ...installation,
    installationId,
    ...(profileId ? { profileId } : {}),
    ...(userId ? { userId } : {}),
    ...(agentId ? { agentId } : {}),
  };
}

/**
 * Bind durable ownership to the strongest stable profile/user identity exposed
 * by the adapter. Without one, the boundary is explicitly one local Codex
 * installation and must not be represented as multi-user isolation.
 */
export function resolveCodexPrincipal(
  configured: CodexPrincipal | undefined,
  identity: CodexHarnessIdentity,
): CodexPrincipal {
  if (configured) return configured;
  const owner = identity.userId ?? identity.profileId;
  if (owner) {
    const source = identity.userId ? 'user' : 'profile';
    return {
      id: `codex-${source}-${digest(`${identity.installationId}:${owner}`)}`,
      kind: 'agent',
      claims: {
        ownershipBoundary: source,
        multiProfileIsolation: true,
      },
    };
  }
  return {
    id: `codex-installation-local-${digest(identity.installationId)}`,
    kind: 'agent',
    claims: {
      ownershipBoundary: 'installation-local-single-user',
      multiProfileIsolation: false,
    },
  };
}

export function codexInstallationIdentity(
  environment: NodeJS.ProcessEnv = process.env,
): Pick<CodexHarnessIdentity, 'harnessId' | 'installationId'> {
  const root = resolve(environment.CODEX_HOME?.trim() || join(homedir(), '.codex'));
  return {
    harnessId: 'codex',
    installationId: `codex-installation-${digest(normalizePath(root))}`,
  };
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function normalizePath(value: string): string {
  return process.platform === 'win32' ? value.toLocaleLowerCase() : value;
}

function stableIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, 512)
    : undefined;
}
