import * as path from 'node:path';
import {
  type RuntimeExtensionConfiguration,
  type RuntimeExtensionContractRepairRequest,
  type RuntimeExtensionInstallOptions,
  type RuntimeExtensionInstallRequest,
  type RuntimeExtensionLifecycleService,
  type RuntimeExtensionOperationOptions,
  type RuntimeExtensionPackageDiscovery,
  type RuntimeExtensionStatusDiagnostic,
  type RuntimeExtensionStatusEntry,
  type RuntimeExtensionStatusInstallRequest,
  type RuntimeExtensionStatusListener,
  type RuntimeExtensionStatusService,
  type RuntimeExtensionStatusSnapshot,
} from '@marshal/agent-runtime-extensions';
import type {
  RuntimeNativeExtensionCandidate,
  RuntimeHostMaterializer,
} from './nativeExtensions.js';
import {
  inspectRuntimeNativeExtensionInstallation,
  RuntimeNativeExtensionInstallationError,
  type RuntimeNativeExtensionInstallationOptions,
  type RuntimeNativeExtensionInstallationPlan,
} from './nativeExtensionInstallation.js';
import type {
  RuntimeNativeExtensionDiscoveryService,
  RuntimeNativeExtensionDiscoverySnapshot,
} from './nativeExtensionDiscovery.js';

const MAX_STATUS_SUBSCRIBERS = 256;

export interface RuntimeNativeExtensionStatusOptions {
  readonly discovery: RuntimeNativeExtensionDiscoveryService;
  readonly lifecycle: RuntimeExtensionLifecycleService;
  readonly materializer: RuntimeHostMaterializer;
  readonly installation?: Omit<
    RuntimeNativeExtensionInstallationOptions,
    'onEvent' | 'signal'
  >;
}

export interface RuntimeNativeExtensionStatusController
  extends RuntimeExtensionStatusService {
  readonly lifecycle: RuntimeExtensionLifecycleService;
  dispose(): Promise<void>;
}

interface ActiveInstallation {
  readonly packageRoot: string;
  phase: 'validating' | 'running-script' | 'activating';
}

interface InstallationFailure {
  readonly diagnostic: RuntimeExtensionStatusDiagnostic;
}

interface InstallationInspection {
  readonly plan?: RuntimeNativeExtensionInstallationPlan;
  readonly diagnostic?: RuntimeExtensionStatusDiagnostic;
}

type ActionableCandidate =
  | Extract<RuntimeNativeExtensionCandidate, { readonly status: 'installable' }>
  | Extract<RuntimeNativeExtensionCandidate, { readonly status: 'unbuilt' }>;

