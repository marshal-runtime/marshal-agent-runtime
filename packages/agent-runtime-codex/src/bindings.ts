import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  RuntimeAdapterBindings,
  RuntimeBindingFactory,
  RuntimeBindingFactoryOptions,
  RuntimeKernelPort,
  RuntimeLifecyclePort,
  RuntimeResourcePort,
} from './ports.js';
import type {
  RuntimeExtensionAutopilotService,
  RuntimeExtensionLifecycleService,
  RuntimeExtensionStatusService,
} from '@marshal/agent-runtime-extensions';

interface RuntimeBindingModule {
  default?: unknown;
  createCodexRuntime?: unknown;
  createAgentRuntime?: unknown;
  runtimeBindings?: unknown;
}

export async function loadRuntimeBindings(
  moduleSpecifier: string,
  options: RuntimeBindingFactoryOptions = {},
): Promise<RuntimeAdapterBindings> {
  const imported = (await import(resolveModuleSpecifier(moduleSpecifier))) as RuntimeBindingModule;
  const candidate =
    imported.createCodexRuntime ??
    imported.createAgentRuntime ??
    imported.default ??
    imported.runtimeBindings;
  if (candidate === undefined) {
    throw new Error(
      'Runtime binding module must export default, createCodexRuntime, createAgentRuntime, or runtimeBindings',
    );
  }
  const created =
    typeof candidate === 'function'
      ? await (candidate as RuntimeBindingFactory)(options)
      : candidate;
  return normalizeBindings(created);
}

export function normalizeBindings(value: unknown): RuntimeAdapterBindings {
  if (!isObject(value)) {
    throw new Error('Runtime binding factory must return an object');
  }
  if (isKernel(value.kernel)) {
    const extensionStatus = isExtensionStatus(value.extensionStatus) ? value.extensionStatus : undefined;
    const extensionAutopilot = isExtensionAutopilot(value.extensionAutopilot)
      ? value.extensionAutopilot
      : undefined;
    const candidateLifecycle = extensionStatus && 'lifecycle' in extensionStatus
      ? extensionStatus.lifecycle
      : undefined;
    return {
      kernel: value.kernel,
      lifecycle: isLifecycle(value.lifecycle) ? value.lifecycle : undefined,
      resources: isResources(value.resources) ? value.resources : undefined,
      ...(extensionStatus ? { extensionStatus } : {}),
      ...(isExtensionLifecycle(candidateLifecycle) ? { extensionLifecycle: candidateLifecycle } : {}),
      ...(extensionAutopilot ? { extensionAutopilot } : {}),
      dispose:
        typeof value.dispose === 'function'
          ? (value.dispose as () => void | Promise<void>)
          : undefined,
    };
  }
  if (isKernel(value)) {
    return {
      kernel: value,
      lifecycle: isLifecycle(value) ? value : undefined,
      resources: isResources(value.resources) ? value.resources : undefined,
      dispose:
        typeof value.dispose === 'function'
          ? (value.dispose as () => void | Promise<void>)
          : undefined,
    };
  }
  throw new Error('Runtime binding must provide kernel.search() and kernel.execute()');
}

function resolveModuleSpecifier(specifier: string): string {
  if (specifier.startsWith('file:')) {
    return specifier;
  }
  if (isAbsolute(specifier) || specifier.startsWith('.')) {
    return pathToFileURL(resolve(specifier)).href;
  }
  return specifier;
}

function isKernel(value: unknown): value is RuntimeKernelPort {
  return (
    isObject(value) && typeof value.search === 'function' && typeof value.execute === 'function'
  );
}

function isLifecycle(value: unknown): value is RuntimeLifecyclePort {
  return (
    isObject(value) &&
    typeof value.startSession === 'function' &&
    typeof value.observeTurn === 'function' &&
    typeof value.endSession === 'function'
  );
}

function isResources(value: unknown): value is RuntimeResourcePort {
  return (
    isObject(value) &&
    typeof value.listResources === 'function' &&
    typeof value.readResource === 'function'
  );
}

function isExtensionStatus(value: unknown): value is RuntimeExtensionStatusService & { lifecycle?: unknown } {
  return isObject(value) && typeof value.snapshot === 'function' && typeof value.refresh === 'function'
    && typeof value.install === 'function' && typeof value.enable === 'function'
    && typeof value.disable === 'function' && typeof value.remove === 'function';
}

function isExtensionLifecycle(value: unknown): value is RuntimeExtensionLifecycleService {
  return isObject(value) && typeof value.list === 'function' && typeof value.configure === 'function';
}

function isExtensionAutopilot(value: unknown): value is RuntimeExtensionAutopilotService {
  return isObject(value) && typeof value.refresh === 'function' && typeof value.snapshot === 'function'
    && typeof value.setGlobal === 'function' && typeof value.setExtension === 'function'
    && typeof value.syncExtensions === 'function';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
