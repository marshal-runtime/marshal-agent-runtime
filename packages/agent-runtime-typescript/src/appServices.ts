import type { JsonValue } from './types.js';
import { cloneJson } from './json.js';

export const APP_SERVICES_HELPER_SOURCE = String.raw`
function createAppServices(call, snapshot) {
  const services = snapshot?.services || [];
  const uniqueServices = [...services.reduce((byToken, service) => {
    const existing = byToken.get(service.token);
    if (!existing || service.name.localeCompare(existing.name) < 0) byToken.set(service.token, service);
    return byToken;
  }, new Map()).values()].sort((left, right) => left.token.localeCompare(right.token));
  const bases = new Map();
  const explicit = new Map();
  for (const service of uniqueServices) {
    if (service.publicName === undefined) continue;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(service.publicName)) {
      throw new TypeError('Application service public name must be a valid identifier.');
    }
    const previous = explicit.get(service.publicName);
    if (previous !== undefined && previous !== service.token) {
      throw new TypeError('Application service public names must be unique.');
    }
    explicit.set(service.publicName, service.token);
  }
  for (const service of uniqueServices) {
    const base = normalizeAppServiceName(service.name);
    bases.set(base, (bases.get(base) || 0) + 1);
  }
  const candidates = new Map();
  for (const service of uniqueServices) {
    const base = normalizeAppServiceName(service.name);
    candidates.set(service.token, bases.get(base) === 1 ? base : normalizeIdentifierWords(service.name));
  }
  const groups = new Map();
  for (const [token, candidate] of candidates) {
    const group = groups.get(candidate) || [];
    group.push(token);
    groups.set(candidate, group);
  }
  const names = new Map();
  for (const service of uniqueServices) {
    if (service.publicName !== undefined) {
      names.set(service.token, service.publicName);
      continue;
    }
    const candidate = candidates.get(service.token);
    const name = (groups.get(candidate) || []).length > 1
      || ['get', 'invoke', 'create', 'token'].includes(candidate)
      || explicit.has(candidate)
      ? collisionSafeAppServiceName(service)
      : candidate;
    names.set(service.token, name);
  }
  const publicName = (service) => names.get(service.token);
  const descriptors = new Map(uniqueServices.map((service) => [publicName(service), service]));
  const typeSymbol = (token) => Symbol.for(token);
  const tokenForType = (type) => {
    if (typeof type !== 'symbol' || Symbol.keyFor(type) === undefined) {
      throw new TypeError('Type symbol must be created with Symbol.for.');
    }
    return Symbol.keyFor(type);
  };
  const serviceProxy = (type, descriptor) => {
    if (!descriptor) return undefined;
    const token = tokenForType(type);
    const methods = new Set((descriptor.methods || []).map((method) => method.name));
    return new Proxy(Object.create(null), {
      get: (_target, property) => {
        if (typeof property !== 'string' || !methods.has(property)) return undefined;
        return (...args) => call('appServices.invoke', { token, method: property, args });
      },
    });
  };
  const get = (type) => serviceProxy(type, [...descriptors.values()]
    .find((service) => service.token === tokenForType(type)));
  const invoke = async (type, input = null) => call('appServices.invoke', {
    token: tokenForType(type),
    input,
  });
  const appServices = { get, invoke };
  for (const descriptor of descriptors.values()) {
    const serviceName = publicName(descriptor);
    const getterName = 'get' + serviceName.charAt(0).toUpperCase() + serviceName.slice(1);
    if (serviceName && !(serviceName in appServices)) {
      Object.defineProperty(appServices, serviceName, {
        value: serviceProxy(typeSymbol(descriptor.token), descriptor),
      });
    }
    if (getterName && !(getterName in appServices)) {
      Object.defineProperty(appServices, getterName, {
        value: () => serviceProxy(typeSymbol(descriptor.token), descriptor),
      });
    }
  }
  return Object.freeze(appServices);
}

function createTypeSymbols(snapshot) {
  const symbols = { create: (token) => Symbol.for(token), token: (type) => {
    if (typeof type !== 'symbol' || Symbol.keyFor(type) === undefined) {
      throw new TypeError('Type symbol must be created with Symbol.for.');
    }
    return Symbol.keyFor(type);
  } };
  const services = [...(snapshot?.services || []).reduce((byToken, service) => {
    const existing = byToken.get(service.token);
    if (!existing || service.name.localeCompare(existing.name) < 0) byToken.set(service.token, service);
    return byToken;
  }, new Map()).values()].sort((left, right) => left.token.localeCompare(right.token));
  const bases = new Map();
  const explicit = new Map();
  for (const descriptor of services) {
    if (descriptor.publicName === undefined) continue;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(descriptor.publicName)) {
      throw new TypeError('Application service public name must be a valid identifier.');
    }
    const previous = explicit.get(descriptor.publicName);
    if (previous !== undefined && previous !== descriptor.token) {
      throw new TypeError('Application service public names must be unique.');
    }
    explicit.set(descriptor.publicName, descriptor.token);
  }
  for (const descriptor of services) {
    const base = normalizeAppServiceName(descriptor.name);
    bases.set(base, (bases.get(base) || 0) + 1);
  }
  const candidates = new Map();
  for (const descriptor of services) {
    const base = normalizeAppServiceName(descriptor.name);
    candidates.set(descriptor.token, bases.get(base) === 1 ? base : normalizeIdentifierWords(descriptor.name));
  }
  const groups = new Map();
  for (const [token, candidate] of candidates) {
    const group = groups.get(candidate) || [];
    group.push(token);
    groups.set(candidate, group);
  }
  for (const descriptor of services) {
    if (descriptor.publicName !== undefined) {
      if (!(descriptor.publicName in symbols)) symbols[descriptor.publicName] = Symbol.for(descriptor.token);
      continue;
    }
    const candidate = candidates.get(descriptor.token);
    const publicName = (groups.get(candidate) || []).length > 1
      || ['get', 'invoke', 'create', 'token'].includes(candidate)
      || explicit.has(candidate)
      ? collisionSafeAppServiceName(descriptor)
      : candidate;
    if (publicName && !(publicName in symbols)) symbols[publicName] = Symbol.for(descriptor.token);
  }
  return Object.freeze(symbols);
}

function normalizeAppServiceName(name) {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
    const withoutInterfacePrefix = /^I[A-Z]/.test(name) ? name.slice(1) : name;
    return withoutInterfacePrefix.charAt(0).toLowerCase() + withoutInterfacePrefix.slice(1);
  }
  const segment = name.slice(Math.max(name.lastIndexOf(':'), name.lastIndexOf('/')) + 1);
  return normalizeIdentifierWords(segment);
}

function normalizeIdentifierWords(value) {
  const words = value.match(/[A-Za-z0-9]+/g) || [];
  const normalized = words.length === 0
    ? 'service'
    : words[0].toLowerCase() + words.slice(1).map((word) =>
      word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join('');
  return /^[A-Za-z_$]/.test(normalized) ? normalized : 'service' + normalized;
}

function collisionSafeAppServiceName(service) {
  return 'service_' +
    [...service.token].map((character) => character.codePointAt(0).toString(16)).join('');
}
`;

