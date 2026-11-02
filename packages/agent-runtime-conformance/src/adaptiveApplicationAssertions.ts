import {
  REACT_UI_HYDRATION_FALLBACK_TIMEOUT_MS,
  UI_DECLARED_TOOL_NAME,
} from '@marshal/agent-runtime-ui';
import {
  ADAPTIVE_APPLICATION_CONFORMANCE_CASES,
  type AdaptiveApplicationConformanceCaseName,
  type AdaptiveApplicationConformanceCaseResult,
  type AdaptiveApplicationConformanceEnvironment,
  type AdaptiveApplicationConformanceFixture,
  type AdaptiveApplicationConformanceReport,
} from './adaptiveApplicationContracts.js';
import { ADAPTIVE_APPLICATION_ISOLATED_SCOPE } from './adaptiveApplicationFixture.js';

type AdaptiveAssertion = (environment: AdaptiveApplicationConformanceEnvironment) => Promise<void>;

export class AdaptiveApplicationConformanceError extends Error {
  constructor(
    readonly caseName: AdaptiveApplicationConformanceCaseName | 'suite',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AdaptiveApplicationConformanceError';
  }
}

export const ADAPTIVE_APPLICATION_CONFORMANCE_ASSERTIONS: Readonly<
  Record<AdaptiveApplicationConformanceCaseName, AdaptiveAssertion>
> = {
  'renderer-resource-metadata': assertRendererResourceMetadata,
  'complete-fallback': assertCompleteFallback,
  'stable-cached-display': assertStableCachedDisplay,
  'manifest-recovery': assertManifestRecovery,
  'display-mode-negotiation': assertDisplayModeNegotiation,
  'host-context-lifecycle': assertHostContextLifecycle,
  'host-operations': assertHostOperations,
  'declared-actions': assertDeclaredActions,
  'restart-scope-isolation': assertRestartScopeIsolation,
};

export async function assertRendererResourceMetadata(
  environment: AdaptiveApplicationConformanceEnvironment,
): Promise<void> {
  const provisioned = await environment.provision();
  check(
    'renderer-resource-metadata',
    provisioned.rendererUri.endsWith(`/runtime-renderer/${environment.rendererVersion}/index.html`),
    'The renderer resource URI is not explicitly versioned.',
    provisioned,
  );
  const resources = asArray(await environment.listResources(), 'renderer-resource-metadata', 'resources');
  const descriptor = resources
    .map((value) => asRecord(value, 'renderer-resource-metadata', 'resource descriptor'))
    .find((value) => value.uri === provisioned.rendererUri);
  check(
    'renderer-resource-metadata',
    Boolean(descriptor),
    'The versioned renderer was not exposed by the adapter resource list.',
    resources,
  );
  const content = asRecord(
    await environment.readResource(provisioned.rendererUri),
    'renderer-resource-metadata',
    'renderer content',
  );
  const toolMetadata = asRecord(
    environment.rendererToolMetadata(),
    'renderer-resource-metadata',
    'renderer tool metadata',
  );
  for (const value of [descriptor!, content]) {
    check('renderer-resource-metadata', value.mimeType === 'text/html;profile=mcp-app', 'Renderer MIME type is incorrect.', value);
    check('renderer-resource-metadata', resourceUri(value) === provisioned.rendererUri, 'Renderer resource metadata lost its URI.', value);
  }
  check('renderer-resource-metadata', metadataResourceUri(toolMetadata) === provisioned.rendererUri, 'Tool metadata does not target the versioned renderer.', toolMetadata);
  check('renderer-resource-metadata', toolMetadata['ui/resourceUri'] === provisioned.rendererUri, 'The standards metadata alias is missing.', toolMetadata);
  check('renderer-resource-metadata', typeof content.text === 'string' && content.text.includes(environment.rendererVersion), 'Renderer content does not identify its implementation version.', content);
  check('renderer-resource-metadata', REACT_UI_HYDRATION_FALLBACK_TIMEOUT_MS < 5_000, 'Hydration fallback exceeds the five-second deadline.', REACT_UI_HYDRATION_FALLBACK_TIMEOUT_MS);
  check('renderer-resource-metadata', typeof content.text === 'string' && content.text.includes('fallbackSummary'), 'Renderer does not preserve a useful text fallback on hydration failure.', content);
  const html = String(content.text ?? '');
  for (const marker of [
    'aria-label="Application controls"',
    'aria-label="Display modes"',
    'aria-label="Application actions"',
    'min-height:40px',
    'Picture in picture',
    'Fullscreen',
    'marshal/ui/chrome-action-request',
    'marshal/ui/chrome-action-result',
  ]) {
    check('renderer-resource-metadata', html.includes(marker), `Renderer chrome omitted ${marker}.`, content);
  }
  check(
    'renderer-resource-metadata',
    !/@media[^}]*#chrome/s.test(html),
    'Renderer chrome can be hidden by a narrow-width media rule.',
    content,
  );
}

