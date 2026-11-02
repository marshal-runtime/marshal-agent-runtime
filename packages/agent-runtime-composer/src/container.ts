import {
  RUNTIME_SERVICE_CONTAINER,
  type RuntimeServiceAccessor,
  type RuntimeServiceBinding,
  type RuntimeServiceBindingHandle,
  type RuntimeServiceContainer,
  type RuntimeServiceDecorator,
  type RuntimeServiceFactoryBinding,
  type RuntimeServiceLifecycle,
  type RuntimeServiceLifetime,
  type RuntimeServiceScope,
  type RuntimeServiceToken,
} from './services.js';

type AnyRecord = RecordState<unknown>;
type AnyInstance = InstanceState<unknown>;

interface ScopeState {
  root: RootState;
  parent?: ScopeState;
  readonly cache: Map<AnyRecord, AnyInstance>;
  readonly decoratedCache: Map<TokenState<unknown>, { revision: number; value: unknown }>;
  readonly started: AnyInstance[];
  readonly children: ScopeState[];
  closed: boolean;
  shuttingDown: boolean;
  shutdownPromise?: Promise<void>;
  lifecycleQueue: Promise<void>;
}

interface RootState extends ScopeState {
  readonly records: Map<symbol, TokenState<unknown>>;
  readonly scopes: ScopeState[];
  running: boolean;
  insertion: number;
  lifecycleSequence: number;
  startInitiated: boolean;
  startPromise?: Promise<void>;
  shutdownPromise?: Promise<void>;
  readonly pendingStarts: Set<Promise<void>>;
  lifecycleHook?: 'start' | 'shutdown';
  tearingDown?: boolean;
}

interface TokenState<T> {
  primary?: RecordState<T>;
  contributions: RecordState<T>[];
  decorators: DecoratorState<T>[];
  revision: number;
}

interface RecordState<T> {
  readonly token: RuntimeServiceToken<T>;
  readonly binding: RuntimeServiceBinding<T>;
  readonly lifetime: RuntimeServiceLifetime;
  readonly factory: (accessor: RuntimeServiceAccessor) => T;
  readonly lifecycle: RuntimeServiceLifecycle<T>;
  readonly insertion: number;
  readonly previous?: RecordState<T>;
  disposed: boolean;
}

interface InstanceState<T> {
  readonly record: RecordState<T>;
  readonly owner: ScopeState;
  readonly value: T;
  readonly dependencies: readonly AnyInstance[];
  started: boolean;
  startAttempted: boolean;
  stopped: boolean;
  sequence?: number;
  startPromise?: Promise<void>;
  stopPromise?: Promise<void>;
}

interface DecoratorState<T> {
  readonly decorator: RuntimeServiceDecorator<T>;
  disposed: boolean;
}

interface ResolutionFrame {
  readonly token: symbol;
  readonly lifetime: RuntimeServiceLifetime;
  readonly dependencies: Set<AnyInstance>;
}

interface ResolutionContext {
  readonly frames: ResolutionFrame[];
}

let singletonContainer: RuntimeServiceContainer | undefined;

function isFactoryBinding<T>(
  binding: RuntimeServiceBinding<T>,
): binding is RuntimeServiceFactoryBinding<T> {
  return typeof binding.useFactory === 'function';
}

function assertBinding<T>(
  binding: RuntimeServiceBinding<T>,
  allowOrder: boolean,
): void {
  const isValue = Object.prototype.hasOwnProperty.call(binding, 'useValue');
  const isFactory = isFactoryBinding(binding);
  if (isValue === isFactory) {
    throw new TypeError(
      'A service binding must provide exactly one of useValue or useFactory.',
    );
  }
  if (
    isFactory &&
    binding.lifetime !== 'singleton' &&
    binding.lifetime !== 'scoped' &&
    binding.lifetime !== 'transient'
  ) {
    throw new TypeError('A service factory binding has an invalid lifetime.');
  }
  if (
    isFactory &&
    binding.lifetime === 'transient' &&
    (binding.start || binding.shutdown)
  ) {
    throw new TypeError(
      'Transient service bindings cannot declare lifecycle hooks.',
    );
  }
  if (binding.order !== undefined && !Number.isFinite(binding.order)) {
    throw new TypeError('Service binding order must be finite.');
  }
  if (!allowOrder && binding.order !== undefined) {
    throw new TypeError('Service binding order is only valid for bindMany.');
  }
}

