import {
  createRuntimeServiceToken,
  type RuntimeServiceBinding,
  type RuntimeServiceBindingHandle,
  type RuntimeServiceContainer,
  type RuntimeServiceToken,
} from './services.js';
import { getRuntimeServiceContainer } from './container.js';
import * as ts from 'typescript';

/** Provider methods may accept `(input, context)`: brokered TypeScript calls append the host InvocationContext as the final argument. */
export interface RuntimeCompositionMethodDescriptor {
  readonly name: string;
  readonly version?: string;
  readonly input?: string;
  readonly output?: string;
  readonly description?: string;
  readonly links?: readonly string[];
  readonly examples?: readonly string[];
}

export interface RuntimeCompositionContractDescriptor {
  readonly name: string;
  readonly version: string;
  readonly declaration?: string;
  readonly methods: readonly RuntimeCompositionMethodDescriptor[];
}

export interface RuntimeCompositionServiceDescriptor<T = unknown> {
  readonly key: string;
  readonly token: RuntimeServiceToken<T>;
  readonly contract: RuntimeCompositionContractDescriptor;
  readonly publicName?: string;
}

export interface RuntimeCompositionProviderDescriptor<T = unknown> {
  readonly id: string;
  readonly service: RuntimeCompositionServiceDescriptor<T>;
  readonly contract: RuntimeCompositionContractDescriptor;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RuntimeCompositionProviderRegistration<T = unknown> {
  readonly provider: RuntimeCompositionProviderDescriptor<T>;
  readonly binding: RuntimeServiceBinding<T>;
}

export type RuntimeCompositionProviderStatus =
  | 'active'
  | 'inactive'
  | 'overridden'
  | 'collision'
  | 'incompatible';

export interface RuntimeCompositionProviderInspection<T = unknown> {
  readonly provider: RuntimeCompositionProviderDescriptor<T>;
  readonly status: RuntimeCompositionProviderStatus;
  readonly reason?: string;
}

export interface RuntimeCompositionServiceInspection<T = unknown> {
  readonly service: RuntimeCompositionServiceDescriptor<T>;
  readonly selectedProviderId?: string;
  readonly providers: readonly RuntimeCompositionProviderInspection<T>[];
}

export interface RuntimeCompositionRegistrySnapshot {
  readonly services: readonly RuntimeCompositionServiceInspection[];
  readonly overrides: Readonly<Record<string, string>>;
}

export interface RuntimeCompositionRegistryOptions {
  readonly container?: RuntimeServiceContainer;
}

interface Registration<T> {
  readonly provider: RuntimeCompositionProviderDescriptor<T>;
  readonly binding: RuntimeServiceBinding<T>;
  readonly sequence: number;
  handle?: RuntimeServiceBindingHandle;
}

const RESERVED_PUBLIC_NAMES = new Set(['get', 'invoke', 'create', 'token']);

function validatePublicName(publicName: string | undefined): void {
  if (publicName === undefined) return;
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(publicName)) {
    throw new TypeError(`Runtime service public name "${publicName}" is not a valid identifier.`);
  }
  if (RESERVED_PUBLIC_NAMES.has(publicName)) {
    throw new TypeError(`Runtime service public name "${publicName}" is reserved.`);
  }
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}

function copyContract(
  contract: RuntimeCompositionContractDescriptor,
): RuntimeCompositionContractDescriptor {
  return freeze({
    name: contract.name,
    version: contract.version,
    ...(contract.declaration === undefined ? {} : { declaration: contract.declaration }),
    methods: contract.methods.map((method) =>
      freeze({
        name: method.name,
        ...(method.version === undefined ? {} : { version: method.version }),
        ...(method.input === undefined ? {} : { input: method.input }),
        ...(method.output === undefined ? {} : { output: method.output }),
        ...(method.description === undefined ? {} : { description: method.description }),
        ...(method.links === undefined ? {} : { links: [...method.links] }),
        ...(method.examples === undefined ? {} : { examples: [...method.examples] }),
      }),
    ),
  });
}

function copyService<T>(
  service: RuntimeCompositionServiceDescriptor<T>,
): RuntimeCompositionServiceDescriptor<T> {
  validatePublicName(service.publicName);
  return freeze({
    key: service.key,
    token: service.token,
    contract: copyContract(service.contract),
    ...(service.publicName === undefined ? {} : { publicName: service.publicName }),
  });
}

