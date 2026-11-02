# Harness adapter contract

## Required

Every adapter provides:

1. A stable workspace/project/session identity mapping.
2. `runtime_search` and `runtime_exec` with the shared JSON contracts.
3. Default-deny permission decisions and surfaced approval requirements.
4. Structured results that retain receipts, provenance, diagnostics, and artifacts.
5. Cancellation and bounded execution.

Discovery is two-phase to keep model context bounded. A broad search defaults
to `detail: "summary"` and omits descriptor schemas and annotations. An exact
`name` lookup always returns `detail: "full"` and complete input/output schemas.
Adapters must preserve an explicit broad `detail: "full"` request for existing
clients that need all schemas at once.

Adapters and provider projections must publish a strict `outputSchema` for each
capability's semantic output. The portable kernel validates `result.output`
before it crosses the adapter boundary and fails closed on mismatch; adapters
must preserve that failure and must not substitute unvalidated structured data.
Receipts, provenance, diagnostics, and artifact references are envelope fields,
not part of the semantic output schema.

Identity projection is explicit. The adapter supplies a stable `harnessId` and,
when available, installation, profile, user, and native-agent identifiers. The
portable invocation context carries those separately from the principal and
workspace/project/session scope, so a new task or a different workspace does
not accidentally create a new memory owner. Adapters must not derive profile or
user identity from a transient thread ID.

Every execution receipt carries an explicit lineage tuple
`{rootExecutionId,parentExecutionId?,depth}`. Brokers, application actions, and
delegation adapters preserve the root and increment depth when they invoke a
child. Hosts persist receipts through the portable receipt-sink boundary and
must treat repeated `receiptId` delivery idempotently. This makes complete
capability and agent trees reconstructable after restart without parsing
provider-specific prose.

An adapter may add bounded audit correlations through the core's opaque trusted
carrier. Receipts persist only typed `mcpRequestId`, `codexToolUseId`, and
`callerRequestId` records with explicit transport or untrusted-correlation
authority; long strings are represented by full domain-separated digests.
Invocation `metadata` is not a receipt input and must never be persisted
wholesale.

Lifecycle coordination provides one active lease owner and durable replay of a
completed or failed event. It does not make an arbitrary callback exactly-once:
an owner can die after an external side effect commits but before the completion
record is durable. Adapters must pass the stable lifecycle `eventId` into every
side-effecting delegate as an idempotency key or transaction boundary. Stale
takeover is therefore an explicitly at-least-once recovery path.

## Optional

- Lifecycle callbacks that durably enqueue bounded observe/reflect evidence; semantic Brain recall remains a direct agent/runtime operation.
- MCP Apps resource presentation.
- Native-effect fulfillment for product-owned subagents, navigation, approvals, and notifications.
- Background job event delivery.
- Native scheduling through the fixed `runtime.schedule.create/get/list/update/pause/resume/cancel`
  effect kinds. Unsupported operations return an explicit envelope. Adapters
  resolve every ID against the exact principal and full invocation scope, use
  their own clock as authoritative, and return current state for get/list.
  A host with no clock of its own composes `RuntimeScheduleService` from
  `@marshal/agent-runtime-effects` instead and supplies a wake port.

## UI behavior

UI operations always return meaningful structured fallback content. MCP Apps-compatible clients may render an associated `text/html;profile=mcp-app` resource. Other clients must remain fully functional without rendering it. A `ui://` identifier is an MCP resource, never a browser URL.

Adapters that support compiled custom UI must expose a stable display entry
point during initial tool registration. Creating a render and displaying it are
separate operations: the first display immediately consumes the returned render
ID, while subsequent display calls reuse that ID without recompilation or a new
render binding. Dynamic per-render tools may be offered as an optimization but
cannot be the only path because harnesses are not required to hot-register tools
inside an active task. Declarative and agent-authored React renderers retain
separate CSP/trust boundaries.

Compiled payloads and mutable component state must not depend on a host exposing
private result metadata to the model. A renderer may consume private `_meta`
when present, but must provide an app-only capability path for payload hydration.
State persistence must remain scoped and bounded; secure child isolation cannot
be weakened with same-origin privilege merely to make browser storage survive a
remount. History restoration must also work when a harness replays only the
cached public tool result: the result therefore carries a stable render ID, and
the renderer must be able to hydrate from that ID without the original input
notification. Reusable compiled UI belongs to durable project scope rather than
the lifetime of one adapter process.

Session identity is task/thread-scoped rather than turn-scoped. A normal
assistant response does not terminate the session; follow-ups must retain access
to session-scoped artifacts and project-scoped reusable render IDs until the
harness emits its genuine session-end callback.

Adapters that advertise cross-task memory must use a stable owner-scoped memory
store rather than a database rooted only in each newly created workspace folder.
Prompt hooks durably enqueue bounded observation evidence but do not run a model
or implement semantic recall/store policy. The main agent calls the specialized
Brain for recall or remember; the Brain owns memory hierarchy, ranking, dedupe,
placement, correction, and provenance. Lifecycle journals store only opaque
result references/digests; private replay bodies belong in an explicit absolute
harness-private root outside the workspace.

## Conformance

An adapter must pass shared tests for protocol negotiation, exact capability lookup, execution, denial, approval, cancellation, lifecycle idempotency, scope isolation, reserved core-tool precedence, unsupported native effects, and receipt completeness.