export async function assertCompleteFallback(
  environment: AdaptiveApplicationConformanceEnvironment,
): Promise<void> {
  const render = await environment.provision();
  const result = asRecord(await environment.display(render.renderId), 'complete-fallback', 'display result');
  const content = asArray(result.content, 'complete-fallback', 'text content');
  const text = asRecord(content[0], 'complete-fallback', 'text fallback').text;
  check('complete-fallback', text === environment.fallback.summary, 'The complete text fallback was not preserved.', result);
  for (const marker of ['INC-42', 'open', 'high', 'acknowledgment']) {
    check('complete-fallback', String(text).includes(marker), `Text fallback omitted ${marker}.`, text);
  }
  const structured = asRecord(result.structuredContent, 'complete-fallback', 'structured content');
  check('complete-fallback', sameJson(structured.fallback, environment.fallback), 'Structured fallback was incomplete or changed.', structured);
  check('complete-fallback', sameJson(structured.application, environment.manifest), 'Structured output omitted the application contract.', structured);
}

export async function assertStableCachedDisplay(
  environment: AdaptiveApplicationConformanceEnvironment,
): Promise<void> {
  const render = await environment.provision();
  const isolated = await environment.provision(ADAPTIVE_APPLICATION_ISOLATED_SCOPE);
  check('stable-cached-display', render.renderId === isolated.renderId, 'Content-addressed render IDs diverged across scopes.', { render, isolated });
  await environment.updateState(render.renderId, 'view', 'alpha');
  await environment.updateState(isolated.renderId, 'view', 'beta', ADAPTIVE_APPLICATION_ISOLATED_SCOPE);
  const before = environment.inspect();
  const initial = asRecord(await environment.display(render.renderId), 'stable-cached-display', 'initial display');
  const isolatedInitial = asRecord(await environment.display(isolated.renderId, ADAPTIVE_APPLICATION_ISOLATED_SCOPE), 'stable-cached-display', 'isolated initial display');
  const reopenDurationsMs: number[] = [];
  for (let index = 0; index < 100; index += 1) {
    if (index === 50) await environment.restart();
    const useIsolatedScope = index % 2 === 1;
    const scope = useIsolatedScope ? ADAPTIVE_APPLICATION_ISOLATED_SCOPE : undefined;
    const expectedDisplay = useIsolatedScope ? isolatedInitial : initial;
    const started = performance.now();
    const cached = asRecord(await environment.display(render.renderId, scope), 'stable-cached-display', `cached display ${index}`);
    reopenDurationsMs.push(performance.now() - started);
    const expectedWorkspace = asRecord(
      asRecord(asRecord(expectedDisplay._meta, 'stable-cached-display', 'expected metadata').marshal, 'stable-cached-display', 'expected marshal metadata').workspace,
      'stable-cached-display',
      'expected workspace observation',
    );
    const cachedWorkspace = asRecord(
      asRecord(asRecord(cached._meta, 'stable-cached-display', 'cached metadata').marshal, 'stable-cached-display', 'cached marshal metadata').workspace,
      'stable-cached-display',
      'cached workspace observation',
    );
    const expectedStable = structuredClone(expectedDisplay);
    const cachedStable = structuredClone(cached);
    delete asRecord(asRecord(asRecord(expectedStable._meta, 'stable-cached-display', 'expected stable metadata').marshal, 'stable-cached-display', 'expected stable marshal metadata').workspace, 'stable-cached-display', 'expected stable workspace').checkedAt;
    delete asRecord(asRecord(asRecord(cachedStable._meta, 'stable-cached-display', 'cached stable metadata').marshal, 'stable-cached-display', 'cached stable marshal metadata').workspace, 'stable-cached-display', 'cached stable workspace').checkedAt;
    check('stable-cached-display', typeof expectedWorkspace.checkedAt === 'string' && Number.isFinite(Date.parse(expectedWorkspace.checkedAt)) && typeof cachedWorkspace.checkedAt === 'string' && Number.isFinite(Date.parse(cachedWorkspace.checkedAt)), `Cached redisplay ${index} omitted a valid workspace observation timestamp.`, { expectedWorkspace, cachedWorkspace });
    check('stable-cached-display', sameJson(expectedStable, cachedStable), `Cached redisplay ${index} changed its scoped display envelope.`, { expectedDisplay, cached });
  }
  const primaryStorage = payloadStorage(await environment.payload(render.renderId), 'stable-cached-display');
  const isolatedStorage = payloadStorage(await environment.payload(render.renderId, ADAPTIVE_APPLICATION_ISOLATED_SCOPE), 'stable-cached-display');
  check('stable-cached-display', sameJson(primaryStorage, { view: 'alpha' }) && sameJson(isolatedStorage, { view: 'beta' }), 'One hundred cached reopens leaked state across scopes.', { primaryStorage, isolatedStorage });
  const after = environment.inspect();
  check('stable-cached-display', displayedRenderId(initial) === render.renderId, 'Initial display changed the stable render ID.', initial);
  check('stable-cached-display', displayedRenderId(isolatedInitial) === render.renderId, 'Isolated display changed the stable render ID.', isolatedInitial);
  check('stable-cached-display', before.compileInvocations === 2 && after.compileInvocations === 2, 'Cached redisplay compiled source again.', { before, after });
  check('stable-cached-display', before.renderBindingInvocations === 2 && after.renderBindingInvocations === 2, 'Cached redisplay created a new render binding.', { before, after });
  check('stable-cached-display', before.sourceContentDigest === after.sourceContentDigest && before.sourceModifiedAtMs === after.sourceModifiedAtMs, 'Cached redisplay rewrote editable source.', { before, after });
  check('stable-cached-display', after.displayInvocations - before.displayInvocations === 102, 'One hundred consecutive cached reopens across isolated scopes were not all exercised.', { before, after });
  const p95 = [...reopenDurationsMs].sort((left, right) => left - right)[Math.ceil(reopenDurationsMs.length * 0.95) - 1] ?? Infinity;
  check('stable-cached-display', p95 <= 2_000, 'Cached runtime-side reopen p95 exceeded two seconds.', { p95, reopenDurationsMs });
}