export async function createRuntimeNativeExtensionStatusService(
  options: RuntimeNativeExtensionStatusOptions,
): Promise<RuntimeNativeExtensionStatusController> {
  if (!options || typeof options !== 'object') {
    throw new TypeError('Runtime native extension status options are invalid.');
  }

  let disposed = false;
  let revision = 1;
  let discoverySnapshot = options.discovery.snapshot();
  let inspections = await inspectInstallations(
    discoverySnapshot.candidates,
    options.installation,
  );
  const listeners = new Set<RuntimeExtensionStatusListener>();
  const installations = new Map<string, ActiveInstallation>();
  const failures = new Map<string, InstallationFailure>();
  let current = buildSnapshot(
    revision,
    discoverySnapshot,
    options.lifecycle.list(),
    inspections,
    installations,
    failures,
  );
  let reconciliation = Promise.resolve(current);

  const publish = async (
    snapshot: RuntimeExtensionStatusSnapshot,
  ): Promise<RuntimeExtensionStatusSnapshot> => {
    current = snapshot;
    await Promise.all([...listeners].map(async (listener) => {
      if (!listeners.has(listener)) return;
      try {
        await listener(snapshot);
      } catch {
        // Status observers are isolated from extension lifecycle outcomes.
      }
    }));
    return snapshot;
  };

  const reconcile = (): Promise<RuntimeExtensionStatusSnapshot> => {
    const operation = reconciliation.then(async () => {
      if (disposed) return current;
      discoverySnapshot = options.discovery.snapshot();
      inspections = await inspectInstallations(
        discoverySnapshot.candidates,
        options.installation,
      );
      return publish(buildSnapshot(
        nextRevision(),
        discoverySnapshot,
        options.lifecycle.list(),
        inspections,
        installations,
        failures,
      ));
    });
    reconciliation = operation.catch(() => current);
    return operation;
  };

  const afterLifecycle = async <T>(operation: () => Promise<T>): Promise<T> => {
    const result = await operation();
    await reconcile();
    return result;
  };

  const lifecycle = lifecycleProxy(options.lifecycle, afterLifecycle);
  const discoverySubscription = options.discovery.subscribe((snapshot) => {
    discoverySnapshot = snapshot;
    void reconcile().catch(() => undefined);
  });

  function nextRevision(): number {
    if (revision >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Runtime extension status revision limit reached.');
    }
    revision += 1;
    return revision;
  }

  const service: RuntimeNativeExtensionStatusController = {
    lifecycle,
    snapshot: () => current,
    subscribe(listener) {
      assertUsable();
      if (typeof listener !== 'function') {
        throw new TypeError('Runtime extension status listener must be a function.');
      }
      if (listeners.size >= MAX_STATUS_SUBSCRIBERS) {
        throw new Error('Runtime extension status subscriber limit reached.');
      }
      listeners.add(listener);
      let active = true;
      return Object.freeze({
        dispose() {
          if (!active) return;
          active = false;
          listeners.delete(listener);
        },
      });
    },
    async refresh(operationOptions = {}) {
      assertUsable();
      assertNotAborted(operationOptions.signal);
      discoverySnapshot = await options.discovery.refresh();
      assertNotAborted(operationOptions.signal);
      return reconciliation;
    },
    async install(request, operationOptions = {}) {
      assertUsable();
      validateInstallRequest(request);
      assertNotAborted(operationOptions.signal);
      discoverySnapshot = await options.discovery.refresh();
      const candidate = findActionableCandidate(
        discoverySnapshot.candidates,
        request.packageRoot,
      );
      if (!candidate) {
        throw new Error('Runtime extension package root is not an installable discovery candidate.');
      }
      if (candidate.status === 'unbuilt' && !candidate.installation) {
        throw new RuntimeNativeExtensionInstallationError(
          'INSTALLATION_NOT_DECLARED',
          'Runtime extension entrypoint is unbuilt and no installation script is declared.',
        );
      }

      const key = pathKey(candidate.packageRoot);
      if (installations.has(key)) {
        throw new Error('Runtime extension package installation is already in progress.');
      }
      failures.delete(key);
      installations.set(key, {
        packageRoot: candidate.packageRoot,
        phase: 'validating',
      });
      await reconcile();

      try {
        const materialized = await options.materializer.materialize({
          packageRoot: candidate.packageRoot,
          signal: nativeAbortSignal(operationOptions.signal),
          onInstallationEvent: (event) => {
            const active = installations.get(key);
            if (!active || event.phase === 'completed') return;
            active.phase = event.phase;
            void reconcile().catch(() => undefined);
          },
        });
        const active = installations.get(key);
        if (active) active.phase = 'activating';
        discoverySnapshot = await options.discovery.refresh();
        await reconcile();

        const installOptions = {
          ...(request.configuration === undefined
            ? {}
            : { configuration: request.configuration }),
          enabled: request.enabled ?? true,
          ...(operationOptions.signal ? { signal: operationOptions.signal } : {}),
        };
        const identity = candidate.identity;
        const record = options.lifecycle.get(identity)
          ? await options.lifecycle.update(identity, materialized, installOptions)
          : await options.lifecycle.install(materialized, installOptions);
        installations.delete(key);
        failures.delete(key);
        discoverySnapshot = await options.discovery.refresh();
        await reconcile();
        return record;
      } catch (error) {
        installations.delete(key);
        failures.set(key, {
          diagnostic: installationDiagnostic(error, candidate.packageRoot),
        });
        discoverySnapshot = await options.discovery.refresh().catch(() => discoverySnapshot);
        await reconcile();
        throw error;
      }
    },
    enable(identity, operationOptions = {}) {
      assertUsable();
      return afterLifecycle(() => options.lifecycle.enable(identity, operationOptions));
    },
    disable(identity, operationOptions = {}) {
      assertUsable();
      return afterLifecycle(() => options.lifecycle.disable(identity, operationOptions));
    },
    async remove(identity, operationOptions = {}) {
      assertUsable();
      await afterLifecycle(async () => {
        await options.lifecycle.remove(identity, operationOptions);
      });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      discoverySubscription.dispose();
      listeners.clear();
      await reconciliation;
    },
  };

  return Object.freeze(service);

  function assertUsable(): void {
    if (disposed) throw new Error('Runtime native extension status service is disposed.');
  }
}

