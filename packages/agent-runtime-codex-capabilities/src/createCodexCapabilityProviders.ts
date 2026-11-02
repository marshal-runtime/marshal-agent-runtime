import { join, resolve } from 'node:path';
import {
  DelegationManager,
  createRuntimeDelegationProvider,
} from '@marshal/agent-runtime-delegation';
import {
  FileDelegationStore,
} from '@marshal/agent-runtime-effects';
import type { RuntimeCatalogProvider } from '@marshal/agent-runtime-core';
import {
  createReactUiCapabilities,
  type CreateReactUiCapabilitiesOptions,
  type UiRenderToolDescriptor,
  type UiRenderToolResult,
} from '@marshal/agent-runtime-ui';
import {
  createDeclarativeUiCapabilities as createPortableDeclarativeUiCapabilities,
} from '@marshal/agent-runtime-ui/declarative';
import type {
  CapabilityProvider,
  InvocationContext,
  JsonObject,
} from './coreTypes.js';
import {
  CodexAppServerBackend,
  type CodexAppServerBackendOptions,
} from './subagents/codexAppServerBackend.js';
import { CopilotCliBackend, type CopilotCliBackendOptions } from './subagents/copilotCliBackend.js';
import { SelectableSubagentBackend } from './subagents/selectableBackend.js';
import { GitWorktreeProvisioner } from './subagents/gitWorktreeProvisioner.js';
import { CodexSubagentProvider, type CodexSubagentProviderOptions } from './subagents/provider.js';
import { CodexDelegationAdapter } from './subagents/delegationAdapter.js';
import type { SubagentBackend, WorktreeProvisioner } from './subagents/types.js';
import type { SubagentScopeInheritancePersister } from './subagents/types.js';
import { DeclarativeUiMcpAppsResourceAdapter } from './ui/mcpAppsResourceAdapter.js';
import { DeclarativeUiProvider } from './ui/provider.js';
import { DeclarativeUiStore, type DeclarativeUiStoreOptions } from './ui/store.js';
import type { UiOperationInvoker } from './ui/types.js';
import { CompositeMcpAppsResourceAdapter } from './ui/compositeMcpAppsResourceAdapter.js';
import {
  CODEX_OPENAI_UI_AUTHORING_PROFILE,
  CODEX_UI_HOST_CAPABILITIES,
  resolveCodexUiPackageImport,
} from './ui/authoringProfile.js';

export interface CreateCodexCapabilityProvidersOptions {
  workspacePath: string;
  stateRoot: string;
  /** Harness-owned executable UI state may live outside the agent-writable workspace state. */
  reactUiStateRoot?: string;
  subagentBackend?: SubagentBackend;
  subagentDefaultBackend?: 'codex' | 'copilot';
  codexAppServer?: Omit<CodexAppServerBackendOptions, 'workspaceRoot' | 'additionalWorkspaceRoots'>;
  copilotCli?: Omit<CopilotCliBackendOptions, 'workspaceRoot' | 'additionalWorkspaceRoots'>;
  worktreeRoot?: string;
  worktreeProvisioner?: WorktreeProvisioner;
  persistScopeInheritance?: SubagentScopeInheritancePersister;
  delegation?: {
    enabled?: boolean;
    exposeRawCodexSubagents?: boolean;
  };
  operationInvoker?: UiOperationInvoker;
  allowedUiOperations?: readonly string[];
  allowUiOperation?: (operation: string) => boolean;
  uiLimits?: Omit<DeclarativeUiStoreOptions, 'storageRoot'>;
  declarativeUi?: { enabled?: boolean };
  reactUi?: Omit<CreateReactUiCapabilitiesOptions, 'workspacePath' | 'stateRoot'> & {
    enabled?: boolean;
    /** Disable only when testing a standards-only/alternate adapter projection. */
    includeCodexAuthoringProfile?: boolean;
  };
}

export interface CodexCapabilityProviderBundle {
  providers: CapabilityProvider[];
  subagents: CodexSubagentProvider;
  delegation?: {
    adapter: CodexDelegationAdapter;
    manager: DelegationManager;
    store: FileDelegationStore;
    provider: CapabilityProvider;
  };
  ui?: DeclarativeUiMcpAppsResourceAdapter;
  /** Alias with an integration-specific name for MCP server resource binding. */
  mcpAppsResources?: CodexMcpAppsResources;
  uiProvider?: DeclarativeUiProvider;
  uiStore?: DeclarativeUiStore;
  reactUi?: ReturnType<typeof createReactUiCapabilities>;
  catalog?: RuntimeCatalogProvider;
  dispose(): Promise<void>;
}

