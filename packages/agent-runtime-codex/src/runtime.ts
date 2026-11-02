import {
  CODEX_OPENAI_UI_AUTHORING_PROFILE,
  CODEX_UI_HOST_CAPABILITIES,
  createCodexCapabilityProviders,
  createFileBackedReactUiRecordAuthenticator,
  resolveCodexUiPackageImport,
  type CreateCodexCapabilityProvidersOptions,
} from '@marshal/agent-runtime-codex-capabilities';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createAgentRuntime,
  createPackageDiscoverySource,
  createRuntimeBuiltinsSource,
  type AgentRuntimeBindings,
  type AgentRuntimeHostOptions,
  type RuntimeReactUiSourceOptions,
  type RuntimeHostProviderSource,
} from '@marshal/agent-runtime-host';
import {
  RUNTIME_DELEGATION_CHILD_SCOPE_LINEAGE_SERVICE,
} from '@marshal/agent-runtime-delegation';
import {
  codexInstallationIdentity,
  resolveCodexHarnessIdentity,
  resolveCodexPrincipal,
} from './identity.js';
import type { RepositoryIdentity } from '@quillstone/repository-registry-config';
import type { RuntimeSessionBriefingOptions } from '@marshal/agent-runtime-host/session-briefing';
import {
  codexExtensionAutopilotStatePath,
  codexProtectedLifecycleResultRoot,
  codexRuntimeExtensionRoot,
  codexRuntimeExtensionRoots,
  codexUiAuthorityKeyPath,
  codexUiStateRoot,
} from './runtimePaths.js';
import { CODEX_PACKAGE_DECLARATIONS } from './packageDeclarations.js';
import { createCodexHostToolDiscoverySource } from './catalog.js';
import { registerCodexDebuggerHostAdapter } from './debuggerHost.js';
import { resolveGitTrustedProjectId } from './projectIdentity.js';
import { CodexExtensionAutopilotPolicy } from './extensionAutopilot.js';
import { RUNTIME_EXTENSION_LIFECYCLE_SERVICE } from '@marshal/agent-runtime-extensions';

export { resolveGitTrustedProjectId } from './projectIdentity.js';

type AdapterCapabilityOptions = Omit<
  CreateCodexCapabilityProvidersOptions,
  'workspacePath' | 'stateRoot' | 'worktreeRoot' | 'operationInvoker' | 'allowUiOperation'
>;

export interface CodexRuntimeHostOptions extends AgentRuntimeHostOptions {
  /** Adapter-owned subagent and UI capability configuration. */
  readonly capabilities?: AdapterCapabilityOptions;
  readonly repositoryIdentity?: RepositoryIdentity;
  readonly sessionBriefingOptions?: RuntimeSessionBriefingOptions;
}

export interface CodexRuntimeBindings extends AgentRuntimeBindings {
  readonly extensionAutopilot: CodexExtensionAutopilotPolicy;
}

