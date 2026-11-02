import type {
  RuntimeExtensionAutopilotService,
  RuntimeExtensionLifecycleService,
  RuntimeExtensionStatusService,
} from '@marshal/agent-runtime-extensions';
import {
  RUNTIME_EXTENSION_ACTION_TOOL,
  RUNTIME_EXTENSION_MANAGER_TOOL,
  RUNTIME_EXTENSION_MANAGER_URI,
  createRuntimeExtensionManagerView,
  runtimeExtensionActionToolMetadata,
  runtimeExtensionManagerContent,
  runtimeExtensionManagerDescriptor,
  runtimeExtensionManagerToolMetadata,
} from '@marshal/agent-runtime-ui';
import type {
  JsonObject,
  RuntimeResourceContent,
  RuntimeResourceDescriptor,
  RuntimeResourceToolDescriptor,
  RuntimeResourceToolResult,
} from './ports.js';

export interface CodexExtensionManagementBindings {
  readonly status: RuntimeExtensionStatusService;
  readonly lifecycle?: RuntimeExtensionLifecycleService;
  readonly autopilot?: RuntimeExtensionAutopilotService;
}

export function extensionManagementTools(): readonly RuntimeResourceToolDescriptor[] {
  return [
    {
      name: RUNTIME_EXTENSION_MANAGER_TOOL,
      title: 'Open Marshal Runtime Extensions',
      description: 'Immediately open the live Marshal Runtime Extensions manager for this Codex host. Use this tool directly when the user asks to open, show, launch, or display the extensions manager; do not search the repository, run GitNexus, or inspect code first.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      _meta: runtimeExtensionManagerToolMetadata(),
    },
    {
      name: RUNTIME_EXTENSION_ACTION_TOOL,
      title: 'Manage a Marshal runtime extension',
      description: 'Refresh, install/build, enable, disable, remove, configure, or change global/per-extension autopilot permission grants.',
      inputSchema: {
        type: 'object', required: ['action'],
        properties: {
          action: { enum: ['refresh', 'install', 'enable', 'disable', 'remove', 'configure', 'set-global-autopilot', 'set-extension-autopilot'] },
          identity: { type: 'string' }, packageRoot: { type: 'string' }, configuration: { type: 'object' },
          enabled: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      _meta: runtimeExtensionActionToolMetadata(),
    },
  ];
}

export function extensionManagementResource(): RuntimeResourceDescriptor {
  return runtimeExtensionManagerDescriptor();
}

export async function readExtensionManagementResource(
  bindings: CodexExtensionManagementBindings,
): Promise<RuntimeResourceContent> {
  await bindings.autopilot?.refresh();
  await syncAutopilot(bindings);
  return runtimeExtensionManagerContent(currentView(bindings));
}

export async function callExtensionManagementTool(
  bindings: CodexExtensionManagementBindings,
  name: string,
  input: JsonObject,
  signal?: AbortSignal,
): Promise<RuntimeResourceToolResult | undefined> {
  await bindings.autopilot?.refresh();
  if (name === RUNTIME_EXTENSION_MANAGER_TOOL) {
    await syncAutopilot(bindings);
    return result(bindings, 'Live runtime extension state loaded.', runtimeExtensionManagerToolMetadata());
  }
  if (name !== RUNTIME_EXTENSION_ACTION_TOOL) return undefined;
  const action = requiredString(input.action, 'runtime_extensions_action.action');
  switch (action) {
    case 'refresh':
      await bindings.status.refresh({ signal });
      await syncAutopilot(bindings);
      break;
    case 'install': {
      const installation = bindings.status.install({
        packageRoot: requiredString(input.packageRoot, 'runtime_extensions_action.packageRoot'),
        ...(isObject(input.configuration) ? { configuration: input.configuration } : {}), enabled: true,
      });
      void installation.catch(() => undefined);
      break;
    }
    case 'enable':
      await bindings.status.enable(requiredString(input.identity, 'runtime_extensions_action.identity'), { signal });
      await syncAutopilot(bindings);
      break;
    case 'disable':
      await bindings.status.disable(requiredString(input.identity, 'runtime_extensions_action.identity'), { signal });
      await syncAutopilot(bindings);
      break;
    case 'remove':
      await bindings.status.remove(requiredString(input.identity, 'runtime_extensions_action.identity'), { signal });
      await syncAutopilot(bindings);
      break;
    case 'configure':
      if (!bindings.lifecycle) throw new Error('Runtime extension configuration is unavailable.');
      if (!isObject(input.configuration)) throw new Error('runtime_extensions_action.configuration must be an object');
      await bindings.lifecycle.configure(requiredString(input.identity, 'runtime_extensions_action.identity'), input.configuration, { signal });
      await bindings.status.refresh({ signal });
      await syncAutopilot(bindings);
      break;
    case 'set-global-autopilot':
      if (!bindings.autopilot) throw new Error('Runtime extension autopilot is unavailable.');
      await bindings.autopilot.setGlobal(requiredBoolean(input.enabled, 'runtime_extensions_action.enabled'));
      break;
    case 'set-extension-autopilot': {
      if (!bindings.autopilot || !bindings.lifecycle) {
        throw new Error('Runtime extension autopilot is unavailable.');
      }
      const identity = requiredString(input.identity, 'runtime_extensions_action.identity');
      await bindings.autopilot.syncExtensions(bindings.lifecycle.list());
      const record = bindings.lifecycle.get(identity);
      if (!record) throw new Error(`Runtime extension is not installed: ${identity}`);
      await bindings.autopilot.setExtension(
        identity,
        requiredBoolean(input.enabled, 'runtime_extensions_action.enabled'),
        record.capabilityProviderIds,
        record.contributedCapabilityPrefixes ?? [],
      );
      break;
    }
    default: throw new Error(`Unsupported runtime extension action: ${action}`);
  }
  return result(
    bindings,
    action === 'install'
      ? 'Runtime extension installation started.'
      : `Runtime extension action completed: ${action}.`,
  );
}

export function isExtensionManagementResource(uri: string): boolean {
  return uri === RUNTIME_EXTENSION_MANAGER_URI;
}

function currentView(bindings: CodexExtensionManagementBindings) {
  return createRuntimeExtensionManagerView(
    bindings.status.snapshot(),
    bindings.lifecycle?.list() ?? [],
    bindings.autopilot?.snapshot(),
  );
}

async function syncAutopilot(bindings: CodexExtensionManagementBindings): Promise<void> {
  if (bindings.autopilot && bindings.lifecycle) {
    await bindings.autopilot.syncExtensions(bindings.lifecycle.list());
  }
}

function result(
  bindings: CodexExtensionManagementBindings,
  message: string,
  metadata?: JsonObject,
): RuntimeResourceToolResult {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { view: currentView(bindings) as unknown as JsonObject },
    ...(metadata ? { _meta: metadata } : {}),
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required`);
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} is required`);
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