function copyProvider<T>(
  provider: RuntimeCompositionProviderDescriptor<T>,
): RuntimeCompositionProviderDescriptor<T> {
  return freeze({
    id: provider.id,
    service: copyService(provider.service),
    contract: copyContract(provider.contract),
    ...(provider.metadata ? { metadata: { ...provider.metadata } } : {}),
  });
}

interface ContractTypeContext {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly sourceFile: ts.SourceFile;
}

function createContractTypeContexts(
  declarations: readonly [string, string],
  typeExpressions: readonly [readonly string[], readonly string[]] = [[], []],
): readonly [ContractTypeContext, ContractTypeContext] {
  const source = [
    declarations[0],
    ...typeExpressions[0].map((expression, index) => `export type __RuntimeContractType${index} = ${expression};`),
  ].join('\n');
  const rightSource = [
    declarations[1],
    ...typeExpressions[1].map((expression, index) => `export type __RuntimeContractType${index} = ${expression};`),
  ].join('\n');
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    strict: true,
    skipLibCheck: true,
  };
  const defaultHost = ts.createCompilerHost(options, true);
  const files = new Map([
    ['__runtime-contract-left.ts', source],
    ['__runtime-contract-right.ts', rightSource],
  ]);
  const host: ts.CompilerHost = {
    ...defaultHost,
    getSourceFile: (requestedFileName: string, languageVersion: ts.ScriptTarget) => {
      const content = files.get(requestedFileName);
      return content === undefined
        ? defaultHost.getSourceFile(requestedFileName, languageVersion)
        : ts.createSourceFile(requestedFileName, content, languageVersion, true, ts.ScriptKind.TS);
    },
    readFile: (requestedFileName: string) => files.get(requestedFileName) ?? defaultHost.readFile(requestedFileName),
    fileExists: (requestedFileName: string) => files.has(requestedFileName) || defaultHost.fileExists(requestedFileName),
  };
  const program = ts.createProgram([...files.keys()], options, host);
  const checker = program.getTypeChecker();
  return [
    { program, checker, sourceFile: program.getSourceFile('__runtime-contract-left.ts')! },
    { program, checker, sourceFile: program.getSourceFile('__runtime-contract-right.ts')! },
  ];
}

function contextDiagnostic(context: ContractTypeContext): string | undefined {
  const diagnostics = ts.getPreEmitDiagnostics(context.program)
    .filter((diagnostic) => diagnostic.file === context.sourceFile);
  if (diagnostics.length === 0) return undefined;
  const message = ts.flattenDiagnosticMessageText(diagnostics[0]?.messageText ?? 'unknown error', ' ');
  return `Contract declaration is invalid: ${message}`;
}

function exportedTypeSymbols(
  context: ContractTypeContext,
): readonly ts.Symbol[] {
  const moduleSymbol = context.checker.getSymbolAtLocation(context.sourceFile);
  return moduleSymbol === undefined ? [] : context.checker.getExportsOfModule(moduleSymbol)
    .filter((symbol) => (symbol.flags & ts.SymbolFlags.Type) !== 0);
}

function typesEquivalent(checker: ts.TypeChecker, left: ts.Type, right: ts.Type): boolean {
  return checker.isTypeAssignableTo(left, right) && checker.isTypeAssignableTo(right, left);
}