export type TypeSymbol<T> = symbol & { readonly __type?: (value: T) => T };

export interface TypeSymbolDescriptor {
  readonly name: string;
  readonly token: string;
  readonly declaration?: string;
  readonly publicName?: string;
}

export interface AppServiceDescriptor extends TypeSymbolDescriptor {
  readonly methods?: readonly AppServiceMethodDescriptor[];
}

export interface AppServiceMethodDescriptor {
  readonly name: string;
  readonly input?: string;
  readonly output?: string;
  readonly description?: string;
  readonly links?: readonly string[];
  readonly examples?: readonly string[];
}

export interface AppServicesSnapshot {
  readonly services: readonly AppServiceDescriptor[];
  readonly declarations?: string;
}

export interface AppServices {
  get<T>(type: TypeSymbol<T>): T | undefined;
  invoke<TInput, TOutput>(type: TypeSymbol<TOutput>, input: TInput): Promise<TOutput>;
}

export interface AppServiceNameDescriptor {
  readonly name: string;
  readonly token: string;
  readonly publicName?: string;
}

export function normalizeAppServiceName(name: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
    const withoutInterfacePrefix = /^I[A-Z]/.test(name) ? name.slice(1) : name;
    return withoutInterfacePrefix.charAt(0).toLowerCase() + withoutInterfacePrefix.slice(1);
  }
  const segment = name.slice(Math.max(name.lastIndexOf(':'), name.lastIndexOf('/')) + 1);
  const words = segment.match(/[A-Za-z0-9]+/g) ?? [];
  if (words.length === 0) return 'service';
  const normalized = words[0]!.toLowerCase() + words.slice(1).map((word) => (
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  )).join('');
  if (!/^[A-Za-z_$]/.test(normalized)) return `service${normalized}`;
  return normalized;
}