export async function assertManifestRecovery(
  environment: AdaptiveApplicationConformanceEnvironment,
): Promise<void> {
  const render = await environment.provision();
  const initial = displayApplication(await environment.display(render.renderId), 'manifest-recovery');
  check('manifest-recovery', sameJson(initial, environment.manifest), 'Initial display changed the application manifest.', initial);
  await environment.restart();
  const recovered = displayApplication(await environment.display(render.renderId), 'manifest-recovery');
  const payload = asRecord(await environment.payload(render.renderId), 'manifest-recovery', 'recovered payload');
  const marshal = asRecord(asRecord(payload.structuredContent, 'manifest-recovery', 'payload structuredContent').marshal, 'manifest-recovery', 'payload marshal');
  check('manifest-recovery', sameJson(recovered, environment.manifest), 'Restart recovery lost or changed the application manifest.', recovered);
  check('manifest-recovery', sameJson(marshal.application, environment.manifest), 'Hydration recovery omitted the application manifest.', marshal);
  const observations = environment.inspect();
  check('manifest-recovery', observations.compileInvocations === 1 && observations.renderBindingInvocations === 1, 'Recovery rebuilt immutable source or render state.', observations);
}

export async function assertDisplayModeNegotiation(
  environment: AdaptiveApplicationConformanceEnvironment,
): Promise<void> {
  const render = await environment.provision();
  const host = await environment.connectHost(render.renderId, {
    displayMode: 'inline',
    availableDisplayModes: ['inline', 'fullscreen'],
    displayResponses: { inline: 'inline', fullscreen: 'inline' },
  });
  try {
    check('display-mode-negotiation', matches(await host.requestDisplayMode('inline'), { requested: 'inline', actual: 'inline', status: 'granted' }), 'Inline mode was not granted with a typed result.', host.snapshot());
    check('display-mode-negotiation', matches(await host.requestDisplayMode('fullscreen'), { requested: 'fullscreen', actual: 'inline', status: 'fallback' }), 'Fullscreen host fallback was not typed.', host.snapshot());
    check('display-mode-negotiation', matches(await host.requestDisplayMode('pip'), { requested: 'pip', actual: 'inline', status: 'unsupported' }), 'Unsupported PiP was not explicit.', host.snapshot());
    check('display-mode-negotiation', host.snapshot().requests.some((item) => matches(item, { method: 'ui/request-display-mode', params: { mode: 'fullscreen' } })), 'Display-mode request did not use the canonical MCP Apps params shape.', host.snapshot());
  } finally {
    host.close();
  }
  const denyingHost = await environment.connectHost(render.renderId, {
    displayMode: 'inline',
    availableDisplayModes: ['inline', 'fullscreen', 'pip'],
    deniedDisplayModes: ['pip'],
  });
  try {
    check('display-mode-negotiation', matches(await denyingHost.requestDisplayMode('pip'), { requested: 'pip', actual: 'inline', status: 'denied' }), 'A host denial did not produce a typed PiP fallback.', denyingHost.snapshot());
  } finally {
    denyingHost.close();
  }
}