function methodTypesEquivalent(
  leftContext: ContractTypeContext,
  rightContext: ContractTypeContext,
  left: ts.Type,
  right: ts.Type,
): boolean {
  const leftSignatures = leftContext.checker.getSignaturesOfType(left, ts.SignatureKind.Call);
  const rightSignatures = rightContext.checker.getSignaturesOfType(right, ts.SignatureKind.Call);
  if (leftSignatures.length !== rightSignatures.length) return false;
  return leftSignatures.every((leftSignature, index) => {
    const rightSignature = rightSignatures[index];
    if (rightSignature === undefined) return false;
    const leftParameters = leftSignature.getParameters();
    const rightParameters = rightSignature.getParameters();
    if (leftParameters.length !== rightParameters.length) return false;
    if (!leftParameters.every((leftParameter, parameterIndex) => {
      const rightParameter = rightParameters[parameterIndex];
      if (rightParameter === undefined) return false;
      const leftType = leftContext.checker.getTypeOfSymbolAtLocation(leftParameter, leftContext.sourceFile);
      const rightType = rightContext.checker.getTypeOfSymbolAtLocation(rightParameter, rightContext.sourceFile);
      return typesEquivalent(leftContext.checker, leftType, rightType);
    })) return false;
    if (leftParameters.some((parameter, parameterIndex) => {
      const rightParameter = rightParameters[parameterIndex]!;
      const leftDeclaration = parameter.valueDeclaration;
      const rightDeclaration = rightParameter.valueDeclaration;
      return (leftDeclaration !== undefined && ts.isParameter(leftDeclaration)
        && leftDeclaration.dotDotDotToken !== undefined)
        !== (rightDeclaration !== undefined && ts.isParameter(rightDeclaration)
          && rightDeclaration.dotDotDotToken !== undefined);
    })) return false;
    const leftReturn = leftContext.checker.getReturnTypeOfSignature(leftSignature);
    const rightReturn = rightContext.checker.getReturnTypeOfSignature(rightSignature);
    return typesEquivalent(leftContext.checker, leftReturn, rightReturn);
  });
}

function typeExpressionDifference(
  leftContext: ContractTypeContext,
  rightContext: ContractTypeContext,
  leftIndex: number,
  rightIndex: number,
): string | undefined {
  const leftSymbol = leftContext.checker.getExportsOfModule(
    leftContext.checker.getSymbolAtLocation(leftContext.sourceFile)!,
  ).find((symbol) => symbol.name === `__RuntimeContractType${leftIndex}`);
  const rightSymbol = rightContext.checker.getExportsOfModule(
    rightContext.checker.getSymbolAtLocation(rightContext.sourceFile)!,
  ).find((symbol) => symbol.name === `__RuntimeContractType${rightIndex}`);
  if (leftSymbol === undefined || rightSymbol === undefined) return 'Contract method types are unsupported.';
  const leftType = leftContext.checker.getDeclaredTypeOfSymbol(leftSymbol);
  const rightType = rightContext.checker.getDeclaredTypeOfSymbol(rightSymbol);
  return typesEquivalent(leftContext.checker, leftType, rightType)
    ? undefined
    : 'Contract method input or output types do not match.';
}

function declarationsEquivalent(
  leftContext: ContractTypeContext,
  rightContext: ContractTypeContext,
  methods: readonly RuntimeCompositionMethodDescriptor[],
): string | undefined {
  const methodNames = new Set(methods.map((method) => method.name));
  const candidates = (context: ContractTypeContext) => exportedTypeSymbols(context)
    .map((symbol) => context.checker.getDeclaredTypeOfSymbol(symbol))
    .filter((type) => {
      const properties = context.checker.getPropertiesOfType(type);
      return properties.length === methodNames.size
        && properties.every((property) => methodNames.has(property.name));
    });
  const leftCandidates = candidates(leftContext);
  const rightCandidates = candidates(rightContext);
  if (leftCandidates.length !== 1 || rightCandidates.length !== 1) {
    return 'Contract declaration must export one unambiguous interface matching the published methods.';
  }
  const leftType = leftCandidates[0]!;
  const rightType = rightCandidates[0]!;
  const leftProperties = leftContext.checker.getPropertiesOfType(leftType)
    .sort((a, b) => a.name.localeCompare(b.name));
  const rightProperties = rightContext.checker.getPropertiesOfType(rightType)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (leftProperties.length !== rightProperties.length
    || leftProperties.some((property, index) => property.name !== rightProperties[index]?.name)) {
    return 'Exported contract method shape does not match.';
  }
  for (const leftProperty of leftProperties) {
    const rightProperty = rightProperties.find((property) => property.name === leftProperty.name);
    if (rightProperty === undefined) return 'Exported contract method shape does not match.';
    if ((leftProperty.flags & ts.SymbolFlags.Optional) !== (rightProperty.flags & ts.SymbolFlags.Optional)) {
      return `Exported contract method "${leftProperty.name}" optionality does not match.`;
    }
    const leftMethod = leftContext.checker.getTypeOfSymbolAtLocation(leftProperty, leftContext.sourceFile);
    const rightMethod = rightContext.checker.getTypeOfSymbolAtLocation(rightProperty, rightContext.sourceFile);
    if (!methodTypesEquivalent(leftContext, rightContext, leftMethod, rightMethod)) {
      return `Exported contract method "${leftProperty.name}" types do not match.`;
    }
  }
  return undefined;
}

