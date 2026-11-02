# Adapter authoring and conformance

A Marshal adapter translates one harness into portable ports. It may depend on
portable packages; portable packages must never import the adapter. MCP is the
universal capability/resource plane. Lifecycle callbacks, UI presentation,
approvals, task creation, and other native effects are optional adapter planes.

## Choose the smallest composition boundary

For an ordinary tool-calling host, start with `@marshal/runtime/mcp`:
`createRuntimeToolAdapter()` supplies canonical schemas, trusted-session dispatch,
result envelopes, reserved-tool precedence, and optional resource/lifecycle
mapping. `createRuntimeMcpServer()` wraps that dispatcher in standard MCP.
The `marshal-runtime-mcp` executable provides the basic stdio composition.
Acme's adapter belongs to its agent-gateway service: it derives authority from
authenticated RPCs or durable run claims and uses ADK as its native tool transport.
Native presentation uses the harness's existing surfaces; implementing Marshal
desktop UI, injections, or overrides is not an adapter requirement.

- Use `@marshal/runtime/core` and the runtime composer when the harness supplies its own
  kernel, providers, state, identity, and lifecycle/resource ports.
- Use `@marshal/runtime` when the harness wants the standard host, explicit
  provider-source composition, TypeScript, portable UI, permissions, and receipts.
- Domain extensions are selected and installed independently; adapters should
  consume only their published service-token contracts.
- Keep host-native APIs in the adapter. Convert them to portable results or a
  typed `unsupported`, `denied`, or `fallback` outcome.

An adapter must provide stable harness, installation/profile, workspace,
project, session/task, agent, execution, and parent/root identity where the
host exposes them. It must preserve cancellation, idempotency keys, scope, and
receipts across the boundary.

The generic host requires an external protected lifecycle/job root but no memory
configuration. Brain requires its SQLite and projection roots when selected. Derive
all private roots from native private data storage, reject links and junctions, and
never place raw memory, lifecycle result bodies, or background-job inputs below the
user workspace.

## MCP capability surface

Expose discovery and execution as stable startup tools. The reference names
are `runtime_search` and `runtime_exec`; adapters may translate transport
envelopes but must not distort the portable request/result objects. Reserve
runtime tool names before dispatching dynamic resource tools so a resource
cannot shadow the capability plane.

Keep discovery compact and deterministic: forward the portable `detail` field,
let broad searches default to summary descriptors, and use exact `name` lookup
for the selected capability's full schemas. Do not strip an explicit broad
`detail: "full"` compatibility request, and do not downgrade an exact lookup.

Lifecycle tools are a fallback for hosts without callbacks. When native hooks
are installed, hide or clearly suppress the fallback tools and deliver each
event with a stable ID. Duplicate delivery after restart must replay the prior
completed or failed receipt. Recovery of an expired in-flight owner is
at-least-once, so every side-effecting lifecycle delegate must propagate the
stable event ID to its own idempotency key or transaction boundary.

## Required structural conformance

Install the test kit at the same version as the adapter:

```bash
npm install --save-dev @marshal/agent-runtime-conformance@0.1.0
```

Create an `AdapterConformanceFixture` whose port calls the adapter through the
same transport/dispatcher used in production. Transport-specific envelopes are
unwrapped in the fixture, not in the shared assertions:

```ts
import {
  assertAdapterConformance,
  type AdapterConformanceFixture,
} from '@marshal/agent-runtime-conformance';

const fixture: AdapterConformanceFixture = {
  name: 'my-harness',
  manifest: adapterConformanceManifest,
  create: (caseName) => createFreshHarnessEnvironment(caseName),
};

const report = await assertAdapterConformance(fixture);
```

Each case gets fresh state. The shared suite checks protocol negotiation,
exact discovery, execution, denial/approval, cancellation, lifecycle
idempotency, scope isolation, reserved-tool precedence, explicit unsupported
effects, receipts, and only the legacy aliases the adapter advertises.

## MCP Apps resource conformance

UI adapters run the unchanged nine-case application contract. The default
fixture is a standards-only MCP Apps host. To test a harness, replace only the
resource-plane edge:

```ts
import {
  assertAdaptiveApplicationConformance,
  createAdaptiveApplicationConformanceFixture,
} from '@marshal/agent-runtime-conformance';

const report = await assertAdaptiveApplicationConformance(
  createAdaptiveApplicationConformanceFixture({
    name: 'my-harness-mcp-apps',
    resourceFactory({ react, stateRoot }) {
      return new MyHarnessResourceAdapter({ react, stateRoot });
    },
  }),
);
```

The shared fixture covers versioned resources and metadata, complete fallback,
stable cached display, immutable manifest recovery, inline/fullscreen/PiP
negotiation, host lifecycle/context events, app-to-host operations, optional
extensions, declared permissioned actions, and restart/scope isolation. A
passing fixture proves protocol observations—not
live host pixels. Record a separate uncut host run for rendering claims.

## Adapter release gate

Before claiming support for a host:

1. Run both shared conformance suites without changing their assertions.
2. Record adapter, runtime protocol, package, harness, and component-library
   profile versions.
3. Run from an independently installed package in an unrelated workspace.
4. Capture every granted, denied, unsupported, and fallback result honestly.
5. Run the host-specific live checks for hooks, UI modes/actions/restart,
   approvals, and native delegation.
6. Keep adapter-specific component libraries and native APIs out of portable
   runtime packages.

The reusable fixture implementation and exact case inventory are documented in
the [`@marshal/agent-runtime-conformance` README](../packages/agent-runtime-conformance/README.md).
