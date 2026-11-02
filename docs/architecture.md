# Architecture

## Dependency direction

```text
                          +--------------------------+
harness adapter  -------->| minimal composer         |----> core
        |                 | (bindings only)          |
        |                 +--------------------------+
        |
        +---------------> local host preset ------------> default knowledge service   
                                      |                  -> provider packages
                                      |                  -> TypeScript and UI
                                      +------------------> effects/jobs/scheduling

Codex adapter  ---------> local host preset + Codex-only capabilities
```

Portable packages define no Codex, ChatGPT, Electron, Claude, or IDE concepts. An adapter translates a harness lifecycle, MCP transport, UI support, and native callbacks into the portable ports.

`agent-runtime-composer` is the dependency-minimal entry point for a harness
that supplies its own kernel/providers/state. `agent-runtime-host` is the
infrastructure-only explicit-composition host. Its ordinary composition selects
the default knowledge service unless the host opts out, but it
does not activate Brain or attachments merely because their packages are
present. Focused providers remain separately composed. Domain-specific memory and
attachment implementations are delivered by independently maintained extensions.

## Planes

- **Capability plane:** MCP search, execute, resources, receipts, and structured errors.
- **Extension plane:** host-materialized local packages, verified manifests and
  integrity, transactional activation, ownership-scoped unload, selected typed
  services, and immediately live capabilities, catalogs, resources, UI
  applications, lifecycle delegates, and background-job handlers.
- **Lifecycle plane:** optional start, observe, compact, and end callbacks.
- **Native-effect plane:** optional harness-owned actions such as visible child agents, approvals, browser surfaces, or task navigation.
- **Scheduling plane:** portable one-time/interval/cron requests projected into
  fixed native effects with fresh reads and idempotent mutations. A harness can
  own the clock, or a host can use the runtime-owned `RuntimeScheduleService`
  (durable file store, claim-leased fires, a `RuntimeWakePort` per host) and the
  `marshal-runtime-scheduler` daemon.
- **Delegation plane:** portable spawn, continuation, completion observation, and explicit cancellation fulfilled by a harness adapter port.
- **Artifact plane:** scoped durable files, source modules, attachments, UI bundles, and provenance.

An MCP-only harness can use the capability and artifact planes. A richer adapter can additionally fulfill lifecycle and native effects.

## Live extensions

`agent-runtime-extensions` manages trusted portable extension packages while the
kernel remains alive. The host controls the materialized package roots and supplies
the expected integrity digest; the loader performs no network or package-manager
resolution. It confines canonical paths to explicit roots, rejects links and unstable
files, validates matching manifest/package metadata, and executes only a bundled
CommonJS entrypoint with exact host-injected dependencies.

Activation stages and validates all contributions before atomically publishing them
through the core registry. Failed updates clean up the staged activation and preserve
the previous active version. Disable, update, and removal revoke only registrations
owned by that activation, remove resources and applications from discovery
synchronously, and then dispose extension resources. An activation may contribute
capability and catalog providers, scoped resources and UI, selected service
bindings, normal lifecycle delegates, and durable job handlers through the public
extension contracts.

The Runtime checkout conventionally discovers direct-child repositories under
`extensions/`, including the independently maintained Browser, Debugger, Overlay
Review, Attachments, and Brain/memory repositories. This directory is ignored by
the source checkout, but not by Runtime discovery. A valid built package is only
an install candidate: cloning or discovery does not install, enable, or execute
it. Memory and other domain capabilities are delivered by optional extensions
extension rather than the default Runtime composition.

`agent-runtime-dsh` is a detachable runtime adapter, not a portable extension.
It loads the pinned, unchanged `dsh-plugin-bridge` v0.3.0 entrypoint behind
bounded Cordis services and publishes only portable resources and UI contracts.

## Native effects

Portable code emits typed effects instead of importing a harness SDK. Each request includes an idempotency key, requested capability, permission context, and fallback policy. The adapter either returns a normalized product-native result or an explicit unsupported result. Durable background work is represented by persisted job state and resumable handlers, not serialized JavaScript continuations. Scheduling is separate from jobs and from a workflow DSL: the portable layer validates timing and task data, while the adapter owns the clock and native registration.

Visible subagent creation is the reference case. Codex owns its child task,
transcript, approvals, and host session; the runtime carries delegation identity,
scope, status, result/error, and change references.

Dynamic orchestration remains agent-authored TypeScript. The portable
delegation package supplies small host-neutral operations, while the adapter
translates those operations to native child tasks. It does not prescribe
ordering, branches, roles, stages, limits, retries, reviews, or a fixed topology.