const CONTRACT_DIFFERENCE_CACHE_LIMIT = 512;
const contractDifferenceCache = new Map<string, string | undefined>();

function contractContentKey(contract: RuntimeCompositionContractDescriptor): string {
  return JSON.stringify({
    name: contract.name,
    version: contract.version,
    declaration: contract.declaration,
    methods: contract.methods
      .map(({ name, version, input, output }) => ({ name, version, input, output }))
      .sort((left, right) =>
        left.name.localeCompare(right.name)
        || (left.version ?? '').localeCompare(right.version ?? '')
        || (left.input ?? '').localeCompare(right.input ?? '')
        || (left.output ?? '').localeCompare(right.output ?? '')),
  });
}

function cachedContractDifference(
  service: RuntimeCompositionContractDescriptor,
  provider: RuntimeCompositionContractDescriptor,
): string | undefined {
  const key = `${contractContentKey(service)}\u0000${contractContentKey(provider)}`;
  if (contractDifferenceCache.has(key)) return contractDifferenceCache.get(key);
  const result = computeRuntimeCompositionContractDifference(service, provider);
  contractDifferenceCache.set(key, result);
  if (contractDifferenceCache.size > CONTRACT_DIFFERENCE_CACHE_LIMIT) {
    const oldest = contractDifferenceCache.keys().next().value;
    if (oldest !== undefined) contractDifferenceCache.delete(oldest);
  }
  return result;
}

function computeRuntimeCompositionContractDifference(
  service: RuntimeCompositionContractDescriptor,
  provider: RuntimeCompositionContractDescriptor,
): string | undefined {
  if (service.name !== provider.name) return 'Contract names do not match.';
  if (service.version !== provider.version) return 'Contract versions do not match.';
  const describeMethods = (methods: readonly RuntimeCompositionMethodDescriptor[]) => methods
    .map(({ name, version, input, output }) => ({ name, version, input, output }))
    .sort((left, right) =>
      left.name.localeCompare(right.name)
      || (left.version ?? '').localeCompare(right.version ?? '')
      || (left.input ?? '').localeCompare(right.input ?? '')
      || (left.output ?? '').localeCompare(right.output ?? ''));
  const expected = describeMethods(service.methods);
  const actual = describeMethods(provider.methods);
  if (expected.length !== actual.length || expected.some((method, index) =>
    method.name !== actual[index].name
    || method.version !== actual[index].version)) {
    return 'Contract method shape or versions do not match.';
  }
  const hasDeclarations = service.declaration !== undefined && provider.declaration !== undefined;
  if (service.declaration !== undefined && provider.declaration === undefined) {
    return 'Contract declaration is missing from the provider.';
  }
  if (service.declaration === undefined && provider.declaration !== undefined) {
    return 'Contract declaration is missing from the canonical service.';
  }
  let contexts: readonly [ContractTypeContext, ContractTypeContext] | undefined;
  if (hasDeclarations) {
    contexts = createContractTypeContexts([service.declaration!, provider.declaration!], [
      expected.flatMap((method) => [method.input, method.output])
        .filter((expression): expression is string => expression !== undefined),
      actual.flatMap((method) => [method.input, method.output])
        .filter((expression): expression is string => expression !== undefined),
    ]);
    const leftDiagnostic = contextDiagnostic(contexts[0]);
    if (leftDiagnostic) return leftDiagnostic;
    const rightDiagnostic = contextDiagnostic(contexts[1]);
    if (rightDiagnostic) return rightDiagnostic;
  }
  let leftExpressionIndex = 0;
  let rightExpressionIndex = 0;
  for (let index = 0; index < expected.length; index += 1) {
    const expectedMethod = expected[index]!;
    const actualMethod = actual[index]!;
    for (const [kind, left, right] of [
      ['input', expectedMethod.input, actualMethod.input],
      ['output', expectedMethod.output, actualMethod.output],
    ] as const) {
      if (left === undefined || right === undefined) {
        if (left !== right) return `Contract method ${kind} declarations do not match.`;
      } else if (hasDeclarations) {
        const difference = typeExpressionDifference(
          contexts![0],
          contexts![1],
          leftExpressionIndex,
          rightExpressionIndex,
        );
        if (difference) return difference;
      }
      if (left !== undefined) leftExpressionIndex += 1;
      if (right !== undefined) rightExpressionIndex += 1;
    }
  }
  if (service.declaration !== undefined && provider.declaration !== undefined) {
    const difference = declarationsEquivalent(contexts![0], contexts![1], expected);
    if (difference) return difference;
  }
  return undefined;
}