export interface CodexMcpAppsResources {
  readonly templateUri: string;
  listResources(context: InvocationContext): Promise<readonly {
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
  }[]>;
  readResource(uri: string, context: InvocationContext): Promise<{
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  }>;
  toolMetadata?(): JsonObject;
  reactToolMetadata?(): UiRenderToolDescriptor['_meta'];
  listRenderTools?(context: InvocationContext): Promise<UiRenderToolDescriptor[]>;
  invokeRenderTool?(
    name: string,
    input: unknown,
    context: InvocationContext,
  ): Promise<UiRenderToolResult | undefined>;
}

export interface CodexCapabilityProviderBundleWithDeclarativeUi
  extends CodexCapabilityProviderBundle {
  ui: DeclarativeUiMcpAppsResourceAdapter;
  mcpAppsResources:
    | DeclarativeUiMcpAppsResourceAdapter
    | CompositeMcpAppsResourceAdapter;
  uiProvider: DeclarativeUiProvider;
  uiStore: DeclarativeUiStore;
}

export function createCodexCapabilityProviders(
  options: CreateCodexCapabilityProvidersOptions & {
    readonly declarativeUi?: { readonly enabled?: true };
  },
): CodexCapabilityProviderBundleWithDeclarativeUi;
export function createCodexCapabilityProviders(
  options: CreateCodexCapabilityProvidersOptions,
): CodexCapabilityProviderBundle;
export function createCodexCapabilityProviders(
  options: CreateCodexCapabilityProvidersOptions,
): CodexCapabilityProviderBundle {
  const workspacePath = resolve(options.workspacePath);
  const worktreeRoot = options.worktreeRoot ? resolve(options.worktreeRoot) : undefined;
  const ownedCodexBackend = options.subagentBackend
    ? undefined
    : new CodexAppServerBackend({
        workspaceRoot: workspacePath,
        additionalWorkspaceRoots: worktreeRoot ? [worktreeRoot] : undefined,
        ...options.codexAppServer,
      });
  const ownedCopilotBackend = options.subagentBackend
    ? undefined
    : new CopilotCliBackend({
        workspaceRoot: workspacePath,
        additionalWorkspaceRoots: worktreeRoot ? [worktreeRoot] : undefined,
        ...options.copilotCli,
      });
  const ownedBackend = options.subagentBackend
    ? undefined
    : new SelectableSubagentBackend(
        ownedCodexBackend!,
        ownedCopilotBackend!,
        options.subagentDefaultBackend ?? 'codex',
      );
  const backend = options.subagentBackend ?? ownedBackend!;
  const provisioner =
    options.worktreeProvisioner ??
    (worktreeRoot
      ? new GitWorktreeProvisioner({ workspaceRoot: workspacePath, worktreeRoot })
      : undefined);
  const subagents = new CodexSubagentProvider({
    backend,
    workspaceRoot: workspacePath,
    worktreeProvisioner: provisioner,
    additionalWorkspaceRoots: worktreeRoot ? [worktreeRoot] : undefined,
    persistScopeInheritance: options.persistScopeInheritance,
  });
  const delegation =
    options.delegation?.enabled === false
      ? undefined
      : (() => {
          const adapter = new CodexDelegationAdapter({
            backend,
            workspaceRoot: workspacePath,
            worktreeProvisioner: provisioner,
            additionalWorkspaceRoots: worktreeRoot ? [worktreeRoot] : undefined,
            persistScopeInheritance: options.persistScopeInheritance,
          });
          const store = new FileDelegationStore({
            rootDirectory: join(resolve(options.stateRoot), 'delegation'),
          });
          const manager = new DelegationManager({
            adapter,
            store,
          });
          return {
            adapter,
            store,
            manager,
            provider: createRuntimeDelegationProvider({ manager }),
          };
        })();
  const declarativeUi = options.declarativeUi?.enabled === false
    ? undefined
    : createPortableDeclarativeUiCapabilities({
        stateRoot: options.stateRoot,
        storeLimits: options.uiLimits,
        operationInvoker: options.operationInvoker,
        allowedOperations: options.allowedUiOperations,
        allowOperation: options.allowUiOperation,
      });
  const reactUi = createCodexReactUiCapabilities(options, workspacePath);
  const reactOnlyResources: CodexMcpAppsResources | undefined = reactUi
    ? {
        templateUri: reactUi.resources.templateUri,
        listResources: (context) => reactUi.resources.listResources(context),
        readResource: (uri, context) => reactUi.resources.readResource(uri, context),
        reactToolMetadata: () => reactUi.resources.toolMetadata(),
        listRenderTools: (context) => reactUi.resources.listRenderTools(context),
        invokeRenderTool: (name, input, context) =>
          reactUi.resources.invokeRenderTool(name, input, context),
      }
    : undefined;
  const mcpAppsResources = declarativeUi && reactUi
    ? new CompositeMcpAppsResourceAdapter(declarativeUi.resources, reactUi.resources)
    : declarativeUi?.resources ?? reactOnlyResources;
  return {
    providers: [
      ...(options.delegation?.exposeRawCodexSubagents ? [subagents] : []),
      ...(delegation ? [delegation.provider] : []),
      ...(declarativeUi ? [declarativeUi.provider] : []),
      ...(reactUi ? [reactUi.provider] : []),
    ],
    subagents,
    delegation,
    ui: declarativeUi?.resources,
    mcpAppsResources,
    uiProvider: declarativeUi?.provider,
    uiStore: declarativeUi?.store,
    reactUi,
    catalog: composeCatalogProviders([
      ...(declarativeUi ? [declarativeUi.catalog] : []),
      ...(reactUi ? [reactUi.catalog] : []),
    ]),
    async dispose() {
      await ownedBackend?.dispose();
    },
  };
}

