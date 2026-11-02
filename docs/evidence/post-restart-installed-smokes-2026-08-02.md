# Post-restart installed-candidate smokes — 2026-08-02

## Classification and claim boundary

`local-live-smoke`, partial. These observations came from named Codex tasks
across two post-restart deployments. Historical deployment `20260802d` and
personal plugin `0.1.0+codex.20260802172156` were built from runtime
`f3646e5`, GitNexus memory `182037b`, and Codex composition `fb2ee4d`. Active
deployment `20260802e` and personal plugin
`0.1.0+codex.20260802180535` retain the same graph and composition revisions
and replace the runtime with committed retry-state fix `c96fadf`.

This evidence proves several named installed-host paths. It is not a matched
evaluation, a release latency result, a complete isolation corpus, inspected
desktop UI evidence, or a Marshal 1.0 completion claim. Candidate `e` passed
the detached-candidate and installed-plugin MCP smokes, but those checks and
the named live trials below do not expand the claim to the full definition of
done.

## Semantic Memory Brain

The trials kept the generated four-word values out of the storage task's final
response and compared them only after the separate recall task completed. The
checked evidence records contain the values, but this public note records only
identifiers and exact-match outcomes.

### Alpha

- A fresh Codex application task durably stored the labeled value through live
  Luna on the first worker attempt.
- Durable job `7683f167-0ed9-4ab3-84cb-6c23ce2519ab` completed in 13.824
  seconds and stored memory `3a87e603-f907-438d-a220-e99a625318ad`.
- A separate cross-workspace semantic recall selected that memory and returned
  the exact four-word value. Recall receipt
  `memory-brain-8934...` completed in 8.168 seconds.

### Gamma

- A context-empty storage call completed on the first worker attempt through
  job `8450c876-328b-46de-b8f3-0d81198a4a56` in 12.592 seconds and stored
  memory `60391fe3-d4e0-4b34-8464-a52fb82c97fd`.
- An independent semantic recall selected that memory and returned the exact
  value. Recall receipt `memory-brain-1f281...` completed in 9.400 seconds.

### Beta retry race and correction

Beta exposed a caller-state defect in installed candidate `d`. The first
retryable worker attempt was reported to the caller before the durable job was
terminal. The worker later succeeded on attempt two with one generated value,
while the main task had already interpreted the early result as failure and
retried with a newly generated value. The Brain found the prior exact-label
memory and used `correct_memory` to supersede it. An independent recall then
selected corrected memory `a7e723f9-3efd-4ae0-932a-ade665bce437` and returned
the corrected exact value in 10.010 seconds.

Runtime commit `c96fadf` changes retryable failed state from a caller-terminal
condition into a wait-for-next-attempt condition. Its regression suite covers
retry success, terminal exhaustion, cancellation, and immediate terminal
states, and the complete `corepack pnpm verify` gate passed. Candidate `e`
installed those bytes and exercised the repaired path live as recorded next.

The observed 8.168–13.824 second Brain durations exceed the goal's provisional
2.5-second warm target. These trials establish semantic behavior and durable
job handling for the named cases, not release-grade latency or statistical
quality.

### Candidate e retry-state validation

After the next desktop restart, one inline brokered TypeScript execution,
`54631077-32d4-41d1-863b-2778003ade8f` (outer receipt
`receipt-msc4afdi-r-kjpgdijn`), started three independent
`memory.brain.remember` calls concurrently. It succeeded in about 20.5 seconds
with peak concurrency three, and all three child Brain receipts completed:

| Durable job | Worker attempt | Brain receipt | Authoritative outcome |
| --- | ---: | --- | --- |
| `aa803d38-e7e5-48eb-8e28-302db61ba56c` | 1 | `memory-brain-498ae1b590f0592a43ff3ad3e4d6b590` | stored `0f05ce5d-0bdb-43f8-b220-395dfd6d5864` |
| `42b8701a-1136-418a-a123-6077511e427b` | 2 | `memory-brain-5bde4450bd63fcb67d6b150062eeb98f` | selected existing `b8ebeaa6-73a7-420e-8e04-16f777c1e810` |
| `547be758-fb48-437b-8e04-f2d38b2d23c0` | 2 | `memory-brain-2d10f6d5d5122dfb68329ac437e74947` | selected existing `12e12edf-48e5-4c44-8641-6f0676689637` |

There was exactly one durable job for each label. The two retrying jobs reached
attempt two while their original callers kept waiting; the agent did not issue
a duplicate Brain call or create a second job for either label. This is direct
installed-host evidence that `c96fadf` closes the specific early-terminal race
seen in candidate `d` for this named concurrent trial.

A separate semantic recall selected SQLite-authoritative memory
`b8ebeaa6-73a7-420e-8e04-16f777c1e810` and returned its exact hidden phrase in
8.631 seconds. Its Brain receipt was
`memory-brain-ee694a1b0dd9b14a8686400b9b3a58b9`, runtime receipt was
`receipt-msc4b4df-w-s59d7z2b`, and provider invocation was
`8ec8fec5-fed9-4136-951b-ed7ea4b8beb4`. The phrase remains omitted here; the
claim is exact-match recall from authoritative SQLite, not disclosure of the
test value.

The roughly 20.5-second concurrent module and 8.631-second recall are named
local-live observations, not a warm-p95 or release-latency result. They do not
replace the frozen correction, isolation, restart, concurrency, and latency
corpus.

## Editable TypeScript and negative routing

A separate installed-candidate task selected Marshal for an indirect reusable
record-normalization request, authored an editable workspace TypeScript file,
executed it, changed the source in place, and reran it with changed source and
module digests plus changed behavior. A simple `17% of 80` control task answered
directly without invoking Marshal. These are individual routing smokes, not a
randomized stock-versus-Marshal comparison.

## Artifact reopen rejection

The capability-composition storage task wrote one scoped artifact in its first
workspace. The purported reopen ran in a different projectless workspace whose
artifact store contained zero files, and `artifacts.read` did not reopen the
artifact. Exact details later stated by the task therefore cannot be used as
artifact-recovery evidence; delegated source context is a plausible alternative
source. This attempt is rejected, not counted as a reopen pass.

## Bounded delegation caveat

The editable Node 20-to-24 analysis module launched four specialist agents in
parallel and then one adversarial reviewer. Its primary execution completed all
five agents in about 138.6 seconds with peak concurrency four and no active
delegations left at rest.

A later diagnostic execution assumed the module's idempotency keys would dedupe
globally. Idempotency is execution-scoped, so the second execution launched a
second complete four-specialist wave and a second reviewer. The durable store
contains ten distinct delegation records, all `succeeded`. The generated report
incorrectly described the second reviewer as terminated and excluded those
outputs. The valid claim is one useful bounded five-agent topology plus one
duplicated full five-agent diagnostic wave; this is not global replay
idempotency, cancellation, recursive delegation, or the frozen 28-agent
capacity proof.

## Remaining gates

- Expand the candidate-`e` retry-state smoke into the frozen semantic-memory
  correction, isolation, restart, concurrency, and latency corpus with
  retained receipts.
- Reopen an artifact from the same authorized durable scope without inherited
  source-task context.
- Execute the frozen 28-agent completion/cancellation fixture and retain the
  native inventory and no-orphan audit.
- Capture real Codex UI actions, modes, fallback, historical reopen, and host
  restart; no desktop UI claim is made here.
- Run the canonical genuinely fresh implicit capstone and matched evaluation.