function lifecycleProxy(
  lifecycle: RuntimeExtensionLifecycleService,
  afterLifecycle: <T>(operation: () => Promise<T>) => Promise<T>,
): RuntimeExtensionLifecycleService {
  const proxy: RuntimeExtensionLifecycleService = {
    restore: (options?: RuntimeExtensionOperationOptions) =>
      afterLifecycle(() => Promise.resolve(lifecycle.restore(options))),
    discover: (
      discovery: RuntimeExtensionPackageDiscovery,
      options?: RuntimeExtensionOperationOptions,
    ) => afterLifecycle(() => Promise.resolve(lifecycle.discover(discovery, options))),
    install: (
      request: RuntimeExtensionInstallRequest,
      options?: RuntimeExtensionInstallOptions,
    ) => afterLifecycle(() => lifecycle.install(request, options)),
    update: (
      identity: string,
      request: RuntimeExtensionInstallRequest,
      options?: RuntimeExtensionInstallOptions,
    ) => afterLifecycle(() => lifecycle.update(identity, request, options)),
    configure: (
      identity: string,
      configuration: RuntimeExtensionConfiguration,
      options?: RuntimeExtensionOperationOptions,
    ) => afterLifecycle(() =>
      Promise.resolve(lifecycle.configure(identity, configuration, options))),
    setProviderOverride: (
      identity: string,
      service: string,
      providerIdentity: string,
      options?: RuntimeExtensionOperationOptions,
    ) => afterLifecycle(() =>
      Promise.resolve(
        lifecycle.setProviderOverride(
          identity,
          service,
          providerIdentity,
          options,
        ),
      )),
    clearProviderOverride: (
      identity: string,
      service: string,
      options?: RuntimeExtensionOperationOptions,
    ) => afterLifecycle(() =>
      Promise.resolve(lifecycle.clearProviderOverride(identity, service, options))),
    ...(lifecycle.repairContractConflict
      ? {
          repairContractConflict: (
            request: RuntimeExtensionContractRepairRequest,
            options?: RuntimeExtensionOperationOptions,
          ) => afterLifecycle(() =>
            Promise.resolve(lifecycle.repairContractConflict!(request, options))),
        }
      : {}),
    enable: (identity: string, options?: RuntimeExtensionOperationOptions) =>
      afterLifecycle(() => lifecycle.enable(identity, options)),
    disable: (identity: string, options?: RuntimeExtensionOperationOptions) =>
      afterLifecycle(() => lifecycle.disable(identity, options)),
    remove: (identity: string, options?: RuntimeExtensionOperationOptions) =>
      afterLifecycle(async () => {
        await lifecycle.remove(identity, options);
      }),
    get: lifecycle.get.bind(lifecycle),
    list: lifecycle.list.bind(lifecycle),
  };
  return proxy;
}

async function inspectInstallations(
  candidates: readonly RuntimeNativeExtensionCandidate[],
  options: RuntimeNativeExtensionStatusOptions['installation'],
): Promise<ReadonlyMap<string, InstallationInspection>> {
  const inspections = new Map<string, InstallationInspection>();
  await Promise.all(candidates.map(async (candidate) => {
    if (
      (candidate.status !== 'installable' && candidate.status !== 'unbuilt')
      || !candidate.manifest.installation
    ) {
      return;
    }
    try {
      const plan = await inspectRuntimeNativeExtensionInstallation(
        candidate.packageRoot,
        { commands: options?.commands },
      );
      inspections.set(pathKey(candidate.packageRoot), { plan });
    } catch (error) {
      inspections.set(pathKey(candidate.packageRoot), {
        diagnostic: installationDiagnostic(error, candidate.packageRoot),
      });
    }
  }));
  return inspections;
}

