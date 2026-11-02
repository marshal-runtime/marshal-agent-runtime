# Marshal boundaries with and without harness source control

Status: **authoritative description of the current repository**, 2026-08-03.

This document answers one precise question: what changes when Marshal is
connected to a harness only through public extension points, versus when the
harness owner can integrate Marshal inside the harness source?

The short answer is:

> Marshal always owns the programmable runtime. Harness control replaces
> compatibility transports with native implementations of existing ports; it
> does not move TypeScript, memory, orchestration, UI applications, policy, or
> receipts into the harness.

The existing separation is real. It is defined by the minimal composer in
[`agent-runtime-composer`](../packages/agent-runtime-composer/src/contracts.ts),
the batteries-included portable host in
[`agent-runtime-host`](../packages/agent-runtime-host/src/types.ts), and the
detachable Codex composition in
[`createCodexRuntime`](../packages/agent-runtime-codex/src/runtime.ts). Portable
packages do not import Codex. The existing
[`adapter-authoring`](adapter-authoring.md) and
[`harness contract`](harness-contract.md) documents define conformance and
dependency direction.

## Status vocabulary

- **Implemented**: production source and tests exist in this repository.
- **Port exists**: Marshal already defines the injection boundary; a harness may
  provide a better implementation without changing portable Marshal.
- **Fallback implemented**: the current Codex integration works through a
  public process/protocol boundary because Codex does not expose the equivalent
  in-process API to the plugin.
- **Host-dependent**: the portable request exists, but success depends on an
  actual host feature. Unsupported is a correct result.
- **Missing**: additional portable or adapter work is genuinely required.

## The ownership rule

Marshal always owns:

- Capability discovery, schema validation, invocation and structured results.
- Editable and inline TypeScript compilation/execution, package policy,
  workspace/artifact source resolution and the broker exposed inside modules.
- The agent-authored orchestration program: concurrency, dependencies, retries,
  handles, cancellation decisions and synthesis.
- Delegation transport: runtime identity, parent relationship, scope, current
  status, host handle, result/error and code change references.
- Memory Brain policy/grants, bounded multi-scope search/ranking, deduplication,
  correction/promotion, Markdown authority for durable scopes, SQLite
  materialization/ephemeral authority, and optional graph projection.
- React/TSX source, compilation, application manifests, declared actions/tools,
  state contracts, fallback content, render identity and action receipts.
- Artifacts, portable attachment conversion, permissions, effect intent,
  background jobs, scheduling intent and execution lineage.

A harness adapter owns only translation into facilities the host itself must
own:

- Stable host/user/profile/task/agent identity.
- MCP or native tool/resource registration and invocation transport.
- Delivery of native lifecycle events and model-context injection.
- A native model-inference callback when the host exposes one.
- Creation and control of host-native agent tasks/threads.
- Actual placement of UI resources in host surfaces.
- Host-native approvals, effects, secrets, scheduling, navigation and
  notifications.
- Propagation of host cancellation and, when available, progress events.

## Controlled versus non-controlled integration matrix

