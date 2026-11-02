import type {
  RuntimeServiceBinding,
  RuntimeServiceToken,
} from '@marshal/agent-runtime-composer';
import type { RuntimeLifecycleEventType, RuntimeLifecycleListener } from '@marshal/agent-runtime-core';
import type {
  RuntimeExtensionContract,
  RuntimeExtensionConfiguration,
  RuntimeExtensionEventSubscriptionContribution,
  RuntimeExtensionManifest,
  RuntimeExtensionModule,
  RuntimeExtensionServiceContribution,
} from './contracts.js';

export function defineRuntimeExtensionContract<const TContract extends RuntimeExtensionContract>(
  contract: TContract,
): TContract {
  return contract;
}

export function defineRuntimeExtensionConfigurationSchema<
  const TSchema extends import('./contracts.js').RuntimeExtensionConfigurationSchema,
>(schema: TSchema): TSchema {
  return schema;
}

/** Preserve an extension module's configuration type without a runtime wrapper. */
export function defineRuntimeExtension<
  TConfiguration extends RuntimeExtensionConfiguration,
>(
  extension: RuntimeExtensionModule<TConfiguration>,
): RuntimeExtensionModule<TConfiguration> {
  return extension;
}

/** Preserve literal manifest values while validating them through the package loader. */
export function defineRuntimeExtensionManifest<const TManifest extends RuntimeExtensionManifest>(
  manifest: TManifest,
): TManifest {
  return manifest;
}

export function bindRuntimeExtensionService<T>(
  token: RuntimeServiceToken<T>,
  binding: RuntimeServiceBinding<T>,
): RuntimeExtensionServiceContribution {
  return Object.freeze({ token, binding, mode: 'bind' as const });
}

export function replaceRuntimeExtensionService<T>(
  token: RuntimeServiceToken<T>,
  binding: RuntimeServiceBinding<T>,
): RuntimeExtensionServiceContribution {
  return Object.freeze({ token, binding, mode: 'replace' as const });
}

export function subscribeRuntimeExtensionEvent<
  TType extends RuntimeLifecycleEventType,
>(
  type: TType,
  listener: RuntimeLifecycleListener<TType>,
): RuntimeExtensionEventSubscriptionContribution {
  return Object.freeze({
    type,
    listener,
  });
}
