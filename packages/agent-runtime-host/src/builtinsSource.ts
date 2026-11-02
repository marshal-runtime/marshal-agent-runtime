import { join } from 'node:path';
import type {
  CapabilityProvider,
  RuntimeCatalogProvider,
  RuntimeEffectHandler,
} from '@marshal/agent-runtime-core';
import {
  BoundedFileEffectReplayStore,
  composeEffectHandlers,
  createRuntimeEffectsProvider,
  createRuntimeSchedulingProvider,
  EffectDispatcher,
  type RuntimeEffectApprovalVerifier,
  type RuntimeScheduleService,
} from '@marshal/agent-runtime-effects';
import { createArtifactProvider } from '@marshal/agent-runtime-provider-artifacts';
import {
  createReactUiCapabilities,
  type CreateReactUiCapabilitiesOptions,
  RUNTIME_AUTHORED_UI_STATE_SERVICE,
} from '@marshal/agent-runtime-ui';
import {
  createTypeScriptExtensionAuthoringBundle,
} from '@marshal/agent-runtime-typescript';
import {
  createRuntimeAuthoredUiPromotionBundle,
  RUNTIME_AUTHORED_UI_PROMOTION_SERVICE,
} from '@marshal/agent-runtime-extensions';
import {
  createDeclarativeUiCapabilities,
  type CreateDeclarativeUiCapabilitiesOptions,
} from '@marshal/agent-runtime-ui/declarative';
import {
  createBrokeredInlineModuleProvider,
  type InlineModuleProviderOptions,
} from './inlineProvider.js';
import type {
  RuntimeHostImportPolicy,
  RuntimeHostProviderSource,
  RuntimeScopedResourcePort,
} from './types.js';

export interface RuntimeBuiltinsSourceOptions {
  readonly artifacts?: boolean;
  readonly typescript?: boolean;
  readonly extensionAuthoring?: boolean;
  readonly authoredUiPromotion?: boolean;
  readonly effects?: boolean;
  readonly scheduling?: boolean;
  readonly reactUi?:
    | false
    | RuntimeReactUiSourceOptions
    | ((context: Parameters<RuntimeHostProviderSource>[0]) => RuntimeReactUiSourceOptions);
  readonly declarativeUi?:
    | false
    | RuntimeDeclarativeUiSourceOptions
    | ((context: Parameters<RuntimeHostProviderSource>[0]) => RuntimeDeclarativeUiSourceOptions);
  readonly nodeExecutable?: string;
  readonly importPolicy?: RuntimeHostImportPolicy;
  readonly inlineMaxOutputBytes?: number;
  readonly inlineMaxSourceCharacters?: number;
  readonly moduleMaxSourceBytes?: number;
  readonly moduleMaxBrokerInvocations?: number;
  readonly moduleMaxConcurrentBrokerInvocations?: number;
  readonly effectHandler?: RuntimeEffectHandler;
  /** Runtime-owned clock for `runtime.schedules.*`; other effect kinds still go to `effectHandler`. */
  readonly scheduler?: RuntimeScheduleService;
  readonly effectApprovalVerifier?: RuntimeEffectApprovalVerifier;
}

export type RuntimeReactUiSourceOptions = Omit<
  CreateReactUiCapabilitiesOptions,
  'workspacePath' | 'stateRoot' | 'permissionBroker' | 'operationInvoker' | 'serviceAccessor'
> & {
  readonly stateRoot?: string;
};

export type RuntimeDeclarativeUiSourceOptions = Omit<
  CreateDeclarativeUiCapabilitiesOptions,
  'stateRoot' | 'operationInvoker'
> & {
  readonly stateRoot?: string;
};