| Concern | Marshal owns in both cases | No harness source control | Harness source control | Current status |
| --- | --- | --- | --- | --- |
| Capability discovery and execution | Kernel, descriptors, validation, permission decision, receipts | Register `runtime_search` and `runtime_exec` over MCP | Register the same bindings directly in the native tool registry; MCP may remain for interoperability | **Implemented** in [`RuntimeKernel`](../packages/agent-runtime-core/src/kernel.ts), [`composeAgentRuntime`](../packages/agent-runtime-composer/src/composer.ts), and the Codex MCP server [`server.ts`](../packages/agent-runtime-codex/src/server.ts) |
| TypeScript execution | Source files/artifacts, esbuild compilation, worker, broker, limits, cancellation, provenance | Model calls `runtime_exec`; module uses `context.runtime.search/invoke` over the internal broker | Exactly the same. The host may call the kernel binding directly instead of serializing through MCP | **Implemented**; no new harness feature is required. See [`agent-runtime-typescript`](../packages/agent-runtime-typescript/README.md) and [`inlineProvider.ts`](../packages/agent-runtime-host/src/inlineProvider.ts) |
| Orchestration authored in TypeScript | Program topology and `Promise.all`/dependency logic | Module invokes the installed `runtime.delegation.*` capabilities | Same module invokes the same capabilities | **Implemented**. This is Marshal behavior, not harness behavior |
| Actual agent creation | Portable identity, parent relationship, scope, host handle and current state | An adapter must reach a public agent API. Codex currently uses a persistent `codex app-server` child and creates real Codex threads | Inject a `DelegationAdapterPort` backed by internal native task APIs; the current Codex factory can also accept an injected `SubagentBackend` | Portable plane **implemented**; Codex process fallback **implemented**; native in-process Codex backend **unavailable because no plugin API is exposed**. See [`DelegationAdapterPort`](../packages/agent-runtime-delegation/src/types.ts), [`CodexDelegationAdapter`](../packages/agent-runtime-codex-capabilities/src/subagents/delegationAdapter.ts), and [`CodexAppServerBackend`](../packages/agent-runtime-codex-capabilities/src/subagents/codexAppServerBackend.ts) |
| Recursive agents | Portable identity and parent relationship | The adapter creates and later controls a native host session | Native backend retains the host handle associated with each runtime delegation ID | Portable support **implemented** through the generic delegation port |
| Domain model inference | Domain prompts, validation, and memory effects | Supplied by an explicitly installed extension | Extension-owned model transport and policy | **Not part of generic Runtime**; extensions own this contract |
| App-triggered model work | App manifest, action/tool authority, schemas and receipts | MCP App calls a declared action/tool; that backend may invoke Brain, delegation, or another installed model capability | Same action bridge can call an internal model capability | **Implemented composition path**. MCP Apps do **not** provide a universal direct inference API merely because they can render UI |
| Explicit memory remember/recall | Brain and canonical memory system | Main model discovers and invokes `memory.brain.remember/recall` | Same operation can be invoked by the main model or by host orchestration | **Implemented** |
| Transcript capture and review | Bounded ordered capture, epochs, compaction segments, one sealed review, and abandoned recovery | Hooks append to the adapter-owned spool and enqueue review after sealing | Harness calls lifecycle bindings directly with authoritative events and immutable transcript evidence | **Implemented** for start, user/tool/assistant capture, Codex compaction translation, parent/child references, end review, and abandoned recovery |
| Automatic pre-model recall | Brain recall operation and returned evidence | Current Codex hooks intentionally do not run semantic recall; the main model calls recall when needed | Host may call `memory.brain.recall` through the existing kernel binding before its main model call and inject the returned evidence | Operation **implemented**; native pre-model policy is **not implemented in Codex**. No new runtime bridge is required, but a host integration and policy/evals are required |
| Lifecycle | Idempotent lifecycle processing and journals | Plugin hooks translate public Codex events; compact `SessionStart` opens a spool segment | Harness calls the existing lifecycle port directly with authoritative event IDs | **Implemented** for session start, user message, tool result, assistant turn, compaction translation, child references, and session end. A first-class cross-harness compaction event remains an optional contract improvement |
| Custom UI source/backend | React/TSX, compilation, render records, scoped state, declared actions/tools and module/capability backends | MCP Apps resource plus stable startup render tool | Same portable resource can be mounted through the native resource bridge; host-specific authoring profile remains adapter-owned | **Implemented** in [`agent-runtime-ui`](../packages/agent-runtime-ui) and Codex composition [`runtime.ts`](../packages/agent-runtime-codex/src/runtime.ts) |
| UI placement | Declared modes and complete inline fallback | MCP Apps host decides whether it supports and grants a mode | Host adapter maps requests to its own native surfaces | `inline`, `fullscreen`, and `pip` contracts **implemented**, but actual placement is **host-dependent**. Cards/carousels/grids are React layouts, not host modes. Side panels, separate windows and other surfaces are currently optional host extensions, not portable modes. See [`ui-application-contract.md`](ui-application-contract.md) |
| UI action bridge | Immutable manifest, action/tool dispatch, permissions, scope, cancellation, idempotency and receipts | App sends standard MCP Apps tool calls to stable Marshal dispatch tools | Host may route the identical dispatcher call directly | **Implemented** in [`applicationTypes.ts`](../packages/agent-runtime-ui/src/applicationTypes.ts), [`actionDispatcher.ts`](../packages/agent-runtime-ui/src/actionDispatcher.ts), and the Codex action composition in [`runtime.ts`](../packages/agent-runtime-codex/src/runtime.ts) |
| UI host extensions | Feature detection and typed unsupported fallback | Feature-detected OpenAI helpers when the host supplies `window.openai` | Adapter can implement namespaced native extensions or typed effects | **Implemented extension mechanism**; each feature is host-dependent. Codex profile evidence is [`authoringProfile.ts`](../packages/agent-runtime-codex-capabilities/src/ui/authoringProfile.ts) |
| Identity and scopes | Enforcement and storage partitioning | Adapter derives the best stable identity available; Codex falls back to installation-local single-user when no signed-in profile ID is exposed | Harness supplies authoritative installation/profile/user/task/thread/agent IDs | **Implemented** through [`RuntimeHarnessIdentity` and `InvocationContext`](../packages/agent-runtime-core/src/contracts.ts), composer authority, and [`identity.ts`](../packages/agent-runtime-codex/src/identity.ts). Signed multi-user Codex identity remains unavailable through stdio launch |
| Artifacts | Principal + workspace/project/session scoped storage | Available through runtime capabilities | Same | **Implemented** in [`agent-runtime-provider-artifacts`](../packages/agent-runtime-provider-artifacts/src/artifacts.ts) |
| Attachments | Conversion, containment, size limits, derived artifacts and injected modality services | Host/plugin passes an allowed path or base64 content | Host may map native attachment handles to bytes/path and inject OCR/audio/video/image services | Converter **implemented** in [`agent-runtime-provider-attachments`](../packages/agent-runtime-provider-attachments/src/attachments.ts). A portable durable attachment-handle/upload lifecycle is **missing**; current contract is path/base64 conversion |
| Permissions and approvals | Default-deny capability requirements and verification boundary | MCP returns denied or approval-required; current host can inject approval callbacks if exposed | Adapter connects native approval UI and atomic verifier through existing ports | **Implemented ports** in [`agent-runtime-permissions`](../packages/agent-runtime-permissions/src/permissions.ts) and `AgentRuntimeHostOptions.permissionApproval`; concrete UX is host-dependent |
| Native effects | Typed effect intent, idempotency, approval validation, replay receipt | Unsupported unless adapter supplies `RuntimeEffectHandler` | Adapter fulfills selected kinds using internal navigation, notification, browser, scheduling or other APIs | **Implemented port** in [`effects.ts`](../packages/agent-runtime-core/src/effects.ts) and `AgentRuntimeHostOptions.effectHandler` |
| Secrets | Marshal prevents ambient credentials in brokered code; authority remains scoped | Must use separately installed provider/effect or trusted configuration | Harness could resolve opaque secret handles only at the final effect boundary | A general opaque `SecretPort`/secret capability is **missing**. Secrets must not be added to module input or environment as a substitute |
| Cancellation | Abort signal through kernel, TypeScript, UI actions, effects, jobs and delegation | MCP cancellation and app cancellation are translated when the host sends them | Native cancellation token maps directly to the same signals | **Implemented**, subject to provider/native backend cooperation |
| Streaming/progress | Final structured result and receipts | MCP server returns final calls; UI has lifecycle/context events and Codex app-server observes agent events internally | Host could surface progress, but there is no universal portable capability-progress contract to map | General progress/streaming is **missing**. Cancellation is not the same as streaming |
| Durability/replay | Ordered event persistence where history is needed, current records otherwise | Delegation stores current executable host state; other event history remains host-owned | The host may persist ordinary events or current handles without adding a second recovery ledger | **Implemented** for the delegation runtime surface |
| Natural discovery/routing | Versioned manifest, descriptors, examples and prompt projections | Plugin contributes skill, MCP server and hooks; new tasks load them at startup | Harness projects the same manifest into its native tool registry/system context and can select relevant hints at prompt time | **Implemented** in [`agent-runtime-manifest`](../packages/agent-runtime-manifest/src/manifest.ts) and Codex plugin generation [`plugin.ts`](../packages/agent-runtime-codex/src/plugin.ts). Current Codex does not hot-register arbitrary new tools mid-task, so Marshal uses stable startup dispatch tools |
| Installation | Portable packages and conformance contracts | Configure stdio MCP manually, or install the generated Codex plugin | Link the composer/host in the product and register bindings at startup | **Implemented** for local stdio/Codex plugin; HTTP/public multi-tenant deployment remains separate work |