function normalizeIdentifierWords(value: string): string {
  const words = value.match(/[A-Za-z0-9]+/g) ?? [];
  const normalized = words.length === 0
    ? 'service'
    : words[0]!.toLowerCase() + words.slice(1).map((word) =>
      word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join('');
  return /^[A-Za-z_$]/.test(normalized) ? normalized : `service${normalized}`;
}

function qualifiedAppServiceName(service: AppServiceNameDescriptor): string {
  return normalizeIdentifierWords(service.name);
}

function tokenQualifiedAppServiceName(service: AppServiceNameDescriptor): string {
  const encoded = [...service.token]
    .map((character) => character.codePointAt(0)!.toString(16))
    .join('');
  return `service_${encoded}`;
}

const RESERVED_PUBLIC_NAMES = new Set(['get', 'invoke', 'create', 'token']);

/**
 * Computes the public names for a snapshot without retaining any registry.
 * Basenames remain the ergonomic form until they would be ambiguous.
 */
export function appServicePublicNames(
  services: readonly AppServiceNameDescriptor[],
): ReadonlyMap<string, string> {
  const uniqueServices = [...services.reduce((byToken, service) => {
    const existing = byToken.get(service.token);
    if (!existing || service.name.localeCompare(existing.name) < 0) byToken.set(service.token, service);
    return byToken;
  }, new Map<string, AppServiceNameDescriptor>()).values()]
    .sort((left, right) => left.token.localeCompare(right.token));
  const explicit = new Map<string, string>();
  for (const service of uniqueServices) {
    if (service.publicName === undefined) continue;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(service.publicName)) {
      throw new TypeError(`Application service public name "${service.publicName}" is not a valid identifier.`);
    }
    const previous = explicit.get(service.publicName);
    if (previous !== undefined && previous !== service.token) {
      throw new TypeError(`Application service public name "${service.publicName}" is assigned to multiple services.`);
    }
    explicit.set(service.publicName, service.token);
  }
  const bases = new Map<string, number>();
  for (const service of uniqueServices) {
    const base = normalizeAppServiceName(service.name);
    bases.set(base, (bases.get(base) ?? 0) + 1);
  }
  const candidates = new Map<string, string>();
  for (const service of uniqueServices) {
    const base = normalizeAppServiceName(service.name);
    candidates.set(service.token, bases.get(base) === 1 ? base : qualifiedAppServiceName(service));
  }
  const candidateGroups = new Map<string, string[]>();
  for (const [token, candidate] of candidates) {
    const group = candidateGroups.get(candidate) ?? [];
    group.push(token);
    candidateGroups.set(candidate, group);
  }
  const names = new Map<string, string>();
  for (const service of uniqueServices) {
    if (service.publicName !== undefined) {
      names.set(service.token, service.publicName);
      continue;
    }
    const candidate = candidates.get(service.token)!;
    const collides = (candidateGroups.get(candidate)?.length ?? 0) > 1
      || RESERVED_PUBLIC_NAMES.has(candidate)
      || explicit.has(candidate);
    names.set(service.token, collides ? tokenQualifiedAppServiceName(service) : candidate);
  }
  return names;
}

