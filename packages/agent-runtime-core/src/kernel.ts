import {
  assertSupportedProtocolVersion,
  DuplicateCapabilityError,
  DuplicateProviderError,
  InvalidCapabilityDescriptorError,
  requireRuntimeCatalogId,
  RUNTIME_CATALOG_ID_MAX_LENGTH,
  RUNTIME_PROTOCOL_VERSION,
} from './contracts.js';
import type {
  CapabilityDescriptor,
  CapabilityInvocationResult,
  CapabilityProvider,
  Disposable,
  InvocationContext,
  PermissionBroker,
  PermissionDecision,
  RuntimeCapabilityDescriptor,
  RuntimeCatalogEntry,
  RuntimeCatalogProvider,
  RuntimeCatalogSearchMatch,
  RuntimeError,
  RuntimeExecRequest,
  RuntimeExecResponse,
  RuntimeExecuteRequest,
  RuntimeExecutionReceipt,
  RuntimeExecutionStatus,
  RuntimeProviderIdentity,
  RuntimeReceiptSink,
  RuntimeSearchDetail,
  RuntimeSearchRequest,
  RuntimeSearchMatch,
  RuntimeSearchResponse,
  RuntimeCapabilitySummary,
} from './contracts.js';
import { resolveRuntimeReceiptCorrelations } from './correlations.js';
import { resolveExecutionLineage } from './receipts.js';
import {
  type AnyRuntimeLifecycleEvent,
  createLifecycleEvent,
  RuntimeLifecycleBus,
  type RuntimeLifecycleEventType,
  type RuntimeLifecycleListener,
  type RuntimeLifecyclePayloads,
  type RuntimeLifecyclePublisher,
} from './lifecycle.js';
import { rankCapability, rankCatalogEntry } from './ranking.js';
import { assertRuntimeOutputSchema } from './schemaValidation.js';

interface ProviderRegistration {
  readonly provider: CapabilityProvider;
  readonly order: number;
}

interface CatalogProviderRegistration {
  readonly provider: RuntimeCatalogProvider;
  readonly order: number;
}

interface RuntimeKernelContributionState {
  readonly providers: readonly ProviderRegistration[];
  readonly catalogProviders: readonly CatalogProviderRegistration[];
  active: boolean;
}

export interface RuntimeKernelContributionSet {
  readonly providers?: readonly CapabilityProvider[];
  readonly catalogProviders?: readonly RuntimeCatalogProvider[];
}

/**
 * Ownership-scoped registration for one atomic contribution set. Replacing a
 * registration validates the next set before changing live discovery.
 */
export interface RuntimeKernelContributionRegistration extends Disposable {
  readonly providerIds: readonly string[];
  readonly catalogProviderIds: readonly string[];
  replace(
    contributions: RuntimeKernelContributionSet,
    context: InvocationContext,
  ): Promise<RuntimeKernelContributionRegistration>;
}

export interface RuntimeKernelOptions {
  readonly permissionBroker?: PermissionBroker;
  readonly catalogProviders?: readonly RuntimeCatalogProvider[];
  readonly lifecycle?: RuntimeLifecyclePublisher;
  readonly eventBus?: RuntimeLifecycleBus;
  readonly now?: () => Date;
  readonly createId?: (kind: 'execution' | 'receipt' | 'event') => string;
  /** Observational append-only receipt sink. Sink failures never alter execution. */
  readonly receiptSink?: RuntimeReceiptSink;
}

/** Default operation target used to hand source modules to an executor provider. */
export const INLINE_MODULE_EXECUTOR_CAPABILITY = 'runtime.inline_module.execute';
/** Default operation target used for inline, workspace-file, or artifact modules. */
export const MODULE_EXECUTOR_CAPABILITY = 'runtime.module.execute';
/**
 * Tag for plumbing other capabilities call. Broad searches omit it so agents
 * see one tool per job; exact-name lookup and invocation still work.
 */
export const INTERNAL_CAPABILITY_TAG = 'internal';

const REQUIRE_EXPLICIT_PERMISSION_BROKER: PermissionBroker = {
  decide: () => ({
    decision: 'deny',
    reason: 'No permission broker was configured for this runtime.',
    code: 'permission_broker_required',
  }),
};

/**
 * Explicit development/test escape hatch. Production hosts should inject a
 * policy broker that evaluates every descriptor requirement.
 */
export function createAllowAllPermissionBroker(): PermissionBroker {
  return {
    decide: () => ({ decision: 'allow', reason: 'Explicit allow-all broker.' }),
  };
}

let fallbackIdSequence = 0;