export async function assertHostContextLifecycle(
  environment: AdaptiveApplicationConformanceEnvironment,
): Promise<void> {
  const render = await environment.provision();
  const host = await environment.connectHost(render.renderId, {
    displayMode: 'inline',
    availableDisplayModes: ['inline', 'fullscreen', 'pip'],
    context: { theme: 'light', locale: 'en-US', timezone: 'UTC', platform: 'standards-test' },
  });
  for (const [method, params] of [
    ['ui/notifications/tool-input', { incidentId: 'INC-42' }],
    ['ui/notifications/tool-input-partial', { incidentId: 'INC' }],
    ['ui/notifications/tool-result', { acknowledged: true }],
    ['ui/notifications/tool-cancelled', { reason: 'cancelled by host' }],
    ['ui/notifications/tool-error', { code: 'host_error', message: 'Host error' }],
    ['ui/notifications/host-context-changed', {
      theme: 'dark', locale: 'he-IL', timezone: 'Asia/Jerusalem', displayMode: 'fullscreen',
      availableDisplayModes: ['inline', 'fullscreen', 'pip'],
      containerDimensions: { width: 1200, height: 800 },
      safeAreaInsets: { top: 8, right: 12, bottom: 16, left: 12 },
    }],
    ['ui/notifications/teardown', { reason: 'host closed app' }],
  ] as const) {
    host.emit({ jsonrpc: '2.0', method, params });
  }
  const snapshot = host.snapshot();
  const eventTypes = snapshot.events.map((event) => event.type);
  for (const type of ['tool-input', 'tool-input-partial', 'tool-result', 'tool-cancelled', 'tool-error', 'host-context-changed', 'teardown']) {
    check('host-context-lifecycle', eventTypes.includes(type as never), `Lifecycle event ${type} was not delivered.`, snapshot);
  }
  check('host-context-lifecycle', matches(snapshot.context, { theme: 'dark', locale: 'he-IL', timezone: 'Asia/Jerusalem', displayMode: 'fullscreen' }), 'Host context changes were not retained.', snapshot);
  check('host-context-lifecycle', snapshot.notifications.some((item) => item.method === 'ui/notifications/initialized'), 'Initialization lifecycle notification was omitted.', snapshot);
  host.close();
}

