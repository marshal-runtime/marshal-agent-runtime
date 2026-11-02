import type { RuntimeServiceToken } from './services.js';

export type ServiceId = string;

export interface AppServiceDescriptor {
  readonly id: ServiceId;
  readonly name?: string;
  readonly description?: string;
  readonly methods?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AppServiceResolver {
  resolve<T>(id: ServiceId, snapshot?: unknown): T | undefined;
  invoke<T>(
    id: ServiceId,
    method: string,
    args: readonly unknown[],
    snapshot?: unknown,
  ): Promise<T>;
  list(snapshot?: unknown): readonly AppServiceDescriptor[];
  snapshot?(): unknown;
}

export interface TypeSymbols {
  readonly [id: string]: unknown;
  get(id: ServiceId): RuntimeServiceToken<unknown>;
  list(): readonly ServiceId[];
}

export interface AppServices {
  get<T>(id: ServiceId | RuntimeServiceToken<T>): T;
  tryGet<T>(id: ServiceId | RuntimeServiceToken<T>): T | undefined;
  invoke<T>(
    id: ServiceId,
    method: string,
    ...args: readonly unknown[]
  ): Promise<T>;
  describe(id?: ServiceId): AppServiceDescriptor | readonly AppServiceDescriptor[] | undefined;
  descriptor(id: ServiceId): AppServiceDescriptor | undefined;
  list(): readonly AppServiceDescriptor[];
  snapshot(): AppServices;
  readonly types: TypeSymbols;
  readonly typeSymbols: TypeSymbols;
  readonly [key: string]: unknown;
}

const SYMBOL_PREFIX = '@marshal/runtime/service:';
const SERVICE_ID_PATTERN = /^[^\s]+$/;
const MAX_SERVICE_ID_LENGTH = 1_024;
const MAX_METHOD_LENGTH = 256;
const MAX_RPC_DEPTH = 32;

function validateId(id: ServiceId): ServiceId {
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > MAX_SERVICE_ID_LENGTH ||
    !SERVICE_ID_PATTERN.test(id)
  ) {
    throw new TypeError('Service id must be a non-empty, single-line string of at most 1024 characters.');
  }
  return id;
}

function validateMethod(method: string): string {
  if (typeof method !== 'string' || method.length === 0 || method.length > MAX_METHOD_LENGTH) {
    throw new TypeError('Service method must be a non-empty string of at most 256 characters.');
  }
  return method;
}

function assertRpcValue(value: unknown, depth = 0, active = new Set<object>()): void {
  if (depth > MAX_RPC_DEPTH) throw new TypeError('RPC arguments are too deeply nested.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('RPC arguments must contain finite numbers.');
    return;
  }
  if (typeof value !== 'object') throw new TypeError('RPC arguments must be JSON-compatible.');
  if (active.has(value)) throw new TypeError('RPC arguments must be acyclic.');
  active.add(value);
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TypeError('RPC arguments cannot contain symbol properties.');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) {
        throw new TypeError('RPC arguments cannot contain accessors.');
      }
      assertRpcValue(descriptor.value, depth + 1, active);
    }
  } finally {
    active.delete(value);
  }
}

function canonicalId<T>(value: ServiceId | RuntimeServiceToken<T>): ServiceId {
  if (typeof value === 'symbol') {
    const key = Symbol.keyFor(value);
    if (!key || !key.startsWith(SYMBOL_PREFIX)) {
      throw new TypeError('Service token must have been created from a canonical service id.');
    }
    return key.slice(SYMBOL_PREFIX.length);
  }
  return validateId(value);
}

function makeTypeSymbols(resolver: AppServiceResolver, snapshot?: unknown): TypeSymbols {
  const cache = new Map<ServiceId, RuntimeServiceToken<unknown>>();
  const get = (id: ServiceId) => {
    const canonical = validateId(id);
    let token = cache.get(canonical);
    if (!token) {
      token = Symbol.for(`${SYMBOL_PREFIX}${canonical}`) as RuntimeServiceToken<unknown>;
      cache.set(canonical, token);
    }
    return token;
  };
  const target = { get, list: () => resolver.list(snapshot).map((descriptor) => descriptor.id) };
  return new Proxy(target as TypeSymbols, {
    get(object, property, receiver) {
      if (typeof property === 'string' && !(property in object)) return get(property);
      return Reflect.get(object, property, receiver);
    },
    ownKeys: () => resolver.list(snapshot).map((descriptor) => descriptor.id),
    getOwnPropertyDescriptor: (_object, property) =>
      typeof property === 'string'
        ? { configurable: true, enumerable: true, value: get(property) }
        : undefined,
  });
}

export function createAppServices(resolver: AppServiceResolver, snapshot?: unknown): AppServices {
  if (!resolver || typeof resolver.resolve !== 'function' || typeof resolver.invoke !== 'function' || typeof resolver.list !== 'function') {
    throw new TypeError('An app service resolver with resolve, invoke, and list methods is required.');
  }
  const types = makeTypeSymbols(resolver, snapshot);
  const facade = {
    types,
    typeSymbols: types,
    get<T>(id: ServiceId | RuntimeServiceToken<T>): T {
      const value = resolver.resolve<T>(canonicalId(id), snapshot);
      if (value === undefined) throw new Error(`App service "${canonicalId(id)}" is not available.`);
      return value;
    },
    tryGet<T>(id: ServiceId | RuntimeServiceToken<T>): T | undefined {
      return resolver.resolve<T>(canonicalId(id), snapshot);
    },
    invoke<T>(id: ServiceId, method: string, ...args: readonly unknown[]): Promise<T> {
      const canonical = validateId(id);
      validateMethod(method);
      args.forEach((arg) => assertRpcValue(arg));
      return resolver.invoke<T>(canonical, method, args, snapshot);
    },
    describe(id?: ServiceId) {
      const descriptors = resolver.list(snapshot);
      return id === undefined
        ? descriptors
        : descriptors.find((descriptor) => descriptor.id === validateId(id));
    },
    descriptor(id: ServiceId) {
      return descriptorsFor(resolver, snapshot, id).find((item) => item.id === validateId(id));
    },
    list: () => resolver.list(snapshot),
    snapshot: () => createAppServices(resolver, resolver.snapshot ? resolver.snapshot() : snapshot),
  };
  return new Proxy(facade as AppServices, {
    get(target, property, receiver) {
      if (typeof property === 'string' && property.startsWith('get') && property.length > 3) {
        const id = property.slice(3, 4).toLowerCase() + property.slice(4);
        if (resolver.list(snapshot).some((descriptor) => descriptor.id === id)) {
          return () => target.get(id);
        }
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function descriptorsFor(
  resolver: AppServiceResolver,
  snapshot: unknown,
  id: ServiceId,
): readonly AppServiceDescriptor[] {
  return resolver.list(snapshot).filter((descriptor) => descriptor.id === validateId(id));
}

export const createTypeSymbols = (resolver: AppServiceResolver, snapshot?: unknown): TypeSymbols =>
  makeTypeSymbols(resolver, snapshot);