function defaultCreateId(kind: 'execution' | 'receipt' | 'event'): string {
  fallbackIdSequence += 1;
  return `${kind}-${Date.now().toString(36)}-${fallbackIdSequence.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function providerIdentity(provider: CapabilityProvider): RuntimeProviderIdentity {
  return { id: provider.id, version: provider.version };
}

function serializeError(error: unknown, code = 'capability_execution_failed'): RuntimeError {
  if (error instanceof Error) {
    const typedCode = 'code' in error && typeof error.code === 'string' && error.code.trim()
      ? error.code
      : code;
    return { code: typedCode, message: error.message || error.name };
  }
  return { code, message: typeof error === 'string' ? error : 'Unknown runtime error.' };
}

function validateDescriptor(descriptor: CapabilityDescriptor, providerId: string): void {
  assertSupportedProtocolVersion(descriptor.protocolVersion);
  if (!descriptor.name.trim()) {
    throw new InvalidCapabilityDescriptorError(
      `Provider "${providerId}" returned a capability with an empty name.`,
    );
  }
  if (!descriptor.version.trim()) {
    throw new InvalidCapabilityDescriptorError(
      `Capability "${descriptor.name}" from provider "${providerId}" has an empty version.`,
    );
  }
  if (!descriptor.description.trim()) {
    throw new InvalidCapabilityDescriptorError(
      `Capability "${descriptor.name}" from provider "${providerId}" has an empty description.`,
    );
  }
  if (!isStrictObjectOutputSchema(descriptor.outputSchema)) {
    throw new InvalidCapabilityDescriptorError(
      `Capability "${descriptor.name}" from provider "${providerId}" must declare an outputSchema with type "object", explicit properties, and additionalProperties false.`,
    );
  }
}

function validateCatalogProviders(
  providers: readonly RuntimeCatalogProvider[],
): readonly RuntimeCatalogProvider[] {
  const ids = new Set<string>();
  for (const provider of providers) {
    if (!provider.id.trim()) {
      throw new InvalidCapabilityDescriptorError('Catalog provider id cannot be empty.');
    }
    if (ids.has(provider.id)) {
      throw new DuplicateProviderError(`catalog:${provider.id}`);
    }
    ids.add(provider.id);
  }
  return [...providers];
}

function validateCatalogEntry(entry: RuntimeCatalogEntry, providerId: string): void {
  if (!entry.id.trim()) {
    throw new InvalidCapabilityDescriptorError(
      `Catalog provider "${providerId}" returned an entry with an empty id.`,
    );
  }
  if (entry.id.length > RUNTIME_CATALOG_ID_MAX_LENGTH) {
    throw new InvalidCapabilityDescriptorError(
      `Catalog entry id from provider "${providerId}" exceeds ${RUNTIME_CATALOG_ID_MAX_LENGTH} characters.`,
    );
  }
  if (!entry.title.trim()) {
    throw new InvalidCapabilityDescriptorError(
      `Catalog entry "${entry.id}" from provider "${providerId}" has an empty title.`,
    );
  }
  if (!entry.description.trim()) {
    throw new InvalidCapabilityDescriptorError(
      `Catalog entry "${entry.id}" from provider "${providerId}" has an empty description.`,
    );
  }
  if (!entry.action || typeof entry.action !== 'object') {
    throw new InvalidCapabilityDescriptorError(
      `Catalog entry "${entry.id}" from provider "${providerId}" must declare an action.`,
    );
  }
}

function isStrictObjectOutputSchema(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
  const record = schema as Readonly<Record<string, unknown>>;
  return record.type === 'object'
    && Boolean(record.properties)
    && typeof record.properties === 'object'
    && !Array.isArray(record.properties)
    && record.additionalProperties === false;
}

interface CapabilityOwner {
  readonly id: string;
  readonly fallback: boolean;
}

function capabilityOwner(provider: CapabilityProvider): CapabilityOwner {
  return { id: provider.id, fallback: provider.fallback === true };
}

/** The owners that count for one name: fallback providers drop out as soon as any other provider declares it. */
function effectiveCapabilityOwners(owners: readonly CapabilityOwner[]): readonly CapabilityOwner[] {
  return owners.some((owner) => !owner.fallback) ? owners.filter((owner) => !owner.fallback) : owners;
}

function withProvider(
  descriptor: CapabilityDescriptor,
  provider: CapabilityProvider,
): RuntimeCapabilityDescriptor {
  validateDescriptor(descriptor, provider.id);
  return { ...descriptor, provider: providerIdentity(provider) };
}

/** Portable capability registry and execution broker. */
export class RuntimeKernel {
  private readonly providers = new Map<string, ProviderRegistration>();
  private readonly permissionBroker: PermissionBroker;
  private readonly catalogProviders = new Map<string, CatalogProviderRegistration>();
  private readonly lifecycle?: RuntimeLifecyclePublisher;
  readonly events: RuntimeLifecycleBus;
  private readonly now: () => Date;
  private readonly createId: RuntimeKernelOptions['createId'] &
    ((kind: 'execution' | 'receipt' | 'event') => string);
  private readonly receiptSink?: RuntimeReceiptSink;
  private readonly pendingLifecycleEmissions = new Set<Promise<void>>();
  private readonly lifecycleEmissionFailures: unknown[] = [];
  private registrationSequence = 0;

  constructor(options: RuntimeKernelOptions = {}) {
    this.permissionBroker = options.permissionBroker ?? REQUIRE_EXPLICIT_PERMISSION_BROKER;
    for (const provider of validateCatalogProviders(options.catalogProviders ?? [])) {
      this.registrationSequence += 1;
      this.catalogProviders.set(provider.id, {
        provider,
        order: this.registrationSequence,
      });
    }
    this.lifecycle = options.lifecycle;
    this.events = options.eventBus ?? new RuntimeLifecycleBus();
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? defaultCreateId;
    this.receiptSink = options.receiptSink;
  }

  /** Subscribe to every event emitted by this kernel. */
  observeLifecycle(listener: RuntimeLifecycleListener): Disposable {
    return this.events.subscribe('*', listener);
  }

  register(provider: CapabilityProvider): Disposable {
    if (!provider.id.trim()) {
      throw new InvalidCapabilityDescriptorError('Provider id cannot be empty.');
    }
    if (this.providers.has(provider.id)) {
      throw new DuplicateProviderError(provider.id);
    }
    this.registrationSequence += 1;
    this.providers.set(provider.id, {
      provider,
      order: this.registrationSequence,
    });
    this.emitDetached('runtime.provider.registered', {
      providerId: provider.id,
      providerVersion: provider.version,
    });

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        const registration = this.providers.get(provider.id);
        if (registration?.provider !== provider) return;
        this.providers.delete(provider.id);
        this.emitDetached('runtime.provider.disposed', {
          providerId: provider.id,
        });
      },
    };
  }

  /** Wait for provider lifecycle events started by synchronous registration APIs. */
  async drainLifecycleEmissions(): Promise<void> {
    while (this.pendingLifecycleEmissions.size > 0) {
      await Promise.all([...this.pendingLifecycleEmissions]);
    }
    if (this.lifecycleEmissionFailures.length > 0) {
      const failures = this.lifecycleEmissionFailures.splice(0);
      throw new AggregateError(failures, 'Runtime lifecycle emission failed.');
    }
  }

  /**
   * Validates and atomically publishes capability and catalog providers under
   * one disposable ownership boundary.
   */
  async registerContributions(
    contributions: RuntimeKernelContributionSet,
    context: InvocationContext,
  ): Promise<RuntimeKernelContributionRegistration> {
    const prepared = await this.prepareContributions(contributions, context);
    const state = this.commitContributions(prepared);
    return this.contributionHandle(state);
  }

  async list(context: InvocationContext): Promise<readonly RuntimeCapabilityDescriptor[]> {
    const listings: { descriptor: RuntimeCapabilityDescriptor; provider: CapabilityProvider }[] = [];
    const owners = new Map<string, CapabilityOwner[]>();
    for (const { provider } of this.orderedProviders()) {
      const listed = await provider.list(context);
      for (const descriptor of listed) {
        const resolved = withProvider(descriptor, provider);
        listings.push({ descriptor: resolved, provider });
        const providerOwners = owners.get(resolved.name) ?? [];
        providerOwners.push(capabilityOwner(provider));
        owners.set(resolved.name, providerOwners);
      }
    }
    for (const [name, providerOwners] of owners) {
      const effective = effectiveCapabilityOwners(providerOwners);
      if (effective.length > 1) {
        throw new DuplicateCapabilityError(name, effective.map((owner) => owner.id));
      }
    }
    const descriptors = listings
      .filter(({ descriptor, provider }) => {
        const effective = effectiveCapabilityOwners(owners.get(descriptor.name) ?? []);
        return effective.some((owner) => owner.id === provider.id);
      })
      .map(({ descriptor }) => descriptor);
    return descriptors.sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.provider.id.localeCompare(right.provider.id),
    );
  }

  async get(
    name: string,
    context: InvocationContext,
  ): Promise<RuntimeCapabilityDescriptor | undefined> {
    const matches: RuntimeCapabilityDescriptor[] = [];
    const matchOwners: CapabilityOwner[] = [];
    for (const { provider } of this.orderedProviders()) {
      const descriptor = provider.get
        ? await provider.get(name, context)
        : (await provider.list(context)).find((candidate) => candidate.name === name);
      if (!descriptor) continue;
      if (descriptor.name !== name) {
        throw new InvalidCapabilityDescriptorError(
          `Provider "${provider.id}" returned "${descriptor.name}" when asked for "${name}".`,
        );
      }
      matches.push(withProvider(descriptor, provider));
      matchOwners.push(capabilityOwner(provider));
    }
    const effective = effectiveCapabilityOwners(matchOwners);
    const kept = matches.filter((match) => effective.some((owner) => owner.id === match.provider.id));
    if (kept.length > 1) {
      throw new DuplicateCapabilityError(name, kept.map((match) => match.provider.id));
    }
    return kept[0];
  }

  async runtimeSearch(
    request: RuntimeSearchRequest,
    context: InvocationContext,
  ): Promise<RuntimeSearchResponse> {
    assertSupportedProtocolVersion(request.protocolVersion);
    const exactName = request.name?.trim();
    const exactCatalogId = request.catalogId === undefined
      ? undefined
      : requireRuntimeCatalogId(request.catalogId);
    if (request.name !== undefined && !exactName) {
      throw new TypeError('Runtime capability name must be non-empty when supplied.');
    }
    if (exactName && exactCatalogId) {
      throw new TypeError('Runtime search cannot combine capability name and catalog id.');
    }
    if (request.detail !== undefined && request.detail !== 'summary' && request.detail !== 'full') {
      throw new TypeError('Runtime search detail must be "summary" or "full" when supplied.');
    }
    const query = request.query?.trim() ?? exactName ?? exactCatalogId ?? '';
    const rankingQuery = exactName ?? exactCatalogId ?? query;
    const detail: RuntimeSearchDetail = exactName || exactCatalogId
      ? 'full'
      : (request.detail ?? 'summary');
    const requiredTags = (request.tags ?? []).map((tag) => tag.toLocaleLowerCase());
    const providerIds = request.providerIds ? new Set(request.providerIds) : undefined;
    const minScore = request.minScore ?? 0;
    const limit = Math.max(0, Math.floor(request.limit ?? 20));
    const capabilities = exactCatalogId
      ? []
      : exactName
      ? [await this.get(exactName, context)].filter(
          (capability): capability is RuntimeCapabilityDescriptor => capability !== undefined,
        )
      : await this.list(context);
    const rankedMatches = capabilities
      .filter((capability) => !providerIds || providerIds.has(capability.provider.id))
      .filter((capability) => {
        const tags = new Set((capability.tags ?? []).map((tag) => tag.toLocaleLowerCase()));
        if (
          !exactName
          && tags.has(INTERNAL_CAPABILITY_TAG)
          && !requiredTags.includes(INTERNAL_CAPABILITY_TAG)
        ) {
          return false;
        }
        return requiredTags.every((tag) => tags.has(tag));
      })
      .map((capability) => rankCapability(capability, rankingQuery))
      .filter(
        (match): match is RuntimeSearchMatch<RuntimeCapabilityDescriptor> =>
          match !== undefined && match.score >= minScore,
      )
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.capability.name.localeCompare(right.capability.name) ||
          left.capability.provider.id.localeCompare(right.capability.provider.id),
      )
      .slice(0, limit);
    const matches = detail === 'full'
      ? rankedMatches
      : rankedMatches.map((match) => ({
          ...match,
          capability: summarizeCapability(match.capability),
        }));
    const discoveries = exactName
      ? []
      : await this.searchCatalog(exactCatalogId, rankingQuery, requiredTags, minScore, limit, context);

    await this.emit(
      'runtime.search.completed',
      { query, resultCount: matches.length + discoveries.length },
      context,
    );
    return {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      query,
      detail,
      matches,
      ...(discoveries.length > 0 ? { discoveries } : {}),
    };
  }

  /** Alias designed for direct harness adapters. */
  search(
    request: RuntimeSearchRequest,
    context: InvocationContext,
  ): Promise<RuntimeSearchResponse> {
    return this.runtimeSearch(request, context);
  }

  /**
   * Adapter-facing execution entry point. Source modules are routed through a
   * normal capability so compilation and isolation remain replaceable.
   */
  execute<TOutput = unknown>(
    request: RuntimeExecuteRequest,
    context: InvocationContext,
  ): Promise<RuntimeExecResponse<TOutput>> {
    if (request.targetType === 'operation') {
      return this.runtimeExec<TOutput>(request, context);
    }
    const isInline = request.targetType === 'inline_module';
    return this.runtimeExec<TOutput>(
      {
        protocolVersion: request.protocolVersion,
        target:
          request.target?.trim() ||
          (isInline ? INLINE_MODULE_EXECUTOR_CAPABILITY : MODULE_EXECUTOR_CAPABILITY),
        input: {
          ...(isInline ? { source: request.source } : { module: request.module }),
          input: request.input,
          executionMode: request.executionMode,
        },
        requestId: request.requestId,
        approval: request.approval,
      },
      context,
    );
  }

  async runtimeExec<TOutput = unknown>(
    request: RuntimeExecRequest,
    context: InvocationContext,
  ): Promise<RuntimeExecResponse<TOutput>> {
    assertSupportedProtocolVersion(request.protocolVersion);
    const started = this.now();
    const executionId = request.requestId ?? context.executionId ?? this.createId('execution');
    const executionContext: InvocationContext = {
      ...context,
      executionId,
      lineage: resolveExecutionLineage(executionId, context),
      approval: request.approval,
    };

    if (context.signal?.aborted) {
      return this.finish(request, executionContext, started, 'cancelled', undefined, undefined, {
        code: 'execution_cancelled',
        message: 'Execution was cancelled.',
      });
    }

    let capability: RuntimeCapabilityDescriptor | undefined;
    try {
      capability = await this.get(request.target, executionContext);
    } catch (error) {
      return this.finish(
        request,
        executionContext,
        started,
        'failed',
        undefined,
        undefined,
        serializeError(error, 'capability_resolution_failed'),
      );
    }

    if (!capability) {
      return this.finish(request, executionContext, started, 'not_found', undefined, undefined, {
        code: 'capability_not_found',
        message: `Capability "${request.target}" was not found.`,
      });
    }

    let permission: PermissionDecision;
    try {
      permission = await this.permissionBroker.decide({
        capability,
        request,
        context: executionContext,
        requirements: capability.permissions ?? [],
      });
    } catch (error) {
      return this.finish(
        request,
        executionContext,
        started,
        'failed',
        capability,
        undefined,
        serializeError(error, 'permission_broker_failed'),
      );
    }

    await this.emit(
      'runtime.execution.permission',
      { executionId, target: request.target, decision: permission },
      executionContext,
    );

    if (permission.decision === 'deny') {
      return this.finish(request, executionContext, started, 'denied', capability, permission, {
        code: permission.code ?? 'permission_denied',
        message: permission.reason,
      });
    }

    if (permission.decision === 'approval') {
      return this.finish(
        request,
        executionContext,
        started,
        'approval_required',
        capability,
        permission,
        undefined,
        undefined,
        permission,
      );
    }

    const registration = this.providers.get(capability.provider.id);
    if (!registration) {
      return this.finish(request, executionContext, started, 'failed', capability, permission, {
        code: 'provider_disposed',
        message: `Provider "${capability.provider.id}" was disposed before invocation.`,
      });
    }

    if (executionContext.signal?.aborted) {
      return this.finish(request, executionContext, started, 'cancelled', capability, permission, {
        code: 'execution_cancelled',
        message: 'Execution was cancelled before provider invocation.',
      });
    }

    await this.emit(
      'runtime.execution.started',
      {
        executionId,
        target: request.target,
        providerId: capability.provider.id,
      },
      executionContext,
    );

    // RuntimeAbortSignal is intentionally structural: adapters do not need to
    // supply DOM event methods. Re-read it at the final side-effect boundary so
    // cancellation during discovery, permission checks, or lifecycle emission
    // cannot start provider work.
    if (executionContext.signal?.aborted) {
      return this.finish(request, executionContext, started, 'cancelled', capability, permission, {
        code: 'execution_cancelled',
        message: 'Execution was cancelled before provider invocation.',
      });
    }

    try {
      const result = (await registration.provider.invoke(
        request.target,
        request.input,
        executionContext,
      )) as CapabilityInvocationResult<TOutput>;
      if (executionContext.signal?.aborted) {
        return this.finish(request, executionContext, started, 'cancelled', capability, permission, {
          code: 'execution_cancelled',
          message: 'Execution was cancelled while the provider was running.',
        });
      }
      assertRuntimeOutputSchema(result.output, capability.outputSchema);
      return this.finish(
        request,
        executionContext,
        started,
        'success',
        capability,
        permission,
        undefined,
        result,
      );
    } catch (error) {
      const nestedApproval = nestedApprovalDecision(error);
      if (nestedApproval) {
        return this.finish(
          request,
          executionContext,
          started,
          'approval_required',
          capability,
          permission,
          undefined,
          undefined,
          nestedApproval,
        );
      }
      const status = executionContext.signal?.aborted ? 'cancelled' : 'failed';
      return this.finish(
        request,
        executionContext,
        started,
        status,
        capability,
        permission,
        serializeError(
          error,
          status === 'cancelled' ? 'execution_cancelled' : 'capability_execution_failed',
        ),
      );
    }

    function nestedApprovalDecision(
      error: unknown,
    ): Extract<PermissionDecision, { decision: 'approval' }> | undefined {
      if (!error || typeof error !== 'object' || !('approval' in error)) return undefined;
      const approval = error.approval;
      if (
        !approval
        || typeof approval !== 'object'
        || !('decision' in approval)
        || approval.decision !== 'approval'
      ) return undefined;
      return approval as Extract<PermissionDecision, { decision: 'approval' }>;
    }
  }

  private orderedProviders(): readonly ProviderRegistration[] {
    return [...this.providers.values()].sort((left, right) => left.order - right.order);
  }

  private orderedCatalogProviders(): readonly CatalogProviderRegistration[] {
    return [...this.catalogProviders.values()].sort((left, right) => left.order - right.order);
  }

  private async prepareContributions(
    contributions: RuntimeKernelContributionSet,
    context: InvocationContext,
    replacing?: RuntimeKernelContributionState,
  ): Promise<{
    readonly providers: readonly CapabilityProvider[];
    readonly catalogProviders: readonly RuntimeCatalogProvider[];
  }> {
    this.assertContributionStateActive(replacing);
    assertContributionRegistrationNotCancelled(context);
    const providers = [...(contributions.providers ?? [])];
    const catalogProviders = validateCatalogProviders(contributions.catalogProviders ?? []);
    const replacedProviders = new Set(replacing?.providers ?? []);
    const replacedCatalogProviders = new Set(replacing?.catalogProviders ?? []);
    const providerIds = new Set<string>();
    const catalogProviderIds = new Set<string>();

    for (const provider of providers) {
      if (!provider.id.trim()) {
        throw new InvalidCapabilityDescriptorError('Provider id cannot be empty.');
      }
      if (providerIds.has(provider.id)) throw new DuplicateProviderError(provider.id);
      providerIds.add(provider.id);
      const existing = this.providers.get(provider.id);
      if (existing && !replacedProviders.has(existing)) {
        throw new DuplicateProviderError(provider.id);
      }
    }
    for (const provider of catalogProviders) {
      if (catalogProviderIds.has(provider.id)) {
        throw new DuplicateProviderError(`catalog:${provider.id}`);
      }
      catalogProviderIds.add(provider.id);
      const existing = this.catalogProviders.get(provider.id);
      if (existing && !replacedCatalogProviders.has(existing)) {
        throw new DuplicateProviderError(`catalog:${provider.id}`);
      }
    }

    const capabilityOwners = new Map<string, CapabilityOwner[]>();
    for (const registration of this.orderedProviders()) {
      if (replacedProviders.has(registration)) continue;
      await collectCapabilityOwners(registration.provider);
    }
    for (const provider of providers) await collectCapabilityOwners(provider);
    assertContributionRegistrationNotCancelled(context);
    for (const [name, owners] of capabilityOwners) {
      const effective = effectiveCapabilityOwners(owners);
      if (effective.length > 1) throw new DuplicateCapabilityError(name, effective.map((owner) => owner.id));
    }

    const catalogOwners = new Map<string, string[]>();
    for (const registration of this.orderedCatalogProviders()) {
      if (replacedCatalogProviders.has(registration)) continue;
      await collectCatalogOwners(registration.provider);
    }
    for (const provider of catalogProviders) await collectCatalogOwners(provider);
    assertContributionRegistrationNotCancelled(context);
    for (const [id, owners] of catalogOwners) {
      if (owners.length > 1) throw new DuplicateCapabilityError(`catalog:${id}`, owners);
    }
    return { providers, catalogProviders };

    async function collectCapabilityOwners(provider: CapabilityProvider): Promise<void> {
      for (const descriptor of await provider.list(context)) {
        validateDescriptor(descriptor, provider.id);
        const owners = capabilityOwners.get(descriptor.name) ?? [];
        owners.push(capabilityOwner(provider));
        capabilityOwners.set(descriptor.name, owners);
      }
      assertContributionRegistrationNotCancelled(context);
    }

    async function collectCatalogOwners(provider: RuntimeCatalogProvider): Promise<void> {
      for (const entry of await provider.list(context)) {
        validateCatalogEntry(entry, provider.id);
        const owners = catalogOwners.get(entry.id) ?? [];
        owners.push(provider.id);
        catalogOwners.set(entry.id, owners);
      }
      assertContributionRegistrationNotCancelled(context);
    }
  }

  private commitContributions(
    contributions: {
      readonly providers: readonly CapabilityProvider[];
      readonly catalogProviders: readonly RuntimeCatalogProvider[];
    },
    replacing?: RuntimeKernelContributionState,
  ): RuntimeKernelContributionState {
    this.assertContributionStateActive(replacing);
    if (replacing) {
      for (const registration of replacing.providers) {
        if (this.providers.get(registration.provider.id) !== registration) {
          throw new Error('Runtime contribution registration is no longer active.');
        }
      }
      for (const registration of replacing.catalogProviders) {
        if (this.catalogProviders.get(registration.provider.id) !== registration) {
          throw new Error('Runtime contribution registration is no longer active.');
        }
      }
    }

    const providers = contributions.providers.map((provider) => {
      this.registrationSequence += 1;
      return { provider, order: this.registrationSequence };
    });
    const catalogProviders = contributions.catalogProviders.map((provider) => {
      this.registrationSequence += 1;
      return { provider, order: this.registrationSequence };
    });

    if (replacing) {
      replacing.active = false;
      for (const registration of replacing.providers) {
        this.providers.delete(registration.provider.id);
      }
      for (const registration of replacing.catalogProviders) {
        this.catalogProviders.delete(registration.provider.id);
      }
    }
    for (const registration of providers) {
      this.providers.set(registration.provider.id, registration);
    }
    for (const registration of catalogProviders) {
      this.catalogProviders.set(registration.provider.id, registration);
    }

    const state: RuntimeKernelContributionState = {
      providers,
      catalogProviders,
      active: true,
    };
    for (const registration of replacing?.providers ?? []) {
      this.emitDetached('runtime.provider.disposed', {
        providerId: registration.provider.id,
      });
    }
    for (const registration of providers) {
      this.emitDetached('runtime.provider.registered', {
        providerId: registration.provider.id,
        providerVersion: registration.provider.version,
      });
    }
    return state;
  }

  private contributionHandle(
    state: RuntimeKernelContributionState,
  ): RuntimeKernelContributionRegistration {
    return Object.freeze({
      providerIds: Object.freeze(state.providers.map(({ provider }) => provider.id)),
      catalogProviderIds: Object.freeze(
        state.catalogProviders.map(({ provider }) => provider.id),
      ),
      replace: async (
        contributions: RuntimeKernelContributionSet,
        context: InvocationContext,
      ) => {
        const prepared = await this.prepareContributions(contributions, context, state);
        const replacement = this.commitContributions(prepared, state);
        return this.contributionHandle(replacement);
      },
      dispose: () => {
        if (!state.active) return;
        state.active = false;
        for (const registration of state.providers) {
          if (this.providers.get(registration.provider.id) !== registration) continue;
          this.providers.delete(registration.provider.id);
          this.emitDetached('runtime.provider.disposed', {
            providerId: registration.provider.id,
          });
        }
        for (const registration of state.catalogProviders) {
          if (this.catalogProviders.get(registration.provider.id) !== registration) continue;
          this.catalogProviders.delete(registration.provider.id);
        }
      },
    });
  }

  private assertContributionStateActive(
    state: RuntimeKernelContributionState | undefined,
  ): void {
    if (state && !state.active) {
      throw new Error('Runtime contribution registration is no longer active.');
    }
  }

  private async searchCatalog(
    exactId: string | undefined,
    query: string,
    requiredTags: readonly string[],
    minScore: number,
    limit: number,
    context: InvocationContext,
  ): Promise<readonly RuntimeCatalogSearchMatch[]> {
    const entries = exactId
      ? [await this.getCatalogEntry(exactId, context)].filter(
          (entry): entry is RuntimeCatalogEntry => entry !== undefined,
        )
      : await this.listCatalogEntries(context);
    return entries
      .filter((entry) => {
        const tags = new Set((entry.tags ?? []).map((tag) => tag.toLocaleLowerCase()));
        return requiredTags.every((tag) => tags.has(tag));
      })
      .map((entry) => rankCatalogEntry(entry, query))
      .filter(
        (match): match is RuntimeCatalogSearchMatch =>
          match !== undefined && match.score >= minScore,
      )
      .sort(
        (left, right) =>
          right.score - left.score || left.entry.id.localeCompare(right.entry.id),
      )
      .slice(0, limit);
  }

  private async listCatalogEntries(
    context: InvocationContext,
  ): Promise<readonly RuntimeCatalogEntry[]> {
    const entries: RuntimeCatalogEntry[] = [];
    const owners = new Map<string, string[]>();
    for (const { provider } of this.orderedCatalogProviders()) {
      for (const entry of await provider.list(context)) {
        validateCatalogEntry(entry, provider.id);
        entries.push(entry);
        const providerIds = owners.get(entry.id) ?? [];
        providerIds.push(provider.id);
        owners.set(entry.id, providerIds);
      }
    }
    for (const [id, providerIds] of owners) {
      if (providerIds.length > 1) {
        throw new DuplicateCapabilityError(`catalog:${id}`, providerIds);
      }
    }
    return entries.sort((left, right) => left.id.localeCompare(right.id));
  }

  private async getCatalogEntry(
    id: string,
    context: InvocationContext,
  ): Promise<RuntimeCatalogEntry | undefined> {
    const matches: Array<{ entry: RuntimeCatalogEntry; providerId: string }> = [];
    for (const { provider } of this.orderedCatalogProviders()) {
      const entry = provider.get
        ? await provider.get(id, context)
        : (await provider.list(context)).find((candidate) => candidate.id === id);
      if (!entry) continue;
      validateCatalogEntry(entry, provider.id);
      if (entry.id !== id) {
        throw new InvalidCapabilityDescriptorError(
          `Catalog provider "${provider.id}" returned "${entry.id}" when asked for "${id}".`,
        );
      }
      matches.push({ entry, providerId: provider.id });
    }
    if (matches.length > 1) {
      throw new DuplicateCapabilityError(
        `catalog:${id}`,
        matches.map((match) => match.providerId),
      );
    }
    return matches[0]?.entry;
  }

  private async finish<TOutput>(
    request: RuntimeExecRequest,
    context: InvocationContext,
    started: Date,
    status: RuntimeExecutionStatus,
    capability?: RuntimeCapabilityDescriptor,
    permission?: PermissionDecision,
    error?: RuntimeError,
    result?: CapabilityInvocationResult<TOutput>,
    approval?: Extract<PermissionDecision, { decision: 'approval' }>,
  ): Promise<RuntimeExecResponse<TOutput>> {
    const completed = this.now();
    const correlations = resolveRuntimeReceiptCorrelations(
      context.receiptCorrelationContext,
    );
    const receipt: RuntimeExecutionReceipt = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      receiptId: this.createId('receipt'),
      executionId: context.executionId ?? this.createId('execution'),
      requestId: request.requestId,
      target: request.target,
      provider: capability?.provider,
      capabilityVersion: capability?.version,
      principalId: context.principal.id,
      identity: context.identity,
      scope: context.scope,
      lineage: context.lineage ?? resolveExecutionLineage(context.executionId ?? request.target, context),
      ...(correlations ? { correlations } : {}),
      status,
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      durationMs: Math.max(0, completed.getTime() - started.getTime()),
      permission,
      provenance: result?.provenance,
      diagnostics: result?.diagnostics,
      artifacts: result?.artifacts,
      providerReceipt: result?.receipt,
    };
    const response: RuntimeExecResponse<TOutput> = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      status,
      result,
      error,
      approval,
      receipt,
    };
    try {
      await this.receiptSink?.record(receipt);
    } catch {
      // Receipt persistence is observational and cannot rewrite operation outcomes.
    }
    await this.emit(
      'runtime.execution.completed',
      {
        executionId: receipt.executionId,
        target: request.target,
        status,
        receiptId: receipt.receiptId,
      },
      context,
    );
    return response;
  }

  private emitDetached<TType extends RuntimeLifecycleEventType>(
    type: TType,
    payload: RuntimeLifecyclePayloads[TType],
  ): void {
    let operation!: Promise<void>;
    operation = this.emit(type, payload)
      .catch((error: unknown) => {
        this.lifecycleEmissionFailures.push(error);
      })
      .finally(() => {
        this.pendingLifecycleEmissions.delete(operation);
      });
    this.pendingLifecycleEmissions.add(operation);
  }

  private async emit<TType extends RuntimeLifecycleEventType>(
    type: TType,
    payload: RuntimeLifecyclePayloads[TType],
    context?: InvocationContext,
  ): Promise<void> {
    const event = createLifecycleEvent(type, payload, {
      id: this.createId('event'),
      occurredAt: this.now().toISOString(),
      context,
    }) as AnyRuntimeLifecycleEvent;
    try {
      await this.events.publish(event);
    } catch {
      // Lifecycle observation must not alter execution behavior.
    }
    if (this.lifecycle && this.lifecycle !== this.events) {
      try {
        await this.lifecycle.publish(event);
      } catch {
        // External lifecycle publishers are observational too.
      }
    }
  }
}

function assertContributionRegistrationNotCancelled(context: InvocationContext): void {
  if (context.signal?.aborted) {
    throw new Error('Runtime contribution registration was cancelled.');
  }
}

function summarizeCapability(
  capability: RuntimeCapabilityDescriptor,
): RuntimeCapabilitySummary {
  return {
    protocolVersion: capability.protocolVersion,
    name: capability.name,
    version: capability.version,
    ...(capability.title === undefined ? {} : { title: capability.title }),
    description: capability.description,
    ...(capability.tags === undefined ? {} : { tags: capability.tags }),
    ...(capability.permissions === undefined ? {} : { permissions: capability.permissions }),
    provider: capability.provider,
  };
}

export function createRuntimeKernel(options: RuntimeKernelOptions = {}): RuntimeKernel {
  return new RuntimeKernel(options);
}