function buildSnapshot(
  revision: number,
  discovery: RuntimeNativeExtensionDiscoverySnapshot,
  installed: readonly import('@marshal/agent-runtime-extensions').RuntimeExtensionLifecycleRecord[],
  inspections: ReadonlyMap<string, InstallationInspection>,
  installations: ReadonlyMap<string, ActiveInstallation>,
  failures: ReadonlyMap<string, InstallationFailure>,
): RuntimeExtensionStatusSnapshot {
  const matchedInstalled = new Set<string>();
  const entries = discovery.candidates.map((candidate) => {
    const key = pathKey(candidate.packageRoot);
    const installation = installations.get(key);
    const failure = failures.get(key);
    const inspection = inspections.get(key);
    const installedRecord = candidate.status === 'installable'
      ? installed.find((record) =>
          record.identity === candidate.identity
          && record.version === candidate.version
          && record.integrity.algorithm === candidate.catalogEntry.request.integrity.algorithm
          && record.integrity.domain === candidate.catalogEntry.request.integrity.domain
          && record.integrity.value === candidate.catalogEntry.request.integrity.value)
      : undefined;
    if (installedRecord) matchedInstalled.add(installedRecord.identity);
    return projectCandidate(
      candidate,
      installedRecord,
      inspection,
      installation,
      failure,
    );
  });
  for (const record of installed) {
    if (matchedInstalled.has(record.identity)) continue;
    const key = pathKey(record.request.packageRoot);
    entries.push(Object.freeze({
      key: statusKey(record.request.packageRoot, record.identity, record.version),
      packageRoot: record.request.packageRoot,
      identity: record.identity,
      version: record.version,
      entrypoint: record.entrypoint,
      status: record.status === 'enabled'
        ? 'installed-enabled'
        : 'installed-disabled',
      configuration: configurationStatus(
        undefined,
        record.configurationSchema,
        record.configurationValues,
      ),
      diagnostics: Object.freeze(record.blockReasons.map((reason) =>
        Object.freeze({
          code: reason.code,
          message: reason.message,
          path: record.request.packageRoot,
        }))),
      ...(inspections.get(key)?.plan
        ? { installCommand: installCommand(inspections.get(key)!.plan!) }
        : {}),
    } satisfies RuntimeExtensionStatusEntry));
  }
  const diagnostics = Object.freeze(discovery.diagnostics.map(statusDiagnostic));
  return Object.freeze({
    revision,
    status: discovery.status,
    changedAt: new Date().toISOString(),
    roots: Object.freeze([...discovery.roots]),
    entries: Object.freeze(entries.sort(compareStatusEntries)),
    diagnostics,
  });
}

function projectCandidate(
  candidate: RuntimeNativeExtensionCandidate,
  installed: import('@marshal/agent-runtime-extensions').RuntimeExtensionLifecycleRecord | undefined,
  inspection: InstallationInspection | undefined,
  active: ActiveInstallation | undefined,
  failure: InstallationFailure | undefined,
): RuntimeExtensionStatusEntry {
  const manifest = candidate.status === 'installable' || candidate.status === 'unbuilt'
    ? candidate.manifest
    : undefined;
  const diagnostics = [
    ...candidate.diagnostics.map(statusDiagnostic),
    ...(inspection?.diagnostic ? [inspection.diagnostic] : []),
    ...(failure ? [failure.diagnostic] : []),
    ...(installed?.blockReasons ?? []).map((reason) => Object.freeze({
      code: reason.code,
      message: reason.message,
      path: candidate.packageRoot,
    })),
  ];
  const status = active
    ? 'installing-building'
    : failure
      ? 'failed'
      : installed?.status === 'enabled'
        ? 'installed-enabled'
        : installed?.status === 'disabled'
          ? 'installed-disabled'
          : candidate.status === 'installable'
            ? 'detected-installable'
            : candidate.status === 'unbuilt'
              ? 'detected-unbuilt'
              : candidate.status;
  return Object.freeze({
    key: statusKey(candidate.packageRoot, candidate.identity, candidate.version),
    packageRoot: candidate.packageRoot,
    ...(candidate.identity === undefined ? {} : { identity: candidate.identity }),
    ...(candidate.version === undefined ? {} : { version: candidate.version }),
    ...(manifest ? { entrypoint: manifest.entrypoint } : {}),
    ...(candidate.status === 'installable'
      ? { catalogEntryId: candidate.catalogEntry.id }
      : {}),
    status,
    ...(active ? { installationPhase: active.phase } : {}),
    ...(inspection?.plan ? { installCommand: installCommand(inspection.plan) } : {}),
    configuration: configurationStatus(
      manifest?.configuration?.defaults,
      installed?.configurationSchema ?? manifest?.configuration?.schema,
      installed?.configurationValues,
    ),
    diagnostics: Object.freeze(diagnostics),
  });
}

