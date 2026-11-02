import { join, resolve } from 'node:path';
import type {
  InvocationContext,
  PermissionBroker,
  RuntimeCatalogProvider,
  RuntimeExecResponse,
  RuntimeExecuteRequest,
} from '@marshal/agent-runtime-core';
import type { RuntimeServiceAccessor } from '@marshal/agent-runtime-composer';
import { UiActionDispatcher } from './actionDispatcher.js';
import type {
  UiActionDispatcherOptions,
  UiDeclaredToolExecutionPort,
} from './applicationTypes.js';
import { ReactUiCompiler, type ReactUiCompilerOptions } from './compiler.js';
import { ReactUiMcpAppsResourceAdapter } from './mcpAppsAdapter.js';
import { ReactUiProvider } from './provider.js';
import { listAuthoredRenderApplications } from './publishedApplications.js';
import { ReactUiStore, type ReactUiStoreOptions } from './store.js';
import { UiDeclaredToolDispatcher } from './toolDispatcher.js';
import { ReactUiWorkspaceCoordinator } from './workspaceCoordinator.js';
import { REACT_UI_TEMPLATE_URI } from './runtimeRenderer.js';
import { ReactUiAuthoredStateProvider } from './authored-state/provider.js';
import { ReactUiAuthoredStateStore } from './authored-state/store.js';
import { RUNTIME_AUTHORED_UI_STATE_SERVICE, type RuntimeAuthoredUiStateService } from './authored-state/contracts.js';

export interface CreateReactUiCapabilitiesOptions
  extends Omit<ReactUiCompilerOptions, 'workspacePath'> {
  workspacePath: string;
  stateRoot: string;
  storeLimits?: Omit<ReactUiStoreOptions, 'storageRoot'>;
  maxPropsBytes?: number;
  actionRuntime?: Omit<UiActionDispatcherOptions, 'loadApplication'>;
  toolRuntime?: UiDeclaredToolExecutionPort;
  permissionBroker?: PermissionBroker;
  operationInvoker?: ReactUiOperationInvoker;
  serviceAccessor?: RuntimeServiceAccessor;
}

export interface ReactUiOperationInvoker {
  execute(
    request: RuntimeExecuteRequest,
    context: InvocationContext,
  ): Promise<RuntimeExecResponse>;
}

export function createReactUiCapabilities(options: CreateReactUiCapabilitiesOptions) {
  const store = new ReactUiStore({
    storageRoot: join(resolve(options.stateRoot), 'react-ui'),
    ...options.storeLimits,
  });
  const compiler = new ReactUiCompiler({
    workspacePath: options.workspacePath,
    allowedPackages: options.allowedPackages,
    authoringProfiles: options.authoringProfiles,
    preferredAuthoringProfile: options.preferredAuthoringProfile,
    hostCapabilities: options.hostCapabilities,
    packageImportResolver: options.packageImportResolver,
    trustedPackageRoots: options.trustedPackageRoots,
    registeredComponents: options.registeredComponents,
    maxSourceBytes: options.maxSourceBytes,
    maxBundleBytes: options.maxBundleBytes,
    buildObserver: options.buildObserver,
  });
  const provider = new ReactUiProvider({ compiler, store, maxPropsBytes: options.maxPropsBytes });
  const authoredStateService: RuntimeAuthoredUiStateService = new ReactUiAuthoredStateStore({
    storageRoot: join(resolve(options.stateRoot), 'authored-state'),
  });
  const authoredStateProvider = new ReactUiAuthoredStateProvider(options.serviceAccessor ?? authoredStateService);
  const workspaceCoordinator = new ReactUiWorkspaceCoordinator(compiler, store);
  const defaultActionRuntime =
    options.permissionBroker && options.operationInvoker
      ? createDefaultActionRuntime(options.permissionBroker, options.operationInvoker)
      : undefined;
  const actionRuntime = options.actionRuntime ?? defaultActionRuntime;
  const toolRuntime = options.toolRuntime ?? (
    options.operationInvoker
      ? createDefaultToolRuntime(options.operationInvoker)
      : undefined
  );
  const actionDispatcher = actionRuntime
    ? new UiActionDispatcher({
        ...actionRuntime,
        idempotencyStore: actionRuntime.idempotencyStore ?? store,
        journalStore: actionRuntime.journalStore ?? store,
        loadApplication: async (renderId, context) =>
          (await store.getRender(renderId, context)).application,
      })
    : undefined;
  const toolDispatcher = toolRuntime
    ? new UiDeclaredToolDispatcher({
        executor: toolRuntime,
        loadApplication: async (renderId, context) =>
          (await store.getRender(renderId, context)).application,
      })
    : undefined;
  const resources = new ReactUiMcpAppsResourceAdapter(store, actionDispatcher, toolDispatcher, workspaceCoordinator);
  const catalog: RuntimeCatalogProvider = {
    id: 'marshal.react-ui-catalog',
    async list(context) {
      const renders = await store.listRenders(context);
      return Promise.all(renders.map(async (render) => {
        const component = await store.getComponent(render.componentId, context);
        return {
          id: `ui://marshal-react/render/${render.id}`,
          kind: 'ui_application' as const,
          title: component.title,
          description: render.fallback.summary,
          tags: ['ui', 'application', 'react'],
          action: {
            type: 'ui_render' as const,
            renderId: render.id,
            resourceUri: REACT_UI_TEMPLATE_URI,
          },
          metadata: {
            componentId: component.id,
            presentationModes: render.application?.presentationModes ?? ['inline'],
            authoringProfile: component.authoringProfile,
            live: render.workspace !== undefined,
          },
        };
      }));
    },
  };
  return {
    provider,
    providers: [provider, authoredStateProvider],
    authoredStateService,
    authoredStateServiceToken: RUNTIME_AUTHORED_UI_STATE_SERVICE,
    authoredStateProvider,
    compiler,
    store,
    resources,
    catalog,
    actionDispatcher,
    toolDispatcher,
    workspaceCoordinator,
    /** Authored renders projected as published applications for host surface placement. */
    publishedApplications: (context: InvocationContext) =>
      listAuthoredRenderApplications(store, context),
  };
}