export function appServicePublicName(
  service: AppServiceNameDescriptor,
  services: readonly AppServiceNameDescriptor[],
): string {
  return appServicePublicNames(services).get(service.token) ?? tokenQualifiedAppServiceName(service);
}

function typeName(publicName: string): string {
  return `I${publicName.charAt(0).toUpperCase() + publicName.slice(1)}`;
}

function exportedTypeNames(declaration: string): readonly string[] {
  return [...declaration.matchAll(
    /export\s+(?:declare\s+)?(?:interface|type|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
  )].map((match) => match[1]!);
}

function declarationTypeName(
  declaration: string,
  publicName: string,
  methods: readonly AppServiceMethodDescriptor[] | undefined,
): string {
  const names = exportedTypeNames(declaration);
  const conventional = new Set([
    typeName(publicName),
    publicName.charAt(0).toUpperCase() + publicName.slice(1),
  ]);
  const conventionalMatches = names.filter((name) => conventional.has(name));
  if (conventionalMatches.length === 1) return conventionalMatches[0]!;
  const methodMatches = (methods ?? []).length
    ? names.filter((name) => {
      const declarationBody = declaration.match(
        new RegExp(`(?:interface|class)\\s+${name}\\b[^{]*\\{([\\s\\S]*?)\\}`),
      )?.[1] ?? '';
      return methods!.every((method) => new RegExp(`\\b${method.name}\\s*\\(`).test(declarationBody));
    })
    : [];
  if (methodMatches.length === 1) return methodMatches[0]!;
  throw new TypeError(
    `Application service "${publicName}" declaration has no unambiguous public service type.`,
  );
}

function scopedDeclaration(
  declaration: string,
  publicName: string,
  methods: readonly AppServiceMethodDescriptor[] | undefined,
): { readonly text: string; readonly type: string } {
  const selectedType = declarationTypeName(declaration, publicName, methods);
  const namespace = `__AppService_${publicName}`;
  return {
    text: [
      `export namespace ${namespace} {`,
      ...declaration.split('\n').map((line) => `  ${line}`),
      '}',
      `export type ${typeName(publicName)} = ${namespace}.${selectedType};`,
    ].join('\n'),
    type: typeName(publicName),
  };
}

export const TypeSymbols = Object.freeze({
  create<T>(token: string): TypeSymbol<T> {
    if (typeof token !== 'string' || token.length === 0) {
      throw new TypeError('Type symbol token must be a non-empty string.');
    }
    return Symbol.for(token) as TypeSymbol<T>;
  },
  token<T>(type: TypeSymbol<T>): string {
    if (typeof type !== 'symbol') {
      throw new TypeError('Type symbol must be a symbol.');
    }
    const token = Symbol.keyFor(type);
    if (!token) throw new TypeError('Type symbol must be created with TypeSymbols.create.');
    return token;
  },
});

export function createAppServicesDeclarationText(
  snapshot: AppServicesSnapshot,
): string {
  const names = appServicePublicNames(snapshot.services);
  const declarationNameCounts = new Map<string, number>();
  for (const service of snapshot.services) {
    for (const name of exportedTypeNames(service.declaration ?? '')) {
      declarationNameCounts.set(name, (declarationNameCounts.get(name) ?? 0) + 1);
    }
  }
  const declarationTypes = new Map<string, string>();
  const declarations = snapshot.services.map((service) => {
    const normalized = names.get(service.token) ?? normalizeAppServiceName(service.name);
    if (service.declaration) {
      const mustScope = exportedTypeNames(service.declaration)
        .some((name) => (declarationNameCounts.get(name) ?? 0) > 1);
      const scoped = mustScope
        ? scopedDeclaration(service.declaration, normalized, service.methods)
        : { text: service.declaration, type: declarationTypeName(service.declaration, normalized, service.methods) };
      declarationTypes.set(service.token, scoped.type);
      const publicType = typeName(normalized);
      const publicAlias = scoped.type === publicType
        || exportedTypeNames(service.declaration).includes(publicType)
        ? ''
        : `\nexport type ${publicType} = ${scoped.type};`;
      return `${scoped.text}${publicAlias}`;
    }
    const methods = service.methods?.length
      ? service.methods.map((method) => {
        const input = method.input === undefined
          ? '()'
          : `(input: ${method.input})`;
        return `  ${method.name}: ${input} => Promise<${method.output ?? '__RuntimeGeneratedJsonValue'}>;`;
      }).join('\n')
      : '  readonly value: __RuntimeGeneratedJsonValue;';
    declarationTypes.set(service.token, typeName(normalized));
    return `export interface ${typeName(normalized)} {\n${methods}\n}`;
  });
  return [
    'type __RuntimeGeneratedJsonValue = null | boolean | number | string | __RuntimeGeneratedJsonValue[] | { [key: string]: __RuntimeGeneratedJsonValue };',
    'export type TypeSymbol<T> = symbol & { readonly __type?: (value: T) => T };',
    ...declarations,
    'export interface AppServices {',
    '  get<T>(type: TypeSymbol<T>): T | undefined;',
    '  invoke<TInput, TOutput>(type: TypeSymbol<TOutput>, input: TInput): Promise<TOutput>;',
    ...snapshot.services.map((service) => {
      const normalized = names.get(service.token) ?? normalizeAppServiceName(service.name);
      const getterName = normalized
        ? `get${normalized.charAt(0).toUpperCase() + normalized.slice(1)}`
        : 'getService';
      return `  ${getterName}(): ${declarationTypes.get(service.token) ?? typeName(normalized)};`;
    }),
    '}',
  ].join('\n');
}

export function createWorkerAppServices(
  call: (method: string, params: JsonValue) => Promise<JsonValue>,
  snapshot: AppServicesSnapshot = { services: [] },
): AppServices {
  const names = appServicePublicNames(snapshot.services);
  const descriptorByName = new Map(snapshot.services.map((service) => [
    names.get(service.token) ?? normalizeAppServiceName(service.name),
    service,
  ]));
  const serviceProxy = <T>(type: TypeSymbol<T>, descriptor?: AppServiceDescriptor): T => {
    if (!descriptor) return undefined as T;
    const token = TypeSymbols.token(type);
    const methods = new Set((descriptor.methods ?? []).map((method) => method.name));
    return new Proxy(Object.create(null), {
      get: (_target, property) => {
        if (typeof property !== 'string' || !methods.has(property)) {
          return undefined;
        }
        return (...args: JsonValue[]) =>
          call('appServices.invoke', { token, method: property, args: cloneJson(args, 'Application service arguments') });
      },
    }) as T;
  };
  const get = <T>(type: TypeSymbol<T>): T => {
    return serviceProxy(type, snapshot.services.find((service) => service.token === TypeSymbols.token(type)));
  };
  const invoke = async <TInput, TOutput>(
    type: TypeSymbol<TOutput>,
    input: TInput,
  ): Promise<TOutput> => {
    const token = TypeSymbols.token(type);
    return (await call('appServices.invoke', {
      token,
      input: cloneJson(input, 'Application service input'),
    })) as TOutput;
  };
  return new Proxy(
    { get, invoke } as AppServices,
    {
      get(target, property, receiver) {
        if (typeof property !== 'string') return Reflect.get(target, property, receiver);
        if (property in target) return Reflect.get(target, property, receiver);
        const serviceName = property.startsWith('get') && property.length > 3
          ? property.slice(3, 4).toLowerCase() + property.slice(4)
          : property;
        const descriptor = descriptorByName.get(serviceName);
        if (!descriptor) return undefined;
        return property.startsWith('get') && property.length > 3
          ? () => serviceProxy(TypeSymbols.create(descriptor.token), descriptor)
          : serviceProxy(TypeSymbols.create(descriptor.token), descriptor);
      },
    },
  );
}