## Exact TypeScript-to-agent boundary

The TypeScript module does not need a harness-side `runtime.agents` object. It
uses its existing broker:

```text
runtime_exec(module)
  -> Marshal TypeScript worker
  -> context.runtime.invoke("runtime.delegation.spawn", ...)
  -> portable RuntimeKernel
  -> portable DelegationManager
       - runtime identity and parent relationship
       - invocation scope
       - current host handle and status
       - plain result/error and code change references
  -> DelegationAdapterPort
  -> native host agent API
```

Only the final arrow is host-owned.

Without Codex source control, that final arrow is currently implemented by
[`CodexAppServerBackend`](../packages/agent-runtime-codex-capabilities/src/subagents/codexAppServerBackend.ts):
it starts one Codex app-server process, calls `thread/start`, `turn/start`,
`turn/steer`, `thread/read`, and related methods, and returns real Codex thread
IDs. This is not the agent-authored workflow moving into the CLI. It is a
compatibility transport for native task creation.

With harness source control, implement the same
[`DelegationAdapterPort`](../packages/agent-runtime-delegation/src/types.ts)
against internal task APIs. Nothing above that arrow changes. In the current
Codex factory, an owner can already replace the default process implementation
by passing a [`SubagentBackend`](../packages/agent-runtime-codex-capabilities/src/subagents/types.ts)
to `createCodexCapabilityProviders`.