export async function assertHostOperations(
  environment: AdaptiveApplicationConformanceEnvironment,
): Promise<void> {
  const render = await environment.provision();
  const host = await environment.connectHost(render.renderId, {
    displayMode: 'inline',
    availableDisplayModes: ['inline', 'fullscreen'],
    capabilities: {
      serverTools: true,
      serverResources: true,
      extensions: { conformance: { methods: ['ping'] } },
    },
    requestResults: {
      'ui/message': { accepted: true },
      'ui/update-model-context': { accepted: true },
      'ui/open-link': { opened: true },
      'marshal/extensions/call': {
        namespace: 'conformance',
        method: 'ping',
        status: 'success',
        result: { pong: true },
      },
    },
  });
  try {
    await host.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Compare direction B.' }] });
    await host.updateModelContext({ content: [{ type: 'text', text: 'The user selected direction B.' }] });
    const link = asRecord(
      await host.openLink({ url: 'https://example.com/design-system' }),
      'host-operations',
      'open-link result',
    );
    host.reportSize({ width: 799.2, height: 599.1 });
    check('host-operations', host.supportsHostExtension('conformance', 'ping'), 'Advertised host extension was not discoverable.', host.snapshot());
    check('host-operations', !host.supportsHostExtension('conformance', 'missing'), 'Unadvertised host extension was reported as supported.', host.snapshot());
    const extension = asRecord(
      await host.callHostExtension('conformance', 'ping', [{ value: 42 }]),
      'host-operations',
      'host extension result',
    );
    const unsupported = asRecord(
      await host.callHostExtension('conformance', 'missing'),
      'host-operations',
      'unsupported host extension result',
    );
    const snapshot = host.snapshot();
    check('host-operations', link.opened === true, 'Open-link result was not preserved.', link);
    check('host-operations', matches(extension, {
      namespace: 'conformance', method: 'ping', status: 'success', result: { pong: true },
    }), 'Advertised host extension result was not preserved.', extension);
    check('host-operations', matches(unsupported, {
      namespace: 'conformance', method: 'missing', status: 'unsupported',
    }), 'Unadvertised host extension did not degrade to a typed unsupported result.', unsupported);
    for (const expected of [
      { method: 'ui/message', params: { role: 'user', content: [{ type: 'text', text: 'Compare direction B.' }] } },
      { method: 'ui/update-model-context', params: { content: [{ type: 'text', text: 'The user selected direction B.' }] } },
      { method: 'ui/open-link', params: { url: 'https://example.com/design-system' } },
      { method: 'marshal/extensions/call', params: { namespace: 'conformance', method: 'ping', args: [{ value: 42 }] } },
    ]) {
      check('host-operations', snapshot.requests.some((request) => matches(request, expected)), `Host operation ${expected.method} did not preserve its canonical request shape.`, snapshot);
    }
    check('host-operations', snapshot.requests.filter((request) => request.method === 'marshal/extensions/call').length === 1, 'An unadvertised host extension crossed the transport boundary.', snapshot);
    check('host-operations', snapshot.notifications.some((notification) => matches(notification, {
      method: 'ui/notifications/size-changed', params: { width: 800, height: 600 },
    })), 'Size reporting did not use the canonical rounded MCP Apps notification.', snapshot);
  } finally {
    host.close();
  }
}