function tokenName(token: symbol): string {
  return Symbol.keyFor(token) ?? token.toString();
}

function assertToken<T>(token: RuntimeServiceToken<T>): void {
  if (typeof token !== 'symbol') {
    throw new TypeError('Runtime service token must be a symbol.');
  }
}

function cycleError(context: ResolutionContext, token: symbol): never {
  const index = context.frames.findIndex((entry) => entry.token === token);
  const path = [
    ...context.frames
      .slice(index < 0 ? 0 : index)
      .map((entry) => tokenName(entry.token)),
    tokenName(token),
  ];
  throw new Error(`Runtime service dependency cycle: ${path.join(' -> ')}`);
}

function assertScopeOpen(scope: ScopeState, allowClosed: boolean): void {
  if (
    !allowClosed &&
    (scope.closed ||
      scope.root.closed ||
      scope.shuttingDown ||
      scope.root.shuttingDown)
  ) {
    throw new Error(
      scope === scope.root
        ? 'Runtime service container is shut down.'
        : 'Runtime service scope is shut down.',
    );
  }
}

function tokenState<T>(
  root: RootState,
  token: RuntimeServiceToken<T>,
): TokenState<T> | undefined {
  return root.records.get(token) as TokenState<T> | undefined;
}

function activePrimary<T>(
  state: TokenState<T> | undefined,
): RecordState<T> | undefined {
  let record = state?.primary;
  while (record?.disposed) record = record.previous;
  return record;
}

function activeContributions<T>(
  state: TokenState<T>,
): readonly RecordState<T>[] {
  return state.contributions
    .filter((record) => !record.disposed)
    .sort((left, right) => {
      const leftOrder = left.binding.order ?? Number.POSITIVE_INFINITY;
      const rightOrder = right.binding.order ?? Number.POSITIVE_INFINITY;
      return leftOrder - rightOrder || left.insertion - right.insertion;
    });
}

function activeRecords(root: RootState): readonly AnyRecord[] {
  const records: AnyRecord[] = [];
  for (const state of root.records.values()) {
    const primary = activePrimary(state);
    if (primary) records.push(primary);
    records.push(...activeContributions(state));
  }

  return records.sort((left, right) => left.insertion - right.insertion);
}

function invalidateDecoratedCaches(root: RootState): void {
  const clear = (scope: ScopeState): void => {
    scope.decoratedCache.clear();
    for (const child of scope.children) clear(child);
  };
  clear(root);
}

function hasLifecycle(record: AnyRecord): boolean {
  return Boolean(record.lifecycle.start || record.lifecycle.shutdown);
}

function makeAccessor(
  scope: ScopeState,
  root: RootState,
  allowClosed = false,
  context: ResolutionContext = { frames: [] },
  lifetime?: RuntimeServiceLifetime,
  token?: symbol,
): RuntimeServiceAccessor {
  const accessorContext = (): ResolutionContext => {
    if (
      lifetime !== 'singleton' ||
      context.frames.some((frame) => frame.lifetime === 'singleton')
    ) return context;
    return {
      frames: [{
        token: token ?? Symbol.for('@marshal/runtime/services:retained-accessor'),
        lifetime: 'singleton',
        dependencies: new Set(),
      }],
    };
  };
  return {
    get: <T>(token: RuntimeServiceToken<T>) =>
      resolvePrimary(scope, root, token, allowClosed, accessorContext()),
    tryGet: <T>(token: RuntimeServiceToken<T>) => {
      assertScopeOpen(scope, allowClosed);
      assertToken(token);
      return activePrimary(tokenState(root, token))
        ? resolvePrimary(scope, root, token, allowClosed, accessorContext())
        : undefined;
    },
    getAll: <T>(token: RuntimeServiceToken<T>) =>
      resolveAll(scope, root, token, allowClosed, accessorContext()),
  };
}