/** Compose the portable host with only the capabilities required by Codex. */
export async function createCodexRuntime(
  options: CodexRuntimeHostOptions = {},
): Promise<CodexRuntimeBindings> {
  const installedExtensionRoot = codexRuntimeExtensionRoot();
  const configuredExtensionRoots = codexRuntimeExtensionRoots();
  const extensions = options.extensions === undefined
    ? {
        allowedRoots: configuredExtensionRoots,
        discoveryRoots: configuredExtensionRoots,
      }
    : options.extensions;
  if (extensions !== false && options.extensions === undefined) {
    await mkdir(installedExtensionRoot, { recursive: true });
  }
  const permissionProfile = resolveCodexPermissionProfile(options.permissionProfile);
  const identity = resolveCodexHarnessIdentity(options.identity);
  const principal = resolveCodexPrincipal(options.principal, identity);
  const trustedProjectId = (
    options.trustedProjectId?.trim()
    || options.repositoryIdentity?.repositoryId?.trim()
  ) ?? await resolveGitTrustedProjectId(options.workspacePath ?? process.cwd());
  const configuredCapabilities = resolveCapabilityOptions(options.capabilities);
  const extensionAutopilot = await CodexExtensionAutopilotPolicy.open(
    codexExtensionAutopilotStatePath(),
  );
  const adapterSource: RuntimeHostProviderSource = async (context) => {
    const persistScopeInheritance = async (
      parent: Parameters<NonNullable<CreateCodexCapabilityProvidersOptions['persistScopeInheritance']>>[0],
      childThreadId: string,
    ) => {
      await context.serviceContainer
        .tryGet(RUNTIME_DELEGATION_CHILD_SCOPE_LINEAGE_SERVICE)
        ?.persistScopeInheritance(parent, childThreadId);
    };
    const capabilities = createCodexCapabilityProviders({
      ...configuredCapabilities,
      workspacePath: context.workspacePath,
      stateRoot: context.stateRoot,
      reactUiStateRoot: configuredCapabilities.reactUiStateRoot ?? codexUiStateRoot(),
      worktreeRoot: context.worktreeRoot,
      operationInvoker: context.operationInvoker,
      allowUiOperation: (operation) => !operation.startsWith('ui.actions.'),
      declarativeUi: { enabled: false },
      delegation: configuredCapabilities.delegation,
      persistScopeInheritance,
      reactUi: { enabled: false },
    });
    let debuggerHost: Awaited<ReturnType<typeof registerCodexDebuggerHostAdapter>>;
    try {
      debuggerHost = await registerCodexDebuggerHostAdapter(
        context.serviceContainer,
        context.compositionRegistry,
      );
    } catch (error) {
      await capabilities.dispose();
      throw error;
    }
    return {
      providers: capabilities.providers,
      ...(capabilities.mcpAppsResources
        ? { resources: capabilities.mcpAppsResources }
        : {}),
      ...(capabilities.catalog ? { catalog: capabilities.catalog } : {}),
      async dispose() {
        const results = await Promise.allSettled([
          capabilities.dispose(),
          debuggerHost.dispose(),
        ]);
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => result.reason);
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(failures, 'Failed to dispose Codex adapter services.');
        }
      },
    };
  };

  const runtime = await createAgentRuntime({
    ...options,
    protectedLifecycleResultRoot:
      options.protectedLifecycleResultRoot ?? codexProtectedLifecycleResultRoot(),
    permissionProfile,
    principal,
    identity,
    resolvePermissionGrants: async (check) => [
      ...(await options.resolvePermissionGrants?.(check) ?? []),
      ...(await extensionAutopilot.resolveGrants(check)),
    ],
    ...(trustedProjectId ? { trustedProjectId } : {}),
    permissionPatterns: [
      'artifacts.*',
      'runtime.inline_module.execute',
      'runtime.module.execute',
      'runtime.jobs.read',
      'runtime.schedules.read',
      'ui.*',
      'runtime.delegation.wait',
      ...(options.permissionPatterns ?? []),
    ],
    trustedPermissionPatterns: [
      'runtime.inline_module.execute.trusted',
      'runtime.module.execute.trusted',
      'trusted_ui',
      'runtime.delegation.*',
      ...(options.trustedPermissionPatterns ?? []),
    ],
    providerSources: [
      adapterSource,
      createRuntimeBuiltinsSource({
        importPolicy: options.importPolicy,
        inlineMaxOutputBytes: options.inlineMaxOutputBytes,
        inlineMaxSourceCharacters: options.inlineMaxSourceCharacters,
        moduleMaxSourceBytes: options.moduleMaxSourceBytes,
        moduleMaxBrokerInvocations: options.moduleMaxBrokerInvocations,
        moduleMaxConcurrentBrokerInvocations: options.moduleMaxConcurrentBrokerInvocations,
        effectHandler: options.effectHandler,
        effectApprovalVerifier: options.effectApprovalVerifier,
        reactUi: options.capabilities?.reactUi?.enabled === false
          ? false
          : (context) => codexReactUiOptions(options, context.workspacePath, permissionProfile),
        declarativeUi: options.capabilities?.declarativeUi?.enabled === false
          ? false
          : {
              stateRoot: contextIndependentCodexUiStateRoot(),
              storeLimits: options.capabilities?.uiLimits,
              allowedOperations: options.capabilities?.allowedUiOperations,
              allowOperation: (operation) => !operation.startsWith('ui.actions.'),
            },
      }),
      createCodexHostToolDiscoverySource(),
      createPackageDiscoverySource(CODEX_PACKAGE_DECLARATIONS),
      ...(options.providerSources ?? []),
    ],
    extensions,
  });
  await extensionAutopilot.syncExtensions(
    runtime.serviceContainer.tryGet(RUNTIME_EXTENSION_LIFECYCLE_SERVICE)?.list() ?? [],
  );
  return Object.assign(runtime, { extensionAutopilot });
}

function contextIndependentCodexUiStateRoot(): string {
  return codexUiStateRoot();
}