export async function assertDeclaredActions(
  environment: AdaptiveApplicationConformanceEnvironment,
): Promise<void> {
  const render = await environment.provision();
  const host = await environment.connectHost(render.renderId, {
    displayMode: 'inline', availableDisplayModes: ['inline'],
  });
  try {
    await rejects('declared-actions', () => host.callTool('undeclared', {}), 'not declared');
    await rejects('declared-actions', () => host.callTool('incident-read', { incidentId: 7 }), 'schema validation');
    const toolOutput = asRecord(
      await host.callTool('incident-read', { incidentId: 'INC-42' }),
      'declared-actions',
      'declared tool result',
    );
    check(
      'declared-actions',
      sameJson(toolOutput, { incidentId: 'INC-42', status: 'open' }),
      'Declared tool did not preserve its typed output.',
      toolOutput,
    );
    check(
      'declared-actions',
      host.snapshot().requests.some((item) => matches(item, {
        method: 'tools/call',
        params: {
          name: UI_DECLARED_TOOL_NAME,
          arguments: {
            renderId: render.renderId,
            toolId: 'incident-read',
            input: { incidentId: 'INC-42' },
          },
        },
      })),
      'Declared tool did not use the canonical MCP Apps tools/call request through the render-bound dispatcher.',
      host.snapshot(),
    );
    await rejects('declared-actions', () => host.callAction('undeclared', {}, { scope: 'project' }), 'not declared');
    await rejects('declared-actions', () => host.callAction('acknowledge', { incidentId: 7 }, { scope: 'project', idempotencyKey: 'invalid-schema' }), 'schema validation');
    await rejects('declared-actions', () => host.callAction('acknowledge', { incidentId: 'INC-42' }, { scope: 'workspace', idempotencyKey: 'invalid-scope' }), 'does not allow');
    await rejects('declared-actions', () => host.callAction('acknowledge', { incidentId: 'INC-42' }, { scope: 'project' }), 'requires an idempotency key');

    const first = asRecord(await host.callAction('acknowledge', { incidentId: 'INC-42' }, { scope: 'project', idempotencyKey: 'declared-action-once' }), 'declared-actions', 'action result');
    const replayed = asRecord(await host.callAction('acknowledge', { incidentId: 'INC-42' }, { scope: 'project', idempotencyKey: 'declared-action-once' }), 'declared-actions', 'replayed action result');
    const denied = asRecord(await host.callAction('acknowledge', { incidentId: 'deny' }, { scope: 'project', idempotencyKey: 'declared-action-denied' }), 'declared-actions', 'denied action result');
    const receipt = asRecord(first.receipt, 'declared-actions', 'action receipt');
    check('declared-actions', first.status === 'success' && sameJson(first.output, { acknowledged: true }), 'Declared action did not preserve its typed output.', first);
    check('declared-actions', receipt.actionId === 'acknowledge' && receipt.scope === 'project', 'Action receipt omitted declaration or scope.', receipt);
    check('declared-actions', matches(receipt.target, { kind: 'capability', capability: 'incidents.acknowledge' }), 'Action receipt omitted the declared target.', receipt);
    check('declared-actions', matches(receipt.permission, { decision: 'allow', grants: ['incidents.write'] }), 'Action receipt omitted permission grants.', receipt);
    check('declared-actions', Boolean(receipt.targetReceipt), 'Action receipt omitted the target execution receipt.', receipt);
    check('declared-actions', asRecord(replayed.receipt, 'declared-actions', 'replay receipt').replayed === true, 'Idempotent replay was not identified.', replayed);
    check('declared-actions', denied.status === 'denied' && matches(asRecord(denied.receipt, 'declared-actions', 'denial receipt').permission, { decision: 'deny', code: 'permission_denied' }), 'Permission denial was not typed or receipted.', denied);
    const observations = environment.inspect();
    check('declared-actions', observations.toolExecutions === 1, 'Rejected declared-tool calls reached the target.', observations);
    check('declared-actions', observations.actionExecutions === 1, 'Idempotent replay or denial invoked the target more than once.', observations);
    check('declared-actions', observations.authorizationRequests.every((item) => sameJson(item.requiredPermissions, ['incidents.write']) && item.requestedScope === 'project'), 'The adapter did not authorize against declared permissions and scope.', observations);
  } finally {
    host.close();
  }
}