function resolvePrimary<T>(
  scope: ScopeState,
  root: RootState,
  token: RuntimeServiceToken<T>,
  allowClosed = false,
  context: ResolutionContext = { frames: [] },
): T {
  assertScopeOpen(scope, allowClosed);
  assertToken(token);
  if (context.frames.some((entry) => entry.token === token)) {
    cycleError(context, token);
  }
  const state = tokenState(root, token);
  const record = activePrimary(state);
  if (!record) {
    throw new Error(
      `No runtime service is registered for ${tokenName(token)}.`,
    );
  }
  return applyDecorators(
    scope,
    root,
    token,
    state!,
    record,
    resolveRecord(scope, root, record, allowClosed, context).value,
    allowClosed,
    context,
  );
}

function resolveAll<T>(
  scope: ScopeState,
  root: RootState,
  token: RuntimeServiceToken<T>,
  allowClosed = false,
  context: ResolutionContext = { frames: [] },
): readonly T[] {
  assertScopeOpen(scope, allowClosed);
  assertToken(token);
  if (context.frames.some((entry) => entry.token === token)) {
    cycleError(context, token);
  }
  const state = tokenState(root, token);
  if (!state) return [];
  const values: T[] = [];
  const primary = activePrimary(state);
  if (primary) {
    values.push(
      applyDecorators(
        scope,
        root,
        token,
        state,
        primary,
        resolveRecord(scope, root, primary, allowClosed, context).value,
        allowClosed,
        context,
      ),
    );
  }
  for (const record of activeContributions(state)) {
    values.push(resolveRecord(scope, root, record, allowClosed, context).value);
  }
  return Object.freeze(values);
}

function applyDecorators<T>(
  scope: ScopeState,
  root: RootState,
  token: RuntimeServiceToken<T>,
  state: TokenState<T>,
  record: RecordState<T>,
  value: T,
  allowClosed: boolean,
  context: ResolutionContext,
): T {
  let current = value;
  if (record.lifetime !== 'transient') {
    const owner = record.lifetime === 'singleton' ? root : scope;
    const cached = owner.decoratedCache.get(state as TokenState<unknown>);
    if (cached?.revision === state.revision) return cached.value as T;
  }
  const frame: ResolutionFrame = {
    token,
    lifetime: record.lifetime,
    dependencies: new Set(),
  };
  context.frames.push(frame);
  try {
    const accessor = makeAccessor(
      scope, root, allowClosed, context, record.lifetime, record.token,
    );
    for (const entry of state.decorators) {
      if (!entry.disposed) current = entry.decorator(current, accessor);
    }
    if (record.lifetime !== 'transient') {
      const owner = record.lifetime === 'singleton' ? root : scope;
      owner.decoratedCache.set(state as TokenState<unknown>, {
        revision: state.revision,
        value: current,
      });
    }
    return current;
  } finally {
    context.frames.pop();
  }
}

function addDependency(context: ResolutionContext, instance: AnyInstance): void {
  context.frames.at(-1)?.dependencies.add(instance);
}

