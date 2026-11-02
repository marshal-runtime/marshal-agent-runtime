const MAX_RUNTIME_SERVICE_TOKEN_KEY_LENGTH = 256;

/** A typed, globally stable key for one Runtime service. */
export type RuntimeServiceToken<T> = symbol & {
  readonly __type?: (value: T) => T;
};

/**
 * Create a service token from a package-qualified key.
 *
 * Symbol.for is used deliberately so hosts and extensions share token identity
 * without requiring a registry or runtime-specific metadata.
 */
export function createRuntimeServiceToken<T>(
  key: string,
): RuntimeServiceToken<T> {
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > MAX_RUNTIME_SERVICE_TOKEN_KEY_LENGTH ||
    !/^@[^/\s]+\/[^:\s]+:[^\s]+$/.test(key)
  ) {
    throw new TypeError(
      `Runtime service token key must be a package-qualified string of at most ${MAX_RUNTIME_SERVICE_TOKEN_KEY_LENGTH} characters.`,
    );
  }
  return Symbol.for(key) as RuntimeServiceToken<T>;
}

export type RuntimeServiceLifetime = 'singleton' | 'scoped' | 'transient';

export type RuntimeServiceFactory<T> = (
  services: RuntimeServiceAccessor,
) => T;

export type RuntimeServiceDecorator<T> = (
  value: T,
  services: RuntimeServiceAccessor,
) => T;

export interface RuntimeServiceLifecycle<T> {
  readonly start?: (
    value: T,
    services: RuntimeServiceAccessor,
  ) => void | Promise<void>;
  readonly shutdown?: (
    value: T,
    services: RuntimeServiceAccessor,
  ) => void | Promise<void>;
}

export interface RuntimeServiceValueBinding<T> {
  readonly useValue: T;
  readonly useFactory?: never;
  readonly lifetime?: never;
  readonly start?: never;
  readonly shutdown?: never;
  readonly order?: number;
}

export interface RuntimeServiceFactoryBinding<T> {
  readonly useValue?: never;
  readonly useFactory: RuntimeServiceFactory<T>;
  readonly lifetime: RuntimeServiceLifetime;
  readonly start?: RuntimeServiceLifecycle<T>['start'];
  readonly shutdown?: RuntimeServiceLifecycle<T>['shutdown'];
  readonly order?: number;
}

export type RuntimeServiceBinding<T> =
  | RuntimeServiceValueBinding<T>
  | RuntimeServiceFactoryBinding<T>;

export interface RuntimeServiceBindingHandle {
  dispose(): Promise<void>;
}

export interface RuntimeServiceAccessor {
  get<T>(token: RuntimeServiceToken<T>): T;
  tryGet<T>(token: RuntimeServiceToken<T>): T | undefined;
  getAll<T>(token: RuntimeServiceToken<T>): readonly T[];
}

export interface RuntimeServiceScope extends RuntimeServiceAccessor {
  shutdown(): Promise<void>;
}

export interface RuntimeServiceContainer extends RuntimeServiceAccessor {
  bind<T>(
    token: RuntimeServiceToken<T>,
    binding: RuntimeServiceBinding<T>,
  ): Promise<RuntimeServiceBindingHandle>;
  bindMany<T>(
    token: RuntimeServiceToken<T>,
    binding: RuntimeServiceBinding<T>,
  ): Promise<RuntimeServiceBindingHandle>;
  replace<T>(
    token: RuntimeServiceToken<T>,
    binding: RuntimeServiceBinding<T>,
  ): Promise<RuntimeServiceBindingHandle>;
  decorate<T>(
    token: RuntimeServiceToken<T>,
    decorator: RuntimeServiceDecorator<T>,
  ): Promise<RuntimeServiceBindingHandle>;
  createScope(): Promise<RuntimeServiceScope>;
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

export const RUNTIME_SERVICE_CONTAINER =
  createRuntimeServiceToken<RuntimeServiceContainer>(
    '@marshal/runtime/services:container',
  );