export function runtimeCompositionContractDifference(
  service: RuntimeCompositionContractDescriptor,
  provider: RuntimeCompositionContractDescriptor,
): string | undefined {
  return cachedContractDifference(service, provider);
}

function serviceKey<T>(service: RuntimeCompositionServiceDescriptor<T>): string {
  return service.key;
}

export function createRuntimeCompositionServiceDescriptor<T>(
  key: string,
  contract: RuntimeCompositionContractDescriptor,
  publicName?: string,
): RuntimeCompositionServiceDescriptor<T> {
  return copyService({
    key,
    token: createRuntimeServiceToken<T>(key),
    contract,
    ...(publicName === undefined ? {} : { publicName }),
  });
}

export class RuntimeCompositionRegistry {
  private readonly container: RuntimeServiceContainer;
  private readonly registrations = new Map<string, Registration<unknown>[]>();
  private readonly services = new Map<string, RuntimeCompositionServiceDescriptor>();
  private readonly overrides = new Map<string, string>();
  private sequence = 0;

  constructor(options: RuntimeCompositionRegistryOptions = {}) {
    this.container = options.container ?? getRuntimeServiceContainer();
  }

  async registerProvider<T>(
    registration: RuntimeCompositionProviderRegistration<T>,
  ): Promise<RuntimeServiceBindingHandle> {
    const provider = copyProvider(registration.provider);
    const key = serviceKey(provider.service);
    const service = this.services.get(key);
    for (const existing of this.services.values()) {
      if (existing.key !== key && existing.publicName !== undefined
        && provider.service.publicName !== undefined
        && existing.publicName === provider.service.publicName) {
        throw new Error(
          `Runtime service public name "${provider.service.publicName}" collides with service ${existing.key}.`,
        );
      }
    }
    if (service && service.token !== provider.service.token) {
      throw new Error(`Runtime service key collision: ${key}`);
    }
    const entries = this.registrations.get(key) ?? [];
    if (entries.some((entry) => entry.provider.id === provider.id)) {
      throw new Error(`Runtime service provider ${provider.id} is already registered.`);
    }
    const canonical = (service && service.publicName === undefined && provider.service.publicName !== undefined
      ? copyService({ ...service, publicName: provider.service.publicName })
      : service ?? provider.service) as RuntimeCompositionServiceDescriptor<unknown>;
    const serviceContractDifference = runtimeCompositionContractDifference(
      canonical.contract,
      provider.service.contract,
    );
    if (serviceContractDifference) {
      throw new Error(
        `Runtime service provider ${provider.id} has an incompatible service contract: ${serviceContractDifference}`,
      );
    }
    const providerContractDifference = runtimeCompositionContractDifference(
      canonical.contract,
      provider.contract,
    );
    if (providerContractDifference) {
      throw new Error(
        `Runtime service provider ${provider.id} has an incompatible contract: ${providerContractDifference}`,
      );
    }
    const previousService = service;
    const previousEntries = entries.slice();
    const previousSequence = this.sequence;
    this.services.set(key, canonical);
    const entry: Registration<T> = {
      provider,
      binding: registration.binding,
      sequence: ++this.sequence,
    };
    entries.push(entry as Registration<unknown>);
    this.registrations.set(key, entries);
    try {
      const handle = await this.refresh(canonical);
      return {
        dispose: async () => {
          await this.unregisterProvider(canonical, provider.id);
        },
      };
    } catch (error) {
      this.sequence = previousSequence;
      if (previousService) this.services.set(key, previousService);
      else this.services.delete(key);
      if (previousEntries.length) this.registrations.set(key, previousEntries);
      else this.registrations.delete(key);
      throw error;
    }
  }