If a generic MCP host exposes no agent API and no delegation adapter is
installed, TypeScript still runs and composes every other capability, but
`runtime.delegation.*` must be absent or truthfully unsupported. MCP by itself
does not create agents.

## Exact Brain model boundary

```text
memory.brain.recall / remember
  -> portable RuntimeMemoryBrain
       - prompt and tool selection contract
       - scope, hierarchy, ranking and write policy
       - validation, limits and receipts
  -> IMemoryReasoner.reason(...)
  -> model transport supplied by adapter/host
```

Domain model-reasoner contracts are extension-owned and are not exported by
generic Runtime. The current Codex plugin cannot obtain an in-process callable
version of the current task's model session. Therefore
[`createCodexMemoryReasoner`](../packages/agent-runtime-codex/src/memoryReasoner.ts)
uses a direct OpenAI provider request only when explicitly credentialed, and
otherwise lazily creates one persistent saved-auth Codex app-server reasoner.
The historical `codex exec` implementation is experimental and is not the
automatic production path.

An MCP App's ability to render UI, send a chat message, update model context or
call a tool is not a generic API for arbitrary background inference. The app
must call a declared backend tool/action. That backend can call Brain,
delegation, or a separately installed model capability.

## Exact UI boundary

```text
agent authors TSX + backend TypeScript
  -> Marshal compiles and records an immutable application/render
  -> stable runtime_render_component tool returns render ID + fallback
  -> MCP Apps resource bridge
  -> host chooses actual placement

user clicks application control
  -> marshal.callAction / marshal.callTool
  -> stable app dispatcher
  -> schema + scope + permission + approval + cancellation checks
  -> Marshal capability or editable TypeScript module
  -> result + receipt
  -> application state update
```

Marshal owns everything except the two host-facing edges: mounting the resource
and satisfying optional host APIs. The portable modes currently are exactly
`inline`, `fullscreen`, and `pip`. A host announces available modes at the MCP
Apps initialization boundary and may grant, deny or fall back. The complete
application remains usable inline.

Cards, carousels, maps, editors, dashboards and split panes require no new host
API; they are layouts inside React. A native side panel, modal, detached window
or other product surface is currently a feature-detected namespaced extension
or typed native effect. If those should become cross-harness guaranteed modes,
Marshal would need to version them into the portable display-mode contract and
extend conformance tests. That is optional new work, not a prerequisite for
full custom applications.

## Minimal integration levels

### Level 1: generic MCP only

