# `@marshal/agent-runtime-conformance`

Harness-neutral conformance assertions for adapters that expose the portable
Marshal agent runtime. It imports portable runtime packages for its real
fixtures, but never imports Codex, ChatGPT, Electron, or another harness.

The suite verifies:

- protocol negotiation and unsupported-major rejection;
- deterministic exact-name lookup;
- operation execution without input/output distortion;
- denial, approval, and cancellation without provider invocation;
- idempotent lifecycle delivery;
- scope isolation;
- reserved runtime-tool precedence over dynamic resource tools;
- explicit unsupported native effects;
- standardized execution and effect receipts;
- legacy `operation` and implicit-`target` aliases only when advertised.

## Structural fixture

Adapters supply an `AdapterConformanceFixture`. Each case receives a fresh
environment so state cannot leak between assertions:

```ts
import {
  assertAdapterConformance,
  type AdapterConformanceFixture,
} from '@marshal/agent-runtime-conformance';

const fixture: AdapterConformanceFixture = {
  name: 'my-harness',
  manifest: {
    supportedProtocolVersion: '1.0.0',
    unsupportedProtocolVersion: '2.0.0',
    capabilities: {
      echo: 'conformance.echo',
      denied: 'conformance.denied',
      approval: 'conformance.approval',
      cancellable: 'conformance.cancellable',
      scopeWrite: 'conformance.scope.write',
      scopeRead: 'conformance.scope.read',
      nativeEffects: 'runtime.effects.execute',
    },
    primaryContext,
    isolatedContext,
    resourceFallback: {
      toolName: 'runtime_exec',
      input: {
        targetType: 'operation',
        target: 'conformance.echo',
        input: { value: 'resource-fallback' },
      },
      expectedOutput: { value: 'resource-fallback' },
    },
    unsupportedEffectKind: 'conformance.unsupported-effect',
    legacyAliases: { operation: true, implicitTarget: true },
  },
  async create(caseName) {
    return createHarnessSpecificEnvironment(caseName);
  },
};

await assertAdapterConformance(fixture);
```

The fixture mounts test-only echo/policy/scope capabilities and provides
instrumentation through `inspect()`. Its structural port may wrap native tools,
MCP, HTTP, hooks, or an in-process adapter. Transport envelopes should be
unwrapped by the fixture so `search()` and `execute()` return the portable
response objects; this keeps transport-specific parsing outside the suite.

`runAdapterConformanceSuite()` returns a complete pass/fail/skip report instead
of throwing. Individual assertions such as `assertExactLookup()` and
`assertResourceFallback()` can be registered directly with a harness's own test
runner. `createSelfTestConformanceFixture()` is an exported deterministic
in-memory fixture that validates the suite itself and illustrates the contract.

`createComposerConformanceFixture()` is the first real portable fixture. It
registers test capabilities in `agent-runtime-core`, binds them through
`agent-runtime-composer`, and runs discovery, execution, policy, cancellation,
scope, lifecycle, reserved-tool precedence, and receipt assertions against those real
objects. It intentionally advertises no transport-specific legacy aliases.

## Codex adapter integration

After the Codex adapter rewrite, its package test should:

1. create a real test host with the conformance capabilities and scoped policy;
2. connect the Codex MCP client exactly as production does;
3. implement `search`, `execute`, and lifecycle methods by calling
   `runtime_search`, `runtime_exec`, and the lifecycle tools, then unwrap their
   structured results;
4. implement `callTool` through the same MCP dispatcher so reserved runtime
   tools bypass the resource plane and cannot be shadowed;
5. pass Codex's cancellation token and two distinct session contexts through the
   structural port;
6. advertise only the legacy aliases the Codex boundary intentionally supports;
7. run `await assertAdapterConformance(codexFixture)`.

The Codex fixture belongs in the Codex adapter package. No Codex code or SDK is
imported here.

## Adaptive application conformance

`assertAdaptiveApplicationConformance()` runs the same nine-case observable
contract against any structural MCP Apps resource plane. It covers:

- explicitly versioned renderer resources and matching resource/tool metadata;
- complete text and structured fallback results;
- initial display and cached redisplay through one stable render ID, without a
  new compilation or render binding;
- immutable application-manifest preservation during restart recovery;
- inline, fullscreen, and picture-in-picture negotiation with typed granted,
  unsupported, denied, and fallback results;
- host-context changes plus input, partial-input, result, cancellation, error,
  and teardown lifecycle events;
- app-to-host messages, model-context updates, links, size reporting, and
  feature-detected host extensions with typed unsupported fallback;
- declared action schemas, scopes, permissions, receipts, and idempotent replay;
- durable restart recovery and project-scope state/action isolation.

The exported `createAdaptiveApplicationConformanceFixture()` is standards-only
by default. A harness supplies only `resourceFactory` to place its real resource
adapter at the edge; the setup, actions, in-process host transport, assertions,
and expected observations remain unchanged. The Codex package uses this seam to
exercise `CompositeMcpAppsResourceAdapter` without importing Codex into a
portable package or claiming a live-host mount.

### Official MCP Apps host boundary

The test suite also connects the real `MarshalUiClient` and the unchanged
portable adaptive-application fixture to the published
`@modelcontextprotocol/ext-apps/app-bridge` `AppBridge` over the MCP SDK's linked
in-memory transport. That independent implementation validates the stable
initialization handshake, initialized notification, host context, display-mode
request, host lifecycle notifications, and an action-backed `tools/call` with
its permission receipt.

The [official `@modelcontextprotocol/ext-apps` package](https://github.com/modelcontextprotocol/ext-apps#using-the-sdk)
does not export a `reference-host` module. Its repository describes
[`examples/basic-host`](https://github.com/modelcontextprotocol/ext-apps/tree/main/examples/basic-host)
as the reference implementation, but that Vite/React double-iframe application
is source-only rather than a supported embeddable package API. Consequently
this automated check is protocol-host integration evidence, not evidence for
iframe sandbox behavior, CSP enforcement, browser rendering, or pixels. Those
require running the source example or another real host and remain separate
live-host evidence.