export async function assertRestartScopeIsolation(
  environment: AdaptiveApplicationConformanceEnvironment,
): Promise<void> {
  const primary = await environment.provision();
  await rejects('restart-scope-isolation', () => environment.display(primary.renderId, ADAPTIVE_APPLICATION_ISOLATED_SCOPE), 'not found');
  await environment.updateState(primary.renderId, 'view', 'alpha');
  const actionInput = {
    actionId: 'acknowledge', input: { incidentId: 'INC-42' }, scope: 'project', idempotencyKey: 'restart-once',
  };
  await environment.invokeAction(primary.renderId, actionInput);
  await environment.restart();
  const replayed = actionResult(await environment.invokeAction(primary.renderId, actionInput));
  check('restart-scope-isolation', asRecord(replayed.receipt, 'restart-scope-isolation', 'restart replay receipt').replayed === true, 'Action replay was not durable across restart.', replayed);

  const isolated = await environment.provision(ADAPTIVE_APPLICATION_ISOLATED_SCOPE);
  check('restart-scope-isolation', isolated.renderId === primary.renderId, 'Content-addressed render ID changed across isolated scopes.', { primary, isolated });
  await environment.updateState(isolated.renderId, 'view', 'beta', ADAPTIVE_APPLICATION_ISOLATED_SCOPE);
  await environment.invokeAction(isolated.renderId, actionInput, ADAPTIVE_APPLICATION_ISOLATED_SCOPE);
  let primaryStorage = payloadStorage(await environment.payload(primary.renderId), 'restart-scope-isolation');
  let isolatedStorage = payloadStorage(await environment.payload(isolated.renderId, ADAPTIVE_APPLICATION_ISOLATED_SCOPE), 'restart-scope-isolation');
  check('restart-scope-isolation', sameJson(primaryStorage, { view: 'alpha' }) && sameJson(isolatedStorage, { view: 'beta' }), 'Application state leaked across project scopes.', { primaryStorage, isolatedStorage });
  await environment.restart();
  primaryStorage = payloadStorage(await environment.payload(primary.renderId), 'restart-scope-isolation');
  isolatedStorage = payloadStorage(await environment.payload(isolated.renderId, ADAPTIVE_APPLICATION_ISOLATED_SCOPE), 'restart-scope-isolation');
  check('restart-scope-isolation', sameJson(primaryStorage, { view: 'alpha' }) && sameJson(isolatedStorage, { view: 'beta' }), 'Restart recovery merged isolated state.', { primaryStorage, isolatedStorage });
  check('restart-scope-isolation', environment.inspect().actionExecutions === 2, 'Idempotency records leaked across project scopes or failed restart replay.', environment.inspect());
}