function composeCatalogProviders(
  providers: readonly RuntimeCatalogProvider[],
): RuntimeCatalogProvider | undefined {
  if (providers.length === 0) return undefined;
  if (providers.length === 1) return providers[0];
  return {
    id: 'marshal.codex-ui-catalog',
    async list(context) {
      const entries = (await Promise.all(providers.map((provider) => provider.list(context)))).flat();
      const seen = new Set<string>();
      for (const entry of entries) {
        if (seen.has(entry.id)) throw new Error(`Duplicate Codex UI catalog id: ${entry.id}`);
        seen.add(entry.id);
      }
      return entries;
    },
  };
}

function createCodexReactUiCapabilities(
  options: CreateCodexCapabilityProvidersOptions,
  workspacePath: string,
): ReturnType<typeof createReactUiCapabilities> | undefined {
  if (options.reactUi?.enabled === false) return undefined;
  const {
    enabled: _enabled,
    includeCodexAuthoringProfile = true,
    authoringProfiles,
    preferredAuthoringProfile,
    hostCapabilities,
    packageImportResolver,
    trustedPackageRoots,
    ...reactUiOptions
  } = options.reactUi ?? {};
  const resolvePackage = includeCodexAuthoringProfile
    ? (specifier: string) =>
        packageImportResolver?.(specifier) ?? resolveCodexUiPackageImport(specifier)
    : packageImportResolver;
  return createReactUiCapabilities({
    workspacePath,
    stateRoot: options.reactUiStateRoot ?? options.stateRoot,
    ...reactUiOptions,
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
    trustedPackageRoots: [
      ...(trustedPackageRoots ?? []),
    ],
  });
}

export function createCodexSubagentProvider(
  options: CodexSubagentProviderOptions,
): CodexSubagentProvider {
  return new CodexSubagentProvider(options);
}

export function createDeclarativeUiCapabilities(options: {
  store: DeclarativeUiStore;
  operationInvoker?: UiOperationInvoker;
  allowedOperations?: readonly string[];
  allowOperation?: (operation: string) => boolean;
}): { provider: DeclarativeUiProvider; resources: DeclarativeUiMcpAppsResourceAdapter } {
  const resources = new DeclarativeUiMcpAppsResourceAdapter(options.store);
  return {
    provider: new DeclarativeUiProvider({
      store: options.store,
      resources,
      operationInvoker: options.operationInvoker,
      allowedOperations: options.allowedOperations,
      allowOperation: options.allowOperation,
    }),
    resources,
  };
}
