# Publication limitations and threat model

This document narrows public claims to behavior supported by source, receipts,
and reproducible evidence. It complements the runtime security model; it does
not replace a host-specific security review.

## Current limitations

- Brokered TypeScript is cooperative defense in depth. It is not a security
  boundary for actively malicious code. Run untrusted code in an OS, container,
  or VM sandbox with separate credentials and filesystem boundaries.
- Trusted Node and authored UI compilation are high-risk capabilities. Package,
  builtin, filesystem, and UI import allowlists are host-owned and cannot be
  expanded from a module or browser action.
- Fullscreen, picture-in-picture, recursive delegation, cancellation, steering,
  cost reporting, file pickers, and other host extensions are optional. The
  application must feature-detect them and preserve a complete fallback.
- A successful display call proves payload delivery, not visual correctness.
  Pixel-level claims require an inspected live render from the named host.
- Generated fixtures prove schemas and deterministic paths only. They do not
  prove autonomous routing, model quality, native-agent execution, timing,
  token use, cost, or rendered pixels.
- In-memory reference stores are suitable for tests, not restart claims.
  Restart evidence must use the durable host store and retain the same owner and
  scope identity.
- Memory retrieval can surface stale, contradictory, or sensitive historical
  data. Consumers must treat injected memories as data rather than instructions
  and expose correction, supersession, deletion, expiry, and audit operations.
- The default knowledge service reads no local index: without a Brain extension its knowledge tools answer "Brain not configured". There is no silent
  remote fallback or remote-cluster support claim.
- Receipt presence does not prove semantic correctness. It proves the recorded
  operation, authority decision, scope, lineage, provenance, and outcome that
  the host actually returned.
- Lifecycle stale-owner recovery is at-least-once. A callback may have committed
  an external side effect before its process dies and before Marshal records
  completion; side-effecting delegates must use the stable event ID as their own
  idempotency key or transaction boundary.
- Durable state and authored-source roots require a local filesystem that
  reports a non-zero numeric inode consistently through Node.js. Unknown
  identities fail closed. Network, virtual, and special filesystems are not
  supported without host-specific conformance evidence.
- Descriptor and repeated canonical-path checks detect observed file
  replacement and snapshot drift, not every adversarial parent-directory race.
  Node.js lacks portable handle-relative path traversal for these operations,
  and Windows exposes no `O_NOFOLLOW`; a hostile actor that can rename parent
  components may attempt a swap-and-restore between checks. Protect state roots
  and their parents with OS permissions or place hostile code in a separate OS
  sandbox/account.

## Threats and required mitigations

| Threat | Boundary | Required mitigation | Publication evidence |
| --- | --- | --- | --- |
| Prompt or memory injection | Model context | Label memory as historical data, preserve provenance, ignore instructions embedded in recalled content | Redacted context plus memory receipt |
| Scope confusion or cross-user leakage | Memory, artifacts, UI state, receipts | Stable harness identity, principal-bound scope keys, negative isolation tests | Paired owner/scope isolation trace |
| Module escape or import escalation | TypeScript executor | Default brokered mode, explicit import allowlists, output/timeout/call bounds, external isolation for hostile code | Escape-suite results plus environment receipt |
| Browser gains arbitrary module/path authority | MCP App action bridge | Stable declared action IDs, server-side path resolution, schemas, permissions, idempotency, receipts | Application manifest and action receipt |
| Duplicate delivery or stale takeover repeats effects | Lifecycle, UI actions, delegation | Stable event and idempotency keys, durable completed/failed replay records, changed-input rejection, delegate-side transaction or idempotency binding | First, replay, and killed-owner recovery receipts |
| Delegation exceeds budget or authority | Native agents | Inherited depth/agent/concurrency/time/token/cost/retry/workspace/effect bounds | Complete receipt tree and typed limitation cases |
| Cancellation leaves orphan work | Delegation/jobs | Propagate abort through tree, persist handles, collect partial outcomes | Cancellation trace and post-run handle audit |
| UI fallback omits critical content | Non-Apps host | Require summary plus structured details covering data, actions, scopes, and recovery | Fallback fixture and non-Apps host output |
| Evidence cherry-picking | Evaluation/publication | Freeze prompt/fixture hashes, publish every attempt, predeclare metrics, pair arms, blind grading where needed | Raw run index and failure taxonomy |
| Media implies an event that did not happen | Demo production | Link edits to uncut recordings, source, fixture, trace, permissions, and receipts; label fixture overlays | Capture metadata and hashes |
| Secrets enter traces or media | Evaluation/publication | Use recorded non-secret fixtures, redact through declared rules, preserve hashes of raw secured artifacts | Redaction manifest and reviewer sign-off |

## Claim discipline

Public prose should use “the contract supports” for portable API behavior,
“the reference adapter implements” for reviewed adapter source, and “the run
demonstrated” only when linked uncut evidence exists. Benchmarks must name the
host, model, reasoning setting, version, machine, sample size, warm/cold state,
permission profile, and failure handling. Do not publish acceptance targets as
measured results until raw evidence satisfies them.