/** Explicit startup source for portable runtime-owned capabilities. */
export function createRuntimeBuiltinsSource(
  options: RuntimeBuiltinsSourceOptions = {},
): RuntimeHostProviderSource {
  return async (context) => {
    const providers: CapabilityProvider[] = [];
    const serviceBindings: Array<{ dispose(): Promise<void> }> = [];
    const catalogSources: import('@marshal/agent-runtime-extensions').RuntimeExtensionCatalogSource[] = [];
    let moduleProvider: ReturnType<typeof createBrokeredInlineModuleProvider> | undefined;
    let authoringBundle: ReturnType<typeof createTypeScriptExtensionAuthoringBundle> | undefined;
    let promotionBundle: ReturnType<typeof createRuntimeAuthoredUiPromotionBundle> | undefined;
    try {
    if (options.artifacts !== false) {
      providers.push(
        createArtifactProvider({
          rootDirectory: join(context.stateRoot, 'artifacts'),
        }),
      );
    }
    const effects = new EffectDispatcher({
      handler: composeEffectHandlers(
        [options.scheduler, options.effectHandler].filter(
          (handler): handler is RuntimeEffectHandler => handler !== undefined,
        ),
      ),
      approvalVerifier: options.effectApprovalVerifier,
      replay: new BoundedFileEffectReplayStore({
        rootDirectory: join(context.stateRoot, 'effects', 'replay'),
      }),
    });
    if (options.effects !== false) {
      providers.push(
        createRuntimeEffectsProvider({
          effects,
          jobs: context.jobManager,
        }),
      );
    }
    if (options.scheduling !== false) {
      providers.push(createRuntimeSchedulingProvider({ effects }));
    }
    if (options.typescript !== false) {
      const runtime: InlineModuleProviderOptions['runtime'] = {
        search: (request, invocationContext) =>
          context.operationInvoker.search(request, invocationContext),
        execute: (request, invocationContext) =>
          context.operationInvoker.execute(request, invocationContext),
      };
      moduleProvider = createBrokeredInlineModuleProvider({
        runtime,
        workspacePath: context.workspacePath,
        nodeExecutable: options.nodeExecutable,
        importPolicy: options.importPolicy ?? context.importPolicy,
        maxOutputBytes: options.inlineMaxOutputBytes,
        maxSourceCharacters: options.inlineMaxSourceCharacters,
        maxSourceBytes: options.moduleMaxSourceBytes,
        maxBrokerInvocations: options.moduleMaxBrokerInvocations,
        maxConcurrentBrokerInvocations: options.moduleMaxConcurrentBrokerInvocations,
        compositionRegistry: context.compositionRegistry,
        serviceContainer: context.serviceContainer,
      });
      providers.push(moduleProvider);
    }
    const configuredReactUi = typeof options.reactUi === 'function'
      ? options.reactUi(context)
      : options.reactUi;
    const reactUi = configuredReactUi === false || configuredReactUi === undefined
      ? undefined
      : createReactUiCapabilities({
          ...configuredReactUi,
          workspacePath: context.workspacePath,
          stateRoot: configuredReactUi.stateRoot ?? context.stateRoot,
          permissionBroker: context.permissionBroker,
          serviceAccessor: context.serviceContainer,
          operationInvoker: {
            execute: (request, invocationContext) =>
              context.operationInvoker.execute(request, invocationContext),
          },
        });
    const resourcePorts: RuntimeScopedResourcePort[] = [];
    if (options.authoredUiPromotion && !reactUi) {
      throw new Error('Authored UI promotion requires React UI capabilities.');
    }
    if (reactUi) {
      if (!context.serviceContainer.tryGet(RUNTIME_AUTHORED_UI_STATE_SERVICE)) {
        serviceBindings.push(await context.serviceContainer.bind(
          RUNTIME_AUTHORED_UI_STATE_SERVICE,
          { useValue: reactUi.authoredStateService },
        ));
      }
    }
    if (options.extensionAuthoring) {
      authoringBundle = createTypeScriptExtensionAuthoringBundle({
        workspaceRoot: context.workspacePath,
        storageRoot: join(context.stateRoot, 'typescript-extension-authoring'),
        services: context.serviceContainer,
        workingDirectory: context.workspacePath,
      });
      providers.push(authoringBundle.provider);
      catalogSources.push(authoringBundle.catalogSource);
      resourcePorts.push({
        listResources: async (invocationContext) =>
          authoringBundle!.resources.listResources(invocationContext),
        readResource: async (uri, invocationContext) =>
          authoringBundle!.resources.readResource(uri, invocationContext),
      });
    }
    if (options.authoredUiPromotion) {
      promotionBundle = createRuntimeAuthoredUiPromotionBundle({
        services: context.serviceContainer,
        root: join(context.stateRoot, 'authored-ui-promotion'),
        resourceReader: {
          read: (snapshot, invocationContext) =>
         reactUi!.resources.readResource(
           `ui://marshal-react/${snapshot.provenance.componentId}/index.html`,
           invocationContext,
         ),
        },
      });
      providers.push(promotionBundle.provider);
      catalogSources.push(promotionBundle.catalogSource);
      if (!context.serviceContainer.tryGet(RUNTIME_AUTHORED_UI_PROMOTION_SERVICE)) {
        serviceBindings.push(await context.serviceContainer.bind(
          RUNTIME_AUTHORED_UI_PROMOTION_SERVICE,
          { useValue: promotionBundle.service },
        ));
      }
    }
    let disposeOperation: Promise<void> | undefined;
    const disposeOwned = (): Promise<void> => disposeOperation ?? (disposeOperation = (async () => {
      const failures: unknown[] = [];
      for (const cleanup of [
        () => moduleProvider?.dispose(),
        () => promotionBundle?.dispose(),
        () => authoringBundle?.dispose(),
        ...[...serviceBindings].reverse().map((binding) => () => binding.dispose()),
      ]) {
        try { await cleanup(); } catch (error) { failures.push(error); }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, 'Failed to dispose runtime builtin providers.');
      }
    })());
    const configuredDeclarativeUi = typeof options.declarativeUi === 'function'
      ? options.declarativeUi(context)
      : options.declarativeUi;
    const declarativeUi =
      configuredDeclarativeUi === false || configuredDeclarativeUi === undefined
        ? undefined
        : createDeclarativeUiCapabilities({
            ...configuredDeclarativeUi,
            stateRoot: configuredDeclarativeUi.stateRoot ?? context.stateRoot,
            operationInvoker: {
              invoke: (operation, input, invocationContext) =>
                context.operationInvoker.invoke(operation, input, invocationContext),
            },
          });
    resourcePorts.push(...[
      ...(declarativeUi ? [declarativeUi.resources] : []),
      ...(reactUi ? [{
        listResources: (invocationContext: Parameters<typeof reactUi.resources.listResources>[0]) =>
          reactUi.resources.listResources(invocationContext),
        readResource: (
          uri: string,
          invocationContext: Parameters<typeof reactUi.resources.readResource>[1],
        ) => reactUi.resources.readResource(uri, invocationContext),
        reactToolMetadata: () => reactUi.resources.toolMetadata(),
        listRenderTools: (
          invocationContext: Parameters<typeof reactUi.resources.listRenderTools>[0],
        ) => reactUi.resources.listRenderTools(invocationContext),
        invokeRenderTool: (
          name: string,
          input: unknown,
          invocationContext: Parameters<typeof reactUi.resources.invokeRenderTool>[2],
        ) => reactUi.resources.invokeRenderTool(name, input, invocationContext),
      }] : []),
    ]);
    return {
      providers: [
        ...providers,
        ...(declarativeUi ? declarativeUi.providers : []),
        ...(reactUi ? reactUi.providers : []),
      ],
      catalogSources,
      ...(resourcePorts.length > 0
        ? {
            resources: composeBuiltinResourcePorts(resourcePorts),
            catalog: composeBuiltinCatalogProviders([
              ...(declarativeUi ? [declarativeUi.catalog] : []),
              ...(reactUi ? [reactUi.catalog] : []),
            ]),
          }
        : {}),
      async dispose() {
        await disposeOwned();
      },
    };
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      for (const cleanup of [
        () => moduleProvider?.dispose(),
        () => promotionBundle?.dispose(),
        () => authoringBundle?.dispose(),
        ...[...serviceBindings].reverse().map((binding) => () => binding.dispose()),
      ]) {
        try { await cleanup(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      }
      if (cleanupErrors.length > 0 && error instanceof Error) {
        Object.defineProperty(error, 'cleanupErrors', { value: cleanupErrors });
      }
      throw error;
    }
  };
}

function composeBuiltinResourcePorts(
  ports: readonly RuntimeScopedResourcePort[],
): RuntimeScopedResourcePort {
  const declarative = ports.find((port) => 'toolMetadata' in port);
  const react = ports.find((port) => 'reactToolMetadata' in port);
  const toolMetadata = declarative?.toolMetadata;
  const reactToolMetadata = react?.reactToolMetadata;
  return {
    async listResources(context) {
      return (await Promise.all(ports.map((port) => port.listResources(context)))).flat();
    },
    async readResource(uri, context) {
      for (const port of ports) {
        const resources = await port.listResources(context);
        if (resources.some((resource) => resource.uri === uri)) {
          return port.readResource(uri, context);
        }
      }
      throw new Error(`Runtime UI resource not found: ${uri}`);
    },
    ...(toolMetadata
      ? { toolMetadata: () => toolMetadata.call(declarative) }
      : {}),
    ...(reactToolMetadata
      ? { reactToolMetadata: () => reactToolMetadata.call(react) }
      : {}),
    async listRenderTools(context) {
      return (
        await Promise.all(
          ports.map((port) =>
            port.listRenderTools?.(context) ?? Promise.resolve([])),
        )
      ).flat();
    },
    async invokeRenderTool(name, input, context) {
      for (const port of ports) {
        if (!port.invokeRenderTool || !port.listRenderTools) continue;
        const tools = await port.listRenderTools(context);
        if (tools.some((tool) => tool.name === name)) {
          return port.invokeRenderTool(name, input, context);
        }
      }
      return undefined;
    },
  };
}

function composeBuiltinCatalogProviders(
  providers: readonly RuntimeCatalogProvider[],
): RuntimeCatalogProvider {
  return {
    id: 'marshal.runtime-ui-catalog',
    async list(context) {
      const entries = (await Promise.all(providers.map((provider) => provider.list(context)))).flat();
      const seen = new Set<string>();
      for (const entry of entries) {
        if (seen.has(entry.id)) throw new Error(`Duplicate runtime UI catalog id: ${entry.id}`);
        seen.add(entry.id);
      }
      return entries;
    },
  };
}