function configurationStatus(
  defaults: RuntimeExtensionConfiguration | undefined,
  schema: unknown,
  values: RuntimeExtensionConfiguration | undefined,
): RuntimeExtensionStatusEntry['configuration'] {
  return Object.freeze({
    ...(schema === undefined ? {} : { schema }),
    defaults: Object.freeze({ ...(defaults ?? {}) }),
    ...(values === undefined ? {} : { values: Object.freeze({ ...values }) }),
  });
}

function installCommand(
  plan: RuntimeNativeExtensionInstallationPlan,
): NonNullable<RuntimeExtensionStatusEntry['installCommand']> {
  return Object.freeze({
    packageManager: plan.packageManager,
    script: plan.script,
    executable: plan.command.executable,
    arguments: Object.freeze([...plan.command.arguments]),
  });
}

function statusDiagnostic(
  diagnostic: {
    readonly code: string;
    readonly message: string;
    readonly path?: string;
  },
): RuntimeExtensionStatusDiagnostic {
  return Object.freeze({
    code: diagnostic.code,
    message: diagnostic.message,
    ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
  });
}

function installationDiagnostic(
  error: unknown,
  packageRoot: string,
): RuntimeExtensionStatusDiagnostic {
  const code = error instanceof RuntimeNativeExtensionInstallationError
    ? error.code.toLowerCase()
    : 'installation_failed';
  const message = error instanceof Error
    ? error.message
    : 'Runtime extension installation failed.';
  return Object.freeze({ code, message: message.slice(0, 1_024), path: packageRoot });
}

function findActionableCandidate(
  candidates: readonly RuntimeNativeExtensionCandidate[],
  packageRoot: string,
): ActionableCandidate | undefined {
  const key = pathKey(packageRoot);
  return candidates.find((candidate): candidate is ActionableCandidate =>
    pathKey(candidate.packageRoot) === key
    && (candidate.status === 'installable' || candidate.status === 'unbuilt'));
}

function validateInstallRequest(request: RuntimeExtensionStatusInstallRequest): void {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Runtime extension status install request is invalid.');
  }
  if (typeof request.packageRoot !== 'string' || !path.isAbsolute(request.packageRoot)) {
    throw new TypeError('Runtime extension status packageRoot must be absolute.');
  }
  if (
    request.configuration !== undefined
    && (!request.configuration
      || typeof request.configuration !== 'object'
      || Array.isArray(request.configuration))
  ) {
    throw new TypeError('Runtime extension status configuration must be an object.');
  }
  if (request.enabled !== undefined && typeof request.enabled !== 'boolean') {
    throw new TypeError('Runtime extension status enabled flag must be boolean.');
  }
}

function compareStatusEntries(
  left: RuntimeExtensionStatusEntry,
  right: RuntimeExtensionStatusEntry,
): number {
  return (left.identity ?? '').localeCompare(right.identity ?? '')
    || (left.version ?? '').localeCompare(right.version ?? '')
    || left.packageRoot.localeCompare(right.packageRoot);
}

function statusKey(
  packageRoot: string,
  identity: string | undefined,
  version: string | undefined,
): string {
  return `${identity ?? 'unknown'}@${version ?? 'unknown'}:${pathKey(packageRoot)}`;
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function assertNotAborted(
  signal: RuntimeExtensionOperationOptions['signal'],
): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('Runtime extension operation was cancelled.');
}

function nativeAbortSignal(
  signal: RuntimeExtensionOperationOptions['signal'],
): AbortSignal | undefined {
  if (!signal) return undefined;
  return isNativeAbortSignal(signal) ? signal : undefined;
}

function isNativeAbortSignal(
  signal: NonNullable<RuntimeExtensionOperationOptions['signal']>,
): signal is NonNullable<RuntimeExtensionOperationOptions['signal']> & AbortSignal {
  return typeof Reflect.get(signal, 'addEventListener') === 'function'
    && typeof Reflect.get(signal, 'removeEventListener') === 'function';
}