function createDefaultActionRuntime(
  permissionBroker: PermissionBroker,
  operationInvoker: ReactUiOperationInvoker,
): Omit<UiActionDispatcherOptions, 'loadApplication'> {
  return {
    authorize: {
      authorize(request, context) {
        const target = request.action.target.kind === 'capability'
          ? request.action.target.capability
          : request.action.target.executorCapability ?? 'runtime.module.execute';
        const requirements = request.action.requiredPermissions.map((permission) => ({
          permission,
          reason: `Declared requirement for UI action ${request.action.id}.`,
          risk: request.action.risk === 'external-effect'
            ? 'high' as const
            : request.action.risk === 'write'
              ? 'medium' as const
              : 'low' as const,
        }));
        return permissionBroker.decide({
          capability: {
            protocolVersion: '1.0.0',
            name: target,
            version: request.action.version,
            title: request.action.title,
            description:
              request.action.description ?? `Backend for UI action ${request.action.id}.`,
            inputSchema: request.action.inputSchema,
            outputSchema: request.action.outputSchema,
            permissions: requirements,
            provider: { id: 'marshal.ui.action', version: '1.0.0' },
          },
          request: {
            protocolVersion: '1.0.0',
            target,
            input: request.input,
            approval: request.approval,
          },
          context,
          requirements,
        });
      },
    },
    executor: {
      async execute(request, context) {
        if (request.action.target.kind === 'capability') {
          return operationInvoker.execute({
            protocolVersion: '1.0.0',
            targetType: 'operation',
            target: request.action.target.capability,
            input: request.input,
            requestId: request.targetIdempotencyKey,
            approval: request.approval,
          }, context);
        }
        if (request.action.target.executorCapability) {
          const executed = await operationInvoker.execute({
            protocolVersion: '1.0.0',
            targetType: 'operation',
            target: request.action.target.executorCapability,
            input: { module: request.action.target.module, input: request.input },
            requestId: request.targetIdempotencyKey,
            approval: request.approval,
          }, context);
          return unwrapModuleActionResponse(executed);
        }
        const executed = await operationInvoker.execute({
          protocolVersion: '1.0.0',
          targetType: 'module',
          module: request.action.target.module,
          input: request.input,
          requestId: request.targetIdempotencyKey,
          approval: request.approval,
        }, context);
        return unwrapModuleActionResponse(executed);
      },
    },
  };
}

function createDefaultToolRuntime(
  operationInvoker: ReactUiOperationInvoker,
): UiDeclaredToolExecutionPort {
  return {
    execute(tool, input, context) {
      return operationInvoker.execute({
        protocolVersion: '1.0.0',
        targetType: 'operation',
        target: tool.name,
        input,
      }, context);
    },
  };
}

function unwrapModuleActionResponse(response: RuntimeExecResponse): RuntimeExecResponse {
  const output = response.result?.output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return response;
  const module = output as Record<string, unknown>;
  if (module.ok === true && 'value' in module) {
    return {
      ...response,
      result: { ...response.result, output: module.value },
    };
  }
  if (module.ok === false) {
    const error = module.error && typeof module.error === 'object' && !Array.isArray(module.error)
      ? module.error as Record<string, unknown>
      : {};
    return {
      ...response,
      status: 'failed',
      error: {
        code: typeof error.code === 'string' ? error.code : 'ui_module_action_failed',
        message: typeof error.message === 'string'
          ? error.message
          : 'Editable UI backend failed.',
      },
    };
  }
  return response;
}