Required:

1. Register `runtime_search` and `runtime_exec` at startup.
2. Supply a stable principal plus workspace/project/session identity as far as
   the host can truthfully know it.
3. Forward cancellation.
4. Preserve structured results, permissions, approvals and receipts.

This already provides direct capabilities, memory operations, editable
TypeScript, artifacts and composition. It provides native agents only when a
delegation adapter is additionally installed. It provides rendered UI only
when the client implements MCP Apps; otherwise Marshal returns the complete
structured/text fallback. See [`generic-mcp-quickstart.md`](generic-mcp-quickstart.md).

### Level 2: public plugin APIs but no source control (current Codex)

Add:

- Generated skill and manifest routing projections.
- Public lifecycle hooks.
- Stable MCP Apps resources and render tools.
- Saved-auth app-server fallbacks for Luna and native Codex threads.
- Codex authoring profile and feature-detected OpenAI UI extensions.

These are already implemented in [`agent-runtime-codex`](../packages/agent-runtime-codex)
and [`agent-runtime-codex-capabilities`](../packages/agent-runtime-codex-capabilities).

### Level 3: harness source control

Do not redesign Marshal. Replace only adapter-edge fallbacks:

1. Register the existing kernel/resource bindings directly, optionally keeping
   MCP as an external projection.
2. Supply authoritative identities from the signed-in product session.
3. Deliver native lifecycle events directly instead of running hook processes.
4. Inject an `IMemoryReasoner` backed by the host's internal model service.
5. Implement `DelegationAdapterPort` against the host's native task system.
6. Mount Marshal MCP Apps resources in every host surface the product supports
   and report available display modes/context truthfully.
7. Connect existing permission/effect approval callbacks to native UX and
   atomic approval verification.
8. Forward native cancellation and, after a portable progress contract exists,
   native progress.

This is adapter work. TypeScript execution, orchestration, memory, UI source and
backend actions remain unchanged.

## Genuine additional work

The following items are not solved merely by controlling a harness:

1. **Universal accepted-operation recovery.** `runtime_exec` needs an optional
   durable claim/result journal so a process crash after acceptance can be
   classified and safely replayed. Current execution receipts alone do not do
   this. Effects, UI actions, lifecycle, delegation, jobs and memory each have
   narrower recovery mechanisms already.
2. **Portable progress streaming.** Add a bounded progress-event/subscription
   contract with lineage, cancellation and backpressure. Do not confuse
   app-server internal events or MCP partial input with general capability
   streaming.
3. **Opaque secret broker.** Add scoped secret references and final-boundary
   resolution/redaction. Brokered TypeScript must receive handles, not secret
   values.
4. **Native compaction lifecycle event.** Codex compact starts are already
   translated into spool segments. A universal adapter contract could carry the
   same bounded segment metadata directly for other harnesses without copying
   private transcript bodies into lifecycle journals.
5. **Durable attachment handles.** The converter is complete for path/base64
   inputs, but a cross-host upload/attachment object with retention and scoped
   reopening is not yet a portable service.
6. **Quillstone ACL-aware federation APIs.** Runtime can reauthorize final bytes,
   but current native top-N generation occurs before that filter and one
   in-process route supplies a synthetic generation vector. Quillstone must add
   scope-filtered candidate generation, authorized bounded multi-route
   search/context/impact, route-qualified links, and real route-to-generation
   vectors. Runtime post-filtering is not an ACL substitute. The synchronized
   bridge is pinned to Quillstone `188bf57`, so API work also requires upstream
   source synchronization and provenance updates.
7. **Additional standardized UI placements, only if desired.** Inline,
   fullscreen and PiP exist. Standardizing side panels or detached windows
   requires versioned modes and cross-host conformance; otherwise keep them as
   optional extensions/effects.

## Final boundary statement

Controlling the harness should make Marshal faster, more automatic and more
native. It should not make Marshal less portable.

- **Marshal decides and executes the program.**
- **The adapter translates identities, events and native effects.**
- **The harness supplies only facilities that cannot exist outside the
  product: its authenticated model service, native agent/task system, UI
  placement, approvals, secrets and product lifecycle.**
- **MCP remains the universal fallback projection of the same runtime.**