  async unregisterProvider(
    service: RuntimeCompositionServiceDescriptor,
    providerId: string,
  ): Promise<void> {
    const key = serviceKey(service);
    const entries = this.registrations.get(key) ?? [];
    const retained = entries.filter((entry) => entry.provider.id !== providerId);
    if (retained.length === entries.length) return;
    const previousEntries = entries.slice();
    const previousService = this.services.get(key);
    try {
      for (const entry of entries) {
        if (!retained.includes(entry) && entry.handle) {
          await entry.handle.dispose();
          entry.handle = undefined;
        }
      }
      if (retained.length) this.registrations.set(key, retained);
      else {
        this.registrations.delete(key);
        this.services.delete(key);
      }
      await this.refresh(service);
    } catch (error) {
      if (previousService) this.services.set(key, previousService);
      if (previousEntries.length) this.registrations.set(key, previousEntries);
      else this.registrations.delete(key);
      throw error;
    }
  }

  async setProviderOverride(
    service: RuntimeCompositionServiceDescriptor,
    providerId: string,
  ): Promise<void> {
    const key = serviceKey(service);
    const previous = this.overrides.get(key);
    this.overrides.set(key, providerId);
    try {
      await this.refresh(service);
    } catch (error) {
      if (previous === undefined) this.overrides.delete(key);
      else this.overrides.set(key, previous);
      throw error;
    }
  }

  async clearProviderOverride(service: RuntimeCompositionServiceDescriptor): Promise<void> {
    const key = serviceKey(service);
    const previous = this.overrides.get(key);
    this.overrides.delete(key);
    try {
      await this.refresh(service);
    } catch (error) {
      if (previous !== undefined) this.overrides.set(key, previous);
      throw error;
    }
  }

  list(): readonly RuntimeCompositionServiceInspection[] {
    return this.snapshot().services;
  }

  inspect(service: RuntimeCompositionServiceDescriptor): RuntimeCompositionServiceInspection | undefined {
    return this.snapshot().services.find((entry) => entry.service.key === service.key);
  }

  snapshot(): RuntimeCompositionRegistrySnapshot {
    const services = [...this.services.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((service) => this.inspectService(service));
    return freeze({
      services,
      overrides: Object.fromEntries([...this.overrides].sort(([left], [right]) => left.localeCompare(right))),
    });
  }

  private inspectService(service: RuntimeCompositionServiceDescriptor): RuntimeCompositionServiceInspection {
    const entries = this.registrations.get(service.key) ?? [];
    const compatible = entries.filter(
      (entry) => !runtimeCompositionContractDifference(service.contract, entry.provider.contract),
    );
    const override = this.overrides.get(service.key);
    const selected = override
      ? compatible.find((entry) => entry.provider.id === override)
      : compatible.sort((left, right) => right.sequence - left.sequence)[0];
    const ids = new Set<string>();
    return freeze({
      service,
      ...(selected ? { selectedProviderId: selected.provider.id } : {}),
      providers: entries.map((entry) => {
        const difference = runtimeCompositionContractDifference(service.contract, entry.provider.contract);
        let status: RuntimeCompositionProviderStatus = difference
          ? 'incompatible'
          : selected === entry
            ? override
              ? 'overridden'
              : 'active'
            : 'inactive';
        if (!difference && ids.has(entry.provider.id)) status = 'collision';
        ids.add(entry.provider.id);
        return freeze({
          provider: entry.provider,
          status,
          ...(difference ? { reason: difference } : {}),
          ...(override && !selected && entry.provider.id === override
            ? { reason: 'Explicit override is not compatible or is not registered.' }
            : {}),
        });
      }),
    });
  }

  private async refresh(service: RuntimeCompositionServiceDescriptor): Promise<RuntimeServiceBindingHandle> {
    const inspection = this.inspectService(service);
    const selected = inspection.selectedProviderId;
    const entries = this.registrations.get(service.key) ?? [];
    const entry = entries.find(
      (candidate) => candidate.provider.id === selected,
    );
    const active = entries.find((candidate) => candidate.handle);
    if (!entry) {
      return { dispose: async () => undefined };
    }
    if (active === entry && entry.handle) return entry.handle;

    const handle = active
      ? await this.container.replace(service.token, entry.binding)
      : await this.container.bind(service.token, entry.binding);
    try {
      for (const candidate of entries) {
        if (candidate !== entry && candidate.handle) {
          await candidate.handle.dispose();
          candidate.handle = undefined;
        }
      }
    } catch (error) {
      try {
        await handle.dispose();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Failed to refresh runtime service ${service.key}.`,
        );
      }
      throw error;
    }
    entry.handle = handle;
    return handle;
  }
}

export const RuntimeServiceProviderRegistry = RuntimeCompositionRegistry;
