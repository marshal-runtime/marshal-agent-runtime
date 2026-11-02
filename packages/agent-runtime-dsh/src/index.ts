import { createRequire } from 'node:module';
import type {
  CapabilityProvider,
  InvocationContext,
  MaybePromise,
  RuntimeAbortSignal,
} from '@marshal/agent-runtime-core';
import { RUNTIME_PROTOCOL_VERSION } from '@marshal/agent-runtime-core';
import type {
  RuntimeExtensionCatalogSource,
  RuntimeExtensionCatalogSourceEntry,
  RuntimeExtensionInstallRequest,
  RuntimeExtensionModule,
  RuntimeExtensionUiApplication,
} from '@marshal/agent-runtime-extensions';
import type { RuntimeResourceContent, RuntimeScopedResourcePort } from '@marshal/agent-runtime-composer';

export const DSH_PLUGIN_BRIDGE_VERSION = '0.3.0' as const;
export const DSH_PLUGIN_BRIDGE_COMMIT =
  '6280fa5168e12a9fdff0f3f7479e4fb89eba0caf' as const;

export interface DshCommand {
  readonly name: string;
  readonly description?: string;
  readonly action: (input: unknown, context?: InvocationContext) => MaybePromise<unknown>;
}

interface DshHandlerCommand {
  readonly name: string;
  readonly description?: string;
  readonly handler: (invocation: unknown) => MaybePromise<unknown>;
}

export interface DshCommands {
  register(command: DshCommand | DshHandlerCommand): () => void;
  command(name: string, description?: string): { action(handler: DshCommand['action']): () => void };
  list(): readonly DshCommand[];
}

export interface DshApiProxy {
  call(service: string, method: string, input?: unknown): Promise<unknown>;
}

export interface DshCordisContext {
  readonly commands: DshCommands;
  readonly apiProxy: DshApiProxy;
  readonly signal?: RuntimeAbortSignal;
}

export type DshPluginApply = (
  context: DshCordisContext,
  config?: Readonly<Record<string, unknown>>,
) => MaybePromise<void | (() => MaybePromise<void>)>;