function codexReactUiOptions(
  options: CodexRuntimeHostOptions,
  workspacePath: string,
  permissionProfile: NonNullable<CodexRuntimeHostOptions['permissionProfile']>,
): RuntimeReactUiSourceOptions {
  const {
    enabled: _enabled,
    includeCodexAuthoringProfile = true,
    authoringProfiles,
    preferredAuthoringProfile,
    hostCapabilities,
    packageImportResolver,
    trustedPackageRoots,
    storeLimits,
    ...reactUiOptions
  } = options.capabilities?.reactUi ?? {};
  const resolvePackage = includeCodexAuthoringProfile
    ? (specifier: string) =>
        packageImportResolver?.(specifier) ?? resolveCodexUiPackageImport(specifier)
    : packageImportResolver;
  return {
    ...reactUiOptions,
    stateRoot: options.capabilities?.reactUiStateRoot ?? codexUiStateRoot(),
    allowedPackages:
      parseImportAllowlist(process.env.MARSHAL_RUNTIME_ALLOWED_UI_PACKAGES) ??
      (permissionProfile === 'trusted-local'
        ? declaredWorkspaceUiPackages(workspacePath)
        : reactUiOptions.allowedPackages),
    authoringProfiles: [
      ...(includeCodexAuthoringProfile ? [CODEX_OPENAI_UI_AUTHORING_PROFILE] : []),
      ...(authoringProfiles ?? []),
    ],
    preferredAuthoringProfile:
      preferredAuthoringProfile ??
      (includeCodexAuthoringProfile
        ? {
            id: CODEX_OPENAI_UI_AUTHORING_PROFILE.id,
            version: CODEX_OPENAI_UI_AUTHORING_PROFILE.version,
          }
        : undefined),
    hostCapabilities: hostCapabilities ?? CODEX_UI_HOST_CAPABILITIES,
    packageImportResolver: resolvePackage,
    trustedPackageRoots: [...(trustedPackageRoots ?? [])],
    storeLimits: {
      recoverLegacySessionScopes: true,
      recordAuthenticator: createFileBackedReactUiRecordAuthenticator({
        keyPath: codexUiAuthorityKeyPath(),
      }),
      ...storeLimits,
    },
  };
}


function resolveCodexPermissionProfile(
  configured: CodexRuntimeHostOptions['permissionProfile'],
): NonNullable<CodexRuntimeHostOptions['permissionProfile']> {
  if (configured) return configured;
  const profile = process.env.MARSHAL_RUNTIME_PERMISSION_PROFILE;
  if (
    profile === 'trusted-local' ||
    profile === 'bounded-agentic' ||
    profile === 'adaptive-agentic'
  ) return profile;
  return 'default';
}

function resolveCapabilityOptions(
  explicit: AdapterCapabilityOptions | undefined,
): AdapterCapabilityOptions {
  const environmentBackend = parseSubagentBackend(
    process.env.MARSHAL_RUNTIME_SUBAGENT_BACKEND,
  );
  const environmentExecutable = optionalEnvironmentValue(
    process.env.MARSHAL_RUNTIME_COPILOT_EXECUTABLE,
  );
  const environmentYolo = optionalBooleanEnvironmentValue(
    process.env.MARSHAL_RUNTIME_COPILOT_YOLO,
    'MARSHAL_RUNTIME_COPILOT_YOLO',
  );
  const environmentCopilotCli = (
    environmentExecutable === undefined
    && environmentYolo === undefined
  )
    ? undefined
    : {
        ...(environmentExecutable === undefined
          ? {}
          : { executable: environmentExecutable }),
        ...(environmentYolo === undefined ? {} : { yolo: environmentYolo }),
      };
  return {
    ...(environmentBackend === undefined
      ? {}
      : { subagentDefaultBackend: environmentBackend }),
    ...(environmentCopilotCli === undefined
      ? {}
      : { copilotCli: environmentCopilotCli }),
    ...explicit,
    ...(environmentCopilotCli === undefined && explicit?.copilotCli === undefined
      ? {}
      : {
          copilotCli: {
            ...environmentCopilotCli,
            ...explicit?.copilotCli,
          },
        }),
  };
}

function parseSubagentBackend(
  value: string | undefined,
): 'codex' | 'copilot' | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  if (value === 'codex' || value === 'copilot') return value;
  throw new Error(
    'MARSHAL_RUNTIME_SUBAGENT_BACKEND must be "codex" or "copilot".',
  );
}

function optionalEnvironmentValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function optionalBooleanEnvironmentValue(
  value: string | undefined,
  name: string,
): boolean | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw new Error(`${name} must be 1, 0, true, or false.`);
}

export { codexInstallationIdentity };

function parseImportAllowlist(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const packages = [
    ...new Set(
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => entry.slice(0, 256)),
    ),
  ].slice(0, 256);
  if (packages.includes('*')) {
    throw new Error('MARSHAL_RUNTIME_ALLOWED_UI_PACKAGES must name packages explicitly; wildcard authority is unavailable.');
  }
  return packages;
}

/** Full Access trusts packages the project explicitly declares, never arbitrary node_modules paths. */
export function declaredWorkspaceUiPackages(workspacePath: string): readonly string[] {
  try {
    const manifest = JSON.parse(readFileSync(resolve(workspacePath, 'package.json'), 'utf8')) as Record<string, unknown>;
    const names = new Set<string>();
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const values = manifest[field];
      if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
      for (const name of Object.keys(values as Record<string, unknown>)) {
        if (/^(?:@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)$/.test(name)) names.add(name);
      }
    }
    return [...names].sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`Could not derive trusted-local UI package authority from workspace package.json: ${error instanceof Error ? error.message : String(error)}`);
  }
}