function resolveRecord<T>(
  scope: ScopeState,
  root: RootState,
  record: RecordState<T>,
  allowClosed: boolean,
  context: ResolutionContext,
): { readonly value: T; readonly instance?: InstanceState<T> } {
  if (record.disposed) {
    throw new Error(
      `Runtime service binding for ${tokenName(record.token)} is disposed.`,
    );
  }
  if (context.frames.some((entry) => entry.token === record.token)) {
    cycleError(context, record.token);
  }
  if (
    record.lifetime === 'scoped' &&
    context.frames.some((entry) => entry.lifetime === 'singleton')
  ) {
    const owner = [...context.frames]
      .reverse()
      .find((entry) => entry.lifetime === 'singleton')!;
    throw new Error(
      `Singleton service ${tokenName(owner.token)} cannot capture scoped service ${tokenName(record.token)}.`,
    );
  }

  if (record.lifetime === 'transient') {
    const frame: ResolutionFrame = {
      token: record.token,
      lifetime: record.lifetime,
      dependencies: new Set(),
    };
    context.frames.push(frame);
    try {
      const value = record.factory(
        makeAccessor(scope, root, allowClosed, context, record.lifetime, record.token),
      );
      const parent = context.frames.at(-2);
      for (const dependency of frame.dependencies) {
        parent?.dependencies.add(dependency);
      }
      return { value };
    } finally {
      context.frames.pop();
    }
  }

  const owner = record.lifetime === 'singleton' ? root : scope;
  const cached = owner.cache.get(record as AnyRecord) as
    | InstanceState<T>
    | undefined;
  if (cached) {
    addDependency(context, cached as AnyInstance);
    return { value: cached.value, instance: cached };
  }
  if (allowClosed && (scope.shuttingDown || root.tearingDown)) {
    throw new Error(
      `Cannot realize runtime service ${tokenName(record.token)} during shutdown.`,
    );
  }

  const frame: ResolutionFrame = {
    token: record.token,
    lifetime: record.lifetime,
    dependencies: new Set(),
  };
  context.frames.push(frame);
  try {
    const value = record.factory(
      makeAccessor(scope, root, allowClosed, context, record.lifetime, record.token),
    );
    const instance: InstanceState<T> = {
      record,
      owner,
      value,
      dependencies: [...frame.dependencies],
      started: false,
      startAttempted: false,
      stopped: false,
    };
    owner.cache.set(record as AnyRecord, instance as AnyInstance);
    if (hasLifecycle(record as AnyRecord)) {
      owner.started.push(instance as AnyInstance);
    }
    if (record.lifecycle.shutdown && !record.lifecycle.start) {
      instance.started = true;
      instance.startAttempted = true;
      instance.sequence = ++root.lifecycleSequence;
    }
    const parent = context.frames.at(-2);
    parent?.dependencies.add(instance as AnyInstance);
    return { value, instance };
  } finally {
    context.frames.pop();
  }
}

async function ensureStarted(instance: AnyInstance): Promise<void> {
  if (!hasLifecycle(instance.record) || instance.started) return;
  if (instance.startPromise) return instance.startPromise;
  const deferred = createDeferred<void>();
  instance.startPromise = deferred.promise;
  void (async () => {
    for (const dependency of instance.dependencies) {
      await ensureStarted(dependency);
    }
    const root = instance.owner.root;
    instance.startAttempted = true;
    instance.sequence = ++root.lifecycleSequence;
    if (!instance.owner.started.includes(instance)) {
      instance.owner.started.push(instance);
    }
    const frame: ResolutionFrame = {
      token: instance.record.token,
      lifetime: instance.record.lifetime,
      dependencies: new Set(),
    };
    const context: ResolutionContext = { frames: [frame] };
    try {
      root.lifecycleHook = 'start';
      const result = instance.record.lifecycle.start?.(
        instance.value,
        makeAccessor(
          instance.owner, root, true, context,
          instance.record.lifetime, instance.record.token,
        ),
      );
      await result;
      instance.started = true;
    } catch (error) {
      deferred.reject(error);
      return;
    } finally {
      root.lifecycleHook = undefined;
    }
    deferred.resolve();
  })();
  return deferred.promise;
}

async function stopInstance(instance: AnyInstance): Promise<void> {
  if (instance.stopped) return;
  if (instance.stopPromise) return instance.stopPromise;
  instance.stopPromise = (async () => {
    if (instance.startPromise) {
      try {
        await instance.startPromise;
      } catch { /* A failed start still requires its shutdown hook. */ }
    }
    instance.stopped = true;
    const root = instance.owner.root;
    const context: ResolutionContext = {
      frames: [{
        token: instance.record.token,
        lifetime: instance.record.lifetime,
        dependencies: new Set(),
      }],
    };
    try {
      root.lifecycleHook = 'shutdown';
      const result = instance.record.lifecycle.shutdown?.(
        instance.value,
        makeAccessor(
          instance.owner, root, true, context,
          instance.record.lifetime, instance.record.token,
        ),
      );
      root.lifecycleHook = undefined;
      await result;
    } finally {
      root.lifecycleHook = undefined;
      const index = instance.owner.started.indexOf(instance);
      if (index >= 0) instance.owner.started.splice(index, 1);
    }
  })();
  return instance.stopPromise;
}

