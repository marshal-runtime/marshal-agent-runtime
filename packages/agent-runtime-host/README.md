# `@marshal/agent-runtime-host`

Infrastructure-only, harness-neutral local host for the portable agent runtime.
It owns:

- workspace-contained persistent state in `.marshal/runtime`;
- kernel, receipt, lifecycle, permission, job, and fixed-scope composition;
- explicit provider-source, catalog, and resource ports;
- optional runtime-owned built-ins selected with `createRuntimeBuiltinsSource`;
- generic kernel, lifecycle, resource, and provider-source ports.

Optional domain providers never activate implicitly.

Adapters can pass a stable `identity` (`harnessId`, installation/profile/user
IDs, and an optional native agent ID). Every result records that identity plus
explicit root/parent/depth lineage. The host persists the bounded, idempotent
receipt journal under `.marshal/runtime/receipts`; `bindings.receipts.list()`
and `tree()` remain usable after process restart.

```ts
import {
  createAgentRuntime,
  createRuntimeBuiltinsSource,
} from '@marshal/runtime/host';
import { join } from 'node:path';

const harnessPrivateDataRoot = '/absolute/path/outside/the/workspace';

const runtime = await createAgentRuntime({
  workspacePath: process.cwd(),
  protectedLifecycleResultRoot: join(harnessPrivateDataRoot, 'lifecycle'),
  principal: { id: 'my-harness', kind: 'agent' },
  permissionBroker,
  providerSources: [createRuntimeBuiltinsSource()],
});
```

The protected lifecycle root is required, must be absolute and outside
`workspacePath`, and is rejected if it traverses a symlink or junction.
Domain source factories own their own private-storage validation.

Harness integrations attach through `providerSources`, `effectHandler`, and
`jobHandlers`. Fixed `runtime.schedule.*` effect kinds let the same detachable
effect handler implement native scheduling. The host has no dependency on an
adapter package. An adapter may
depend inward on this package and add its own capabilities, resource plane,
lifecycle event translation, permissions, and command-line entry points.

Domain-specific capabilities are provided by independently maintained
extensions and are not part of this host package.

When native extensions are enabled, `bindings.extensionDiscovery` exposes the
host-owned discovery status for the approved roots. Its immutable snapshots are
monotonically revisioned and include installable catalog entries plus typed
`invalid`, `unbuilt`, and `unreadable` candidates. Filesystem events are
debounced invalidation hints that only trigger a bounded rescan; they never
install, update, enable, rebuild, or execute an extension. Adapters can read
`snapshot()`, subscribe to later revisions, request `refresh()`, and dispose the
service independently. Disposing the runtime also disposes the watcher.
Valid unbuilt candidates expose their validated manifest `installation`
declaration when present; otherwise an `installation_missing` diagnostic makes
the absence explicit so adapters do not invent an install action.
If an optional discovery root is absent, the host watches only its nearest
existing real ancestor and filters events to the exact missing path segment;
unrelated sibling activity does not trigger a rescan. A missing discovery root
must remain inside an existing `allowedRoots` entry so later packages retain
the same loader authorization boundary.

`bindings.extensionStatus` and `RUNTIME_EXTENSION_STATUS_SERVICE` expose the
portable host-UI contract layered over that watcher and the active lifecycle
service. Status entries use the explicit
`detected-unbuilt -> installing-building -> installed-enabled` progression and
include the canonical package root, entrypoint, catalog ID, diagnostics,
resolved executable/package-manager/script arguments, and configuration
schema/default/current values. `install({ packageRoot, configuration })` runs
trusted preparation, recalculates integrity, and installs or updates enabled by
default. `disable`, `enable`, and `remove` publish later revisions only after
the lifecycle mutation commits.

The extension catalog service remains the administration surface and includes
not-installed and disabled candidates. Generic runtime search, runtime catalog
projection, extension resources, and Quillstone extension intelligence expose
only lifecycle records whose current status is `enabled`. Lifecycle
install/enable operations add those live projections without a restart, while
disable/remove operations retire them. Extension-owned resource providers are
also resolved dynamically through the host resource plane, so skill resources,
render resources, and catalog-backed namespaces follow the same enabled-only
lifecycle without static host skill files.

`createRuntimeHostMaterializer()` prepares explicit unpinned local packages
before calculating their integrity. When `runtime-extension.json` declares an
`installation` package script, the host runs that script directly as trusted
repository code and captures bounded stdout/stderr. A non-zero exit or
cancellation prevents materialization and activation. Supplying a pinned
integrity skips repository preparation, preserving immutable package behavior.

The default permission profile denies trusted Node execution and imports. It also
keeps `runtime.effects.execute`, job start/cancel/resume, and schedule mutations opt-in;
adapters or hosts must add those exact grants through `permissionPatterns`.
Scoped job-status and schedule get/list reads retain low-risk
`runtime.jobs.read` and `runtime.schedules.read` grants.
The generic effect capability cannot invoke reserved `runtime.schedule.*`
kinds. Scheduling adapters receive the host-owned principal and complete scope
on every call and must use both when resolving opaque schedule IDs.
Interactive approval requires a paired `permissionApproval.requestApproval` and
`permissionApproval.verifyApproval` implementation; absent callbacks default to
deny, and request-only configuration is rejected.
With `MARSHAL_RUNTIME_PERMISSION_PROFILE=trusted-local`, startup may read
comma-separated `MARSHAL_RUNTIME_ALLOWED_PACKAGES` and
`MARSHAL_RUNTIME_ALLOWED_BUILTINS` values; `*` is an explicit wildcard. A
programmatic `importPolicy` takes precedence.

`runtime.module.execute` accepts a `module` reference with kind `inline`,
`workspace_file`, or `artifact`. Workspace source remains under the configured
workspace root. Artifact source is read through `artifacts.read` in the caller's
workspace/project/session scope. Both paths return content-addressed provenance
and reproducibility receipts.

Brokered modules can discover and compose registered capabilities. Each module
is bounded to 64 nested invocations and 8 concurrent invocations by default;
hosts can lower or raise those ceilings with `moduleMaxBrokerInvocations` and
`moduleMaxConcurrentBrokerInvocations`. The module receipt includes the applied
limits, peak concurrency, and a parent-linked receipt for every nested call.
Timeout or cancellation aborts queued calls and propagates an abort signal to
in-flight providers. These are general capability bounds, not a workflow
abstraction, and apply equally to
domain providers, native-agent adapters, or future providers.

Capability discovery is compact by default. Broad searches return summary
descriptors without schemas or annotations; resolving the selected exact
`name` returns the full descriptor. Hosts may pass `detail: "full"` to preserve
the legacy all-schemas broad response when a client explicitly needs it.

The default Quillstone service builds its private Runtime index in the
background and similarly indexes installed extension packages. Creating a
missing user-workspace index remains an explicit local operation gated by
approval; accepted initialization continues as a background job.

Lifecycle requests carry `protocolVersion` and a stable `eventId`. The host
persists a per-session claim before dispatch and a completed or failed result
after dispatch. One live lease owner runs at a time, and a duplicate delivery
replays a recorded result with `lifecycleReceipt.replayed: true`. Recovery from
an expired owner is at-least-once: side-effecting delegates must use `eventId`
as an idempotency key or transaction boundary for the callback-to-receipt crash
window.

Latency-sensitive harness hooks can use the host lifecycle port directly.
Domain lifecycle delegates are installed explicitly by the extension that owns
the domain; command, UI, code-intelligence, TypeScript, effect, job, scheduling,
and delegation providers remain separate from the infrastructure host.