export async function runAdaptiveApplicationConformanceSuite(
  fixture: AdaptiveApplicationConformanceFixture,
): Promise<AdaptiveApplicationConformanceReport> {
  const cases: AdaptiveApplicationConformanceCaseResult[] = [];
  for (const name of ADAPTIVE_APPLICATION_CONFORMANCE_CASES) {
    const started = Date.now();
    let environment: AdaptiveApplicationConformanceEnvironment | undefined;
    try {
      environment = await fixture.create(name);
      await ADAPTIVE_APPLICATION_CONFORMANCE_ASSERTIONS[name](environment);
      cases.push({ name, status: 'passed', durationMs: Date.now() - started });
    } catch (error) {
      cases.push({
        name,
        status: 'failed',
        durationMs: Date.now() - started,
        error: {
          message: error instanceof Error ? error.message : String(error),
          details: error instanceof AdaptiveApplicationConformanceError ? error.details : undefined,
        },
      });
    } finally {
      await environment?.dispose();
    }
  }
  const failed = cases.filter((item) => item.status === 'failed').length;
  return {
    adapterName: fixture.name,
    ok: failed === 0,
    passed: cases.length - failed,
    failed,
    cases,
  };
}

export async function assertAdaptiveApplicationConformance(
  fixture: AdaptiveApplicationConformanceFixture,
): Promise<AdaptiveApplicationConformanceReport> {
  const report = await runAdaptiveApplicationConformanceSuite(fixture);
  if (!report.ok) {
    throw new AdaptiveApplicationConformanceError(
      'suite',
      `Adaptive application adapter ${fixture.name} failed conformance: ${report.cases
        .filter((item) => item.status === 'failed')
        .map((item) => `${item.name}: ${item.error?.message ?? 'failed'}`)
        .join('; ')}`,
      report,
    );
  }
  return report;
}

function displayApplication(value: unknown, caseName: AdaptiveApplicationConformanceCaseName): unknown {
  return asRecord(asRecord(value, caseName, 'display result').structuredContent, caseName, 'display structuredContent').application;
}

function displayedRenderId(value: Record<string, unknown>): unknown {
  return asRecord(asRecord(value.structuredContent, 'stable-cached-display', 'structuredContent').render, 'stable-cached-display', 'render').id;
}

function actionResult(value: unknown): Record<string, unknown> {
  return asRecord(asRecord(value, 'restart-scope-isolation', 'action tool result').structuredContent, 'restart-scope-isolation', 'action structuredContent');
}

function payloadStorage(value: unknown, caseName: AdaptiveApplicationConformanceCaseName): unknown {
  const structured = asRecord(asRecord(value, caseName, 'payload result').structuredContent, caseName, 'payload structuredContent');
  return asRecord(structured.marshal, caseName, 'payload marshal').storage;
}

function resourceUri(value: Record<string, unknown>): unknown {
  return metadataResourceUri(
    asRecord(value._meta, 'renderer-resource-metadata', 'resource _meta'),
  );
}

function metadataResourceUri(value: Record<string, unknown>): unknown {
  return asRecord(value.ui, 'renderer-resource-metadata', 'resource ui metadata').resourceUri;
}

async function rejects(
  caseName: AdaptiveApplicationConformanceCaseName,
  operation: () => Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    check(caseName, error instanceof Error && error.message.includes(message), `Expected rejection containing ${message}.`, error);
    return;
  }
  check(caseName, false, `Expected rejection containing ${message}.`);
}

function check(
  caseName: AdaptiveApplicationConformanceCaseName,
  condition: unknown,
  message: string,
  details?: unknown,
): asserts condition {
  if (!condition) throw new AdaptiveApplicationConformanceError(caseName, message, details);
}

function asRecord(
  value: unknown,
  caseName: AdaptiveApplicationConformanceCaseName,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AdaptiveApplicationConformanceError(caseName, `${label} must be an object.`, value);
  }
  return value as Record<string, unknown>;
}

function asArray(
  value: unknown,
  caseName: AdaptiveApplicationConformanceCaseName,
  label: string,
): unknown[] {
  if (!Array.isArray(value)) {
    throw new AdaptiveApplicationConformanceError(caseName, `${label} must be an array.`, value);
  }
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
}

function matches(value: unknown, expected: Record<string, unknown>): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = value as Record<string, unknown>;
  return Object.entries(expected).every(([key, child]) => sameJson(actual[key], child));
}