function scopesInCreationOrder(root: RootState): readonly ScopeState[] {
  const scopes: ScopeState[] = [root];
  const visit = (scope: ScopeState): void => {
    for (const child of scope.children) {
      if (!child.closed) {
        scopes.push(child);
        visit(child);
      }
    }
  };
  visit(root);
  return scopes;
}

async function startRecordInScope(
  scope: ScopeState,
  root: RootState,
  record: AnyRecord,
): Promise<void> {
  if (scope === root) {
    const resolved = resolveRecord(
      scope, root, record, root.shuttingDown, { frames: [] },
    );
    if (resolved.instance) await ensureStarted(resolved.instance as AnyInstance);
    return;
  }
  const operation = scope.lifecycleQueue.then(async () => {
    assertScopeOpen(scope, false);
    const resolved = resolveRecord(scope, root, record, false, { frames: [] });
    if (resolved.instance) await ensureStarted(resolved.instance as AnyInstance);
  });
  scope.lifecycleQueue = operation.catch(() => undefined);
  await operation;
}

async function startRecordEverywhere(
  root: RootState,
  record: AnyRecord,
): Promise<void> {
  if (!hasLifecycle(record) || record.lifetime === 'transient') return;
  const scopes =
    record.lifetime === 'singleton'
      ? [root]
      : scopesInCreationOrder(root);
  for (const scope of scopes) {
    await startRecordInScope(scope, root, record);
  }
}

async function stopRecordEverywhere(
  root: RootState,
  record: AnyRecord,
): Promise<void> {
  const errors: unknown[] = [];
  for (const scope of [...scopesInCreationOrder(root)].reverse()) {
    const instance = scope.cache.get(record);
    if (!instance) continue;
    try {
      await stopInstance(instance);
    } catch (error) {
      errors.push(error);
    }
    scope.cache.delete(record);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Failed to stop a runtime service binding.');
  }
}

function makeRecord<T>(
  token: RuntimeServiceToken<T>,
  binding: RuntimeServiceBinding<T>,
  insertion: number,
  previous?: RecordState<T>,
): RecordState<T> {
  if (isFactoryBinding(binding)) {
    return {
      token,
      binding,
      lifetime: binding.lifetime,
      factory: binding.useFactory,
      lifecycle: { start: binding.start, shutdown: binding.shutdown },
      insertion,
      ...(previous ? { previous } : {}),
      disposed: false,
    };
  }
  return {
    token,
    binding,
    lifetime: 'singleton',
    factory: () => binding.useValue,
    lifecycle: {},
    insertion,
    ...(previous ? { previous } : {}),
    disposed: false,
  };
}