export interface DshRuntimeUiProjection {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly renderId: string;
  readonly resource: RuntimeResourceContent;
  readonly application: RuntimeExtensionUiApplication['application'];
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface DshRuntimeExtensionOptions {
  readonly apply?: DshPluginApply;
  readonly pluginRoot?: string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly ui?: readonly DshRuntimeUiProjection[];
  readonly id?: string;
  readonly version?: string;
}

export interface DshRuntimeExtensionResult {
  readonly module: RuntimeExtensionModule;
  readonly commands: DshCommands;
  readonly apiProxy: DshApiProxy;
}

class CommandRegistry implements DshCommands {
  private readonly entries = new Map<string, DshCommand>();
  register(command: DshCommand | DshHandlerCommand): () => void {
    if (!command || typeof command.name !== 'string' || !command.name.trim()
      || this.entries.has(command.name)) {
      throw new TypeError('A unique DSH command with an action is required.');
    }
    const action = 'action' in command && typeof command.action === 'function'
      ? command.action
      : 'handler' in command && typeof command.handler === 'function'
        ? (input: unknown, context?: InvocationContext) =>
          command.handler({ rawInput: typeof input === 'string' ? input : '', signal: context?.signal })
        : undefined;
    if (!action) {
      throw new TypeError('A unique DSH command with an action is required.');
    }
    this.entries.set(command.name, Object.freeze({ ...command, action }));
    return () => { this.entries.delete(command.name); };
  }
  command(name: string, description?: string) {
    return {
      action: (action: DshCommand['action']) =>
        this.register({ name, description, action }),
    };
  }
  list(): readonly DshCommand[] { return Object.freeze([...this.entries.values()]); }
  clear(): void { this.entries.clear(); }
}

class DeterministicApiProxy implements DshApiProxy {
  private readonly services = new Map<string, (input: unknown) => MaybePromise<unknown>>();
  register(service: string, handler: (input: unknown) => MaybePromise<unknown>): () => void {
    if (!service || typeof handler !== 'function' || this.services.has(service)) {
      throw new TypeError('A unique apiProxy service with a handler is required.');
    }
    this.services.set(service, handler);
    return () => { this.services.delete(service); };
  }
  async call(service: string, method: string, input?: unknown): Promise<unknown> {
    if (typeof service !== 'string' || typeof method !== 'string' || !service || !method) {
      throw new TypeError('apiProxy service and method are required.');
    }
    const handler = this.services.get(`${service}.${method}`);
    if (!handler) throw new Error(`Unknown apiProxy method: ${service}.${method}`);
    return handler(input);
  }
}

export function loadDshPluginBridge(pluginRoot: string): {
  readonly version: string;
  readonly entrypoint: string;
  readonly apply: DshPluginApply;
} {
  if (typeof pluginRoot !== 'string' || !pluginRoot) throw new TypeError('pluginRoot is required.');
  const require = createRequire(import.meta.url);
  const packageJson = require(`${pluginRoot}/package.json`) as { version?: unknown; main?: unknown };
  if (packageJson.version !== DSH_PLUGIN_BRIDGE_VERSION) {
    throw new Error(`Expected dsh-plugin-bridge ${DSH_PLUGIN_BRIDGE_VERSION}.`);
  }
  if (typeof packageJson.main !== 'string' || packageJson.main !== 'lib/index.js') {
    throw new Error('dsh-plugin-bridge must resolve its released lib/index.js entrypoint.');
  }
  const loaded = require(`${pluginRoot}/${packageJson.main}`) as { default?: unknown; apply?: unknown };
  const apply = typeof loaded.default === 'function' ? loaded.default : loaded.apply;
  if (typeof apply !== 'function') throw new TypeError('DSH plugin entrypoint must export default apply(ctx, config).');
  return Object.freeze({
    version: packageJson.version,
    entrypoint: `${pluginRoot}/${packageJson.main}`,
    apply: apply as DshPluginApply,
  });
}

export function createDshRuntimeExtension(options: DshRuntimeExtensionOptions = {}): DshRuntimeExtensionResult {
  const commands = new CommandRegistry();
  const proxy = new DeterministicApiProxy();
  const apply = options.apply ?? (options.pluginRoot ? loadDshPluginBridge(options.pluginRoot).apply : undefined);
  if (!apply) throw new TypeError('Either apply or pluginRoot must be supplied.');
  let pluginDispose: (() => MaybePromise<void>) | undefined;
  let active = false;
  const context: DshCordisContext = { commands, apiProxy: proxy };
  const module: RuntimeExtensionModule = {
    async activate() {
      if (active) throw new Error('DSH extension is already active.');
      active = true;
      try {
        pluginDispose = (await apply(context, options.config)) ?? undefined;
      } catch (error) {
        active = false;
        pluginDispose = undefined;
        commands.clear();
        throw error;
      }
      return {
        capabilityProviders: [createCommandProvider(commands)],
        resourceProviders: options.ui?.length ? [createUiResource(options.ui)] : undefined,
        uiApplications: options.ui,
        dispose: async () => {
          if (!active) return;
          active = false;
          const dispose = pluginDispose;
          pluginDispose = undefined;
          try {
            await dispose?.();
          } finally {
            commands.clear();
          }
        },
      };
    },
  };
  return Object.freeze({ module, commands, apiProxy: proxy });
}

function createCommandProvider(commands: DshCommands): CapabilityProvider {
  return {
    id: 'dsh.commands',
    version: DSH_PLUGIN_BRIDGE_VERSION,
    list: () => commands.list().map((command) => ({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      name: command.name,
      version: DSH_PLUGIN_BRIDGE_VERSION,
      title: command.name,
      description: command.description ?? `DSH command ${command.name}`,
      outputSchema: { type: 'object' },
    })),
    invoke: async (name, input, context) => {
      const command = commands.list().find((entry) => entry.name === name);
      if (!command) throw new Error(`Unknown DSH command: ${name}`);
      return { output: await command.action(input, context) };
    },
  };
}

function createUiResource(ui: readonly DshRuntimeUiProjection[]): RuntimeScopedResourcePort {
  const resources = new Map(ui.map((entry) => [entry.resource.uri, entry.resource]));
  return {
    listResources: () => [...resources.keys()].map((uri) => ({ uri, name: uri, mimeType: resources.get(uri)?.mimeType })),
    readResource: async (uri: string) => {
      const resource = resources.get(uri);
      if (!resource) throw new Error(`DSH UI resource not found: ${uri}`);
      return resource;
    },
  };
}

export interface DshCatalogSourceOptions {
  readonly packageRoot: string;
  readonly integrity: RuntimeExtensionInstallRequest['integrity'];
  readonly id?: string;
  readonly title?: string;
  readonly description?: string;
}

export function createDshCatalogSource(options: DshCatalogSourceOptions): RuntimeExtensionCatalogSource {
  const entry: RuntimeExtensionCatalogSourceEntry = Object.freeze({
    id: options.id ?? 'dsh-plugin-bridge',
    identity: '@marshal/agent-runtime-dsh',
    version: DSH_PLUGIN_BRIDGE_VERSION,
    origin: 'dsh',
    title: options.title ?? 'DSH plugin bridge',
    description: options.description ?? 'Pinned DSH/Cordis compatibility extension.',
    tags: ['dsh', 'cordis', 'portable'],
    request: Object.freeze({ packageRoot: options.packageRoot, integrity: options.integrity }),
  });
  return Object.freeze({
    id: 'dsh',
    label: 'DSH compatibility',
    list: async (_context: InvocationContext, signal?: RuntimeAbortSignal) => {
      if (signal?.aborted) throw new Error('DSH catalog discovery cancelled.');
      return [entry];
    },
  });
}