function makeHandle(
  action: () => Promise<void>,
): RuntimeServiceBindingHandle {
  let operation: Promise<void> | undefined;
  return {
    dispose: () => operation ?? (operation = action()),
  };
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function enqueueScopeOperation(
  scope: ScopeState,
  operation: () => Promise<void>,
): Promise<void> {
  const next = scope.lifecycleQueue.then(operation);
  scope.lifecycleQueue = next.catch(() => undefined);
  return next;
}

function shutdownScope(scope: ScopeState): Promise<void> {
  if (scope.shutdownPromise) return scope.shutdownPromise;
  scope.shuttingDown = true;
  const deferred = createDeferred<void>();
  scope.shutdownPromise = deferred.promise;
  const operation = enqueueScopeOperation(scope, async () => {
    const errors: unknown[] = [];
    for (const child of [...scope.children].reverse()) {
      try {
        await shutdownScope(child);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const instance of [...scope.started].reverse()) {
      try {
        await stopInstance(instance);
      } catch (error) {
        errors.push(error);
      }
    }
    scope.closed = true;
    if (scope.parent) {
      const index = scope.parent.children.indexOf(scope);
      if (index >= 0) scope.parent.children.splice(index, 1);
    }
    const rootIndex = scope.root.scopes.indexOf(scope);
    if (rootIndex >= 0) scope.root.scopes.splice(rootIndex, 1);
    scope.cache.clear();
    scope.decoratedCache.clear();
    scope.started.length = 0;
    if (errors.length === 1) {
      deferred.reject(errors[0]);
    } else if (errors.length > 1) {
      deferred.reject(
        new AggregateError(errors, 'Failed to shut down a runtime service scope.'),
      );
    } else {
      deferred.resolve();
    }
  });
  void operation.then(deferred.resolve, deferred.reject);
  return deferred.promise;
}

function createContainer(): RuntimeServiceContainer {
  const root = {
    root: undefined as unknown as RootState,
    cache: new Map(),
    decoratedCache: new Map(),
    started: [],
    children: [],
    closed: false,
    records: new Map(),
    scopes: [],
    running: false,
    insertion: 0,
    lifecycleSequence: 0,
    startInitiated: false,
    shuttingDown: false,
    pendingStarts: new Set(),
    lifecycleQueue: Promise.resolve(),
    tearingDown: false,
  } as RootState;
  root.root = root;

  const register = async <T>(
    token: RuntimeServiceToken<T>,
    binding: RuntimeServiceBinding<T>,
    mode: 'primary' | 'many' | 'replacement',
  ): Promise<RuntimeServiceBindingHandle> => {
    assertScopeOpen(root, false);
    assertToken(token);
    assertBinding(binding, mode === 'many');
    const state =
      tokenState(root, token) ?? {
        primary: undefined,
        contributions: [],
        decorators: [],
        revision: 0,
      };
    root.records.set(token, state as TokenState<unknown>);
    const primary = activePrimary(state);
    if (mode === 'primary' && primary) {
      throw new Error(
        `Primary runtime service ${tokenName(token)} is already registered.`,
      );
    }
    if (mode === 'replacement' && !primary) {
      throw new Error(
        `Cannot replace unregistered runtime service ${tokenName(token)}.`,
      );
    }

    const record = makeRecord(
      token,
      binding,
      root.insertion++,
      mode === 'replacement' ? state.primary : undefined,
    );
    if (mode === 'many') state.contributions.push(record);
    else state.primary = record;
    state.revision++;
    invalidateDecoratedCaches(root);

    const handle = makeHandle(async () => {
      if (record.disposed) return;
      record.disposed = true;
      if (mode === 'many') {
        state.contributions = state.contributions.filter(
          (candidate) => candidate !== record,
        );
      } else if (state.primary === record) {
        state.primary = record.previous;
      }
      state.revision++;
      invalidateDecoratedCaches(root);
      const errors: unknown[] = [];
      try {
        await stopRecordEverywhere(root, record as AnyRecord);
      } catch (error) {
        errors.push(error);
      }
      if (mode === 'replacement' && root.running) {
        const restored = activePrimary(state);
        if (restored) {
          try {
            await startRecordEverywhere(root, restored as AnyRecord);
          } catch (error) {
            errors.push(error);
          }
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, `Failed to dispose runtime service ${tokenName(token)}.`);
      }
    });

    if (root.running) {
      const start = startRecordEverywhere(root, record as AnyRecord);
      root.pendingStarts.add(start);
      try {
        await start;
      } catch (error) {
        try {
          await handle.dispose();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `Failed to start runtime service ${tokenName(token)} and roll back its registration.`,
          );
        }
        throw error;
      } finally {
        root.pendingStarts.delete(start);
      }
    }
    return handle;
  };

  const container: RuntimeServiceContainer = {
    get: (token) => resolvePrimary(root, root, token),
    tryGet: (token) => makeAccessor(root, root).tryGet(token),
    getAll: (token) => resolveAll(root, root, token),
    bind: (token, binding) => register(token, binding, 'primary'),
    bindMany: (token, binding) => register(token, binding, 'many'),
    replace: (token, binding) => register(token, binding, 'replacement'),
    decorate: async <T>(
      token: RuntimeServiceToken<T>,
      decorator: RuntimeServiceDecorator<T>,
    ) => {
      assertScopeOpen(root, false);
      assertToken(token);
      if (typeof decorator !== 'function') {
        throw new TypeError('Runtime service decorator must be a function.');
      }
      const state = tokenState(root, token);
      if (!activePrimary(state)) {
        throw new Error(
          `Cannot decorate unregistered runtime service ${tokenName(token)}.`,
        );
      }
      const entry: DecoratorState<T> = { decorator, disposed: false };
      state!.decorators.push(entry);
      state!.revision++;
      invalidateDecoratedCaches(root);
      return makeHandle(async () => {
        if (entry.disposed) return;
        entry.disposed = true;
        state!.decorators = state!.decorators.filter(
          (candidate) => candidate !== entry,
        );
        state!.revision++;
        invalidateDecoratedCaches(root);
      });
    },
    createScope: async () => {
      assertScopeOpen(root, false);
      const scope: ScopeState = {
        root,
        parent: root,
        cache: new Map(),
        decoratedCache: new Map(),
        started: [],
        children: [],
        closed: false,
        shuttingDown: false,
        lifecycleQueue: Promise.resolve(),
      };
      root.children.push(scope);
      root.scopes.push(scope);
      if (root.running) {
        try {
          for (const record of activeRecords(root)) {
            if (
              record.lifetime === 'scoped' &&
              hasLifecycle(record)
            ) {
              await startRecordInScope(scope, root, record);
            }
          }
        } catch (error) {
          try {
            await shutdownScope(scope);
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              'Failed to initialize and roll back a runtime service scope.',
            );
          }
          throw error;
        }
      }
      const publicScope: RuntimeServiceScope = {
        get: (token) => resolvePrimary(scope, root, token),
        tryGet: (token) => makeAccessor(scope, root).tryGet(token),
        getAll: (token) => resolveAll(scope, root, token),
        shutdown: () => shutdownScope(scope),
      };
      return publicScope;
    },
    start: () => {
      assertScopeOpen(root, false);
      if (root.lifecycleHook === 'start') {
        throw new Error('Runtime service container cannot start from a start hook.');
      }
      if (root.startPromise) return root.startPromise;
      root.startInitiated = true;
      const deferred = createDeferred<void>();
      root.startPromise = deferred.promise;
      void (async () => {
        root.running = true;
        try {
          for (const record of activeRecords(root)) {
            if (hasLifecycle(record)) {
              await startRecordEverywhere(root, record);
            }
          }
          deferred.resolve();
        } catch (error) {
          root.running = false;
          deferred.reject(error);
        }
      })();
      return deferred.promise;
    },
    shutdown: () => {
      if (root.lifecycleHook === 'shutdown') {
        throw new Error(
          `Runtime service container cannot shut down from a ${root.lifecycleHook} hook.`,
        );
      }
      if (root.shutdownPromise) return root.shutdownPromise;
      root.shuttingDown = true;
      root.running = false;
      const deferred = createDeferred<void>();
      root.shutdownPromise = deferred.promise;
      void (async () => {
        const errors: unknown[] = [];
        if (root.startPromise) {
          try {
            await root.startPromise;
          } catch (error) {
            errors.push(error);
          }
        }
        while (root.pendingStarts.size > 0) {
          const pending = [...root.pendingStarts];
          await Promise.allSettled(pending);
        }
        root.tearingDown = true;
        root.closed = true;
        for (const child of [...root.scopes].reverse()) {
          try {
            await shutdownScope(child);
          } catch (error) {
            errors.push(error);
          }
        }
        for (const instance of [...root.started].reverse()) {
          try {
            await stopInstance(instance);
          } catch (error) {
            errors.push(error);
          }
        }
        root.cache.clear();
        root.decoratedCache.clear();
        root.started.length = 0;
        root.scopes.length = 0;
        if (errors.length === 1) deferred.reject(errors[0]);
        else if (errors.length > 1) {
          deferred.reject(new AggregateError(errors, 'Failed to shut down runtime services.'));
        } else deferred.resolve();
      })().catch((error) => deferred.reject(error));
      return deferred.promise;
    },
  };

  const self = makeRecord(
    RUNTIME_SERVICE_CONTAINER,
    { useValue: container },
    root.insertion++,
  );
  root.records.set(RUNTIME_SERVICE_CONTAINER, {
    primary: self,
    contributions: [],
    revision: 0,
    decorators: [],
  } as TokenState<unknown>);
  return container;
}

export function createRuntimeServiceContainer(): RuntimeServiceContainer {
  return createContainer();
}

export function getRuntimeServiceContainer(): RuntimeServiceContainer {
  return singletonContainer ?? (singletonContainer = createContainer());
}
