# Quillstone Memory Brain live Codex validation

Status: executable acceptance playbook for the live Codex app. This is not a unit-test plan. Every pass requires the installed plugin, the real runtime, the real Brain reasoner, real Markdown and SQLite state, and real Quillstone indexes.

## 1. Operator, clock, and safety contract

This playbook is written for a tester in India.

- Set Windows time zone to `(UTC+05:30) Chennai, Kolkata, Mumbai, New Delhi`.
- Record every boundary twice: `2026-08-25T09:30:00+05:30` and `2026-08-25T04:00:00Z`.
- Use Windows PowerShell 7, UTF-8, English prompts, and the paths in this document.
- Use only synthetic repositories and synthetic memories below. Never point the run at a production profile.
- Start a **new Codex chat** wherever this document says `NEW SESSION`. Restart the Codex app wherever it says `APP RESTART`. Text from an earlier chat must not be pasted into a recall query.
- A screenshot is evidence only when the Codex window title/session identity, relevant expanded `runtime_exec` or admin result, and Windows clock are visible.
- Do not infer success from the natural-language answer. Expand the live `runtime_exec` result and the admin/storage evidence.
- Redact principal tokens and credentials. Do not redact memory IDs, opaque scope handles, policy versions, revisions, generations, routes, digests, job IDs, or synthetic content.
- Never delete `Q:\.q` recursively. Every destructive step below names a case-specific path previously printed by admin status.

Failure at any step is retained as evidence; do not repair it before copying the trace and taking the failure screenshot.

## 2. Immutable plugin installations

The Runtime implementation identity for this playbook is:

```text
cbddba3
```

Create two immutable plugin destinations. Do not use `--force`, do not install another build over either directory, and do not run both treatments at once.

```powershell
New-Item -ItemType Directory -Force Q:\.q\live-validation | Out-Null
agent-runtime-codex-install-plugin `
  --destination Q:\.q\codex-plugins\memory-brain-live-cbddba3-embeddings `
  --plugin-version live-20260825-cbddba3-embeddings `
  --knowledge-data-root Q:\.q `
  --embeddings `
  --trusted-local

agent-runtime-codex-install-plugin `
  --destination Q:\.q\codex-plugins\memory-brain-live-cbddba3-lexical `
  --plugin-version live-20260825-cbddba3-no-embeddings `
  --knowledge-data-root Q:\.q `
  --no-embeddings `
  --trusted-local
```

Save each installer JSON response as:

```text
Q:\.q\live-validation\install-embeddings.json
Q:\.q\live-validation\install-no-embeddings.json
```

The embeddings install is the default treatment. The no-embeddings install is the explicit lexical control. A pass requires:

1. the installed plugin paths to be the two immutable destinations above;
2. both installer results to show the same pinned runtime entrypoints and `Q:\.q` knowledge root;
3. embeddings status in the first treatment to identify `Snowflake/snowflake-arctic-embed-xs`, 384 dimensions, CPU ONNX, mean pooling, and L2 normalization;
4. embeddings status in the control to be explicitly disabled, not silently unavailable.

**Screenshot S00:** both installer JSON results and the two destination directories.  
**Screenshot S01:** embeddings admin status showing provider/model/dimensions.  
**Screenshot S02:** no-embeddings admin status showing explicit disable.

If the default install uses another provider, vectors are zero, or the control reports provider failure rather than configuration disable, stop that treatment and record a failure.

## 3. Fixed directories and retained evidence

Use this exact evidence root:

```text
Q:\.q\live-validation\2026-08-25-india\
```

Each flow uses:

```text
<case>\
  run.md
  prompts.txt
  runtime-exec.jsonl
  admin-before.json
  admin-after.json
  files-before.txt
  files-after.txt
  markdown\
  sqlite\
  quillstone\
  transcripts\
  screenshots\
```

`run.md` must record operator, IST and UTC times, Codex app version, plugin destination and version, runtime/Brain/Quillstone identities, workspace path, repository commit, workspace ID, stable project ID, Codex session ID, session epoch, parent session ID when present, supplied scope handles, and pass/fail for every numbered assertion.

The runtime may version its physical layout beneath `Q:\.q`. Do not guess it. At the beginning of every flow, use the app's Memory Brain admin/status surface through the normal plugin and copy these **reported absolute paths** to `admin-before.json`:

- knowledge root and VFS root;
- durable scope root and Markdown manifest;
- SQLite working-set database;
- transcript spool root;
- quarantine root;
- tombstone ledger;
- Quillstone route directories and readable generations;
- review/healer ledgers.

Those reported paths are the exact source paths to inspect. Copy their relevant bytes into the fixed case evidence paths above. If an absolute source path escapes `Q:\.q`, the Q VFS requirement fails.

## 4. How to exercise and read the live app

Use the Codex app normally. Prompts below intentionally instruct the agent to use the installed Marshal capability; do not invoke implementation modules, database libraries, or test fixtures directly.

For each prompt:

1. Expand the `runtime_exec` card.
2. Save the complete request, enclosing receipt, Brain tool trace, and result to `runtime-exec.jsonl`.
3. Open the plugin's admin/status operation in a separate Codex turn and save its JSON.
4. For writes, wait until publication status is terminal (`published`, `degraded with durable pending work`, or an explicit failure), never an arbitrary sleep.
5. Take the required screenshot.

Logical operation names may be wrapped by a versioned namespace, but the trace must expose equivalent operations. Required observations are:

```text
memory.brain.remember / recall / promote / correct / forget
search_memory
search_knowledge
get_memory
store_memory
correct_memory
analyze_knowledge_impact
finish_brain_run
scope.create / scope.grant / scope.resolve
transcript.append / segment.seal / epoch.seal
session.review
markdown.write / markdown.import / markdown.quarantine / tombstone.write
sqlite.materialize
quillstone.search / context / impact / upsert / remove / generation.publish
healer.run
```

Admin evidence must expose enough fields to prove: canonical memory ID; semantic fact key; scope ID/kind/policy version; rights; state; active/head and blessed flags; revision; predecessor and successor direction; document path/digest; SQLite import revision/digest; cache source; index routes/generations/vector generation; transcript epoch/segment/sealed digest; review/healer identity and idempotency outcome.

An index hit is never sufficient. Every selected memory must be followed by authorized `get_memory`, and the final answer must use the bytes returned by that load.

## 5. Synthetic repositories

Create three local Git repositories:

```text
Q:\memory-brain-live\settlement-main
Q:\memory-brain-live\settlement-worktree
Q:\memory-brain-live\settlement-secondary
Q:\memory-brain-live\foreign-payroll
```

`settlement-main` contains:

```ts
// src/settlement/SettlementCoordinator.ts
export class SettlementCoordinator {
  settle(correlationId: string): string {
    return `settled:${correlationId}`;
  }
}
```

```ts
// src/invoice/InvoiceRetryWorker.ts
import { SettlementCoordinator } from '../settlement/SettlementCoordinator.js';

export class InvoiceRetryWorker {
  constructor(private readonly settlement = new SettlementCoordinator()) {}
  retry(correlationId: string): string {
    return this.settlement.settle(correlationId);
  }
}
```

```ts
// src/auth/retryPolicy.ts
export const AUTHENTICATION_RETRY_LIMIT = 3;
export const canRetry = (attempt: number): boolean =>
  attempt < AUTHENTICATION_RETRY_LIMIT;
```

Commit as `fixture-v1`, create `settlement-worktree` with `git worktree add`, and clone the same repository into `settlement-secondary`. Both worktrees and the clone must resolve to one stable logical project ID but distinct workspace IDs.

`foreign-payroll` contains:

```ts
export const FOREIGN_PRIVATE_MARKER = 'NEVER_EXPOSE_PAYROLL_RAVEN_7319';
```

Commit it separately. It must have a different project ID and no grants in settlement sessions.

## 6. F01 - Q VFS, live preflight, and stable identity

Open the embeddings plugin in `settlement-main`.

Exact prompt:

> Use the installed Marshal Memory Brain through runtime_exec. Show live knowledge, VFS, scope, and index status. Then search code for `retry settlement correlation`, open context for `SettlementCoordinator`, and report the workspace ID, stable project ID, route, readable generation, vector generation, and every physical data path.

`APP RESTART`, reopen the same workspace, and repeat. Then open `settlement-worktree` and `settlement-secondary` in separate `NEW SESSION`s and repeat.

Expected:

- all physical data paths are under `Q:\.q`;
- main, worktree, and secondary have three different workspace IDs;
- all three have the same stable project ID;
- the real code symbol and call from `InvoiceRetryWorker.retry` are present;
- restart preserves readable generations;
- no mock/provider fixture marker appears.

**runtime_exec observation:** `search_knowledge` returns route-qualified code nodes and context; no memory write.  
**Admin observation:** route-to-generation vector, vector provider contract, VFS mount, workspace/project identities.  
**Failure meaning:** path-derived project IDs, state outside Q VFS, missing real code graph, or unreadable restart generation.

**Screenshot S03:** main identity/status and Q paths.  
**Screenshot S04:** worktree and clone identities beside the main identity.  
**Screenshot S05:** live code context and generation after restart.

## 7. F02 - Markdown authority and empty-SQLite reconstruction

In `settlement-main`, exact prompt:

> Use Memory Brain to remember this project fact exactly: Invoice reconciliation retries must preserve the original settlement correlation ID so a retry cannot create a second settlement. This applies to `SettlementCoordinator` and `InvoiceRetryWorker.retry`. Return the canonical memory ID, semantic fact key, retrieval synopsis, scope handle, Markdown path, revision, document digest, SQLite import revision, Quillstone route, and generation.

Required Markdown semantic text:

```text
Invoice reconciliation retries must preserve the original settlement correlation ID so a retry cannot create a second settlement.
```

Required retrieval synopsis:

```text
Retry-safe invoice reconciliation; settlement idempotency; preserve original correlation ID; prevent duplicate settlement; SettlementCoordinator; InvoiceRetryWorker.
```

Required fact key:

```text
v1:invoice-reconciliation.original-settlement-correlation-id
```

Save the Markdown bytes and hash. Close Codex cleanly. From the reported admin path, move **only this test profile's SQLite database** to:

```text
Q:\.q\live-validation\2026-08-25-india\F02\sqlite\working-set.before-empty-import.sqlite
```

Do not move Markdown, manifests, tombstones, or Quillstone. Start Codex and open a `NEW SESSION`.

Exact query:

> Use Memory Brain before answering: What must invoice reconciliation preserve so retries cannot duplicate settlement?

Expected answer: the original settlement correlation ID.

**runtime_exec observation:** write is file-first (`markdown.write` before `sqlite.materialize` and `quillstone.upsert`); recall selects the same ID after authorized `get_memory`.  
**Admin observation:** startup imports Markdown before reconciliation, recreates one SQLite row with matching revision/digest, reports no deletion, and retains or deterministically repairs one Quillstone node.  
**Failure meaning:** Markdown deleted because SQLite was empty, duplicate ID/file, answer sourced only from stale index bytes, import before authorization absent, or byte/hash change.

**Screenshot S06:** created Markdown body/frontmatter/retrieval/fact and admin identity.  
**Screenshot S07:** empty SQLite path plus startup import order and materialized row.  
**Screenshot S08:** fresh-session answer and canonical load.

## 8. F03 - lexical control, default vectors, and later enablement

Activate the `--no-embeddings` plugin with the same `Q:\.q` root. In a `NEW SESSION`, exact prompt:

> Use Memory Brain to remember across my projects exactly: Choose React over Angular by default unless the task explicitly requires Angular. Return its memory ID, fact key, retrieval synopsis, private durable Markdown path, and index status.

Required body, synopsis, and key:

```text
Choose React over Angular by default unless the task explicitly requires Angular.
```

```text
Frontend framework preference; UI stack selection; component framework default; choose React; avoid Angular unless explicitly required.
```

```text
v1:preference.frontend-framework
```

Record Markdown bytes, modified time, and SHA-256. In three separate `NEW SESSION`s ask exactly:

1. `Use Memory Brain: What is my default UI technology choice?`
2. `Use Memory Brain: Which frontend stack should you reach for when requirements are silent?`
3. `Use Memory Brain: Do I have a standing preference between the two common component frameworks?`

The lexical control passes when at least two queries select the memory through filesystem/SQLite FTS/BM25 and admin reports vectors disabled by configuration.

Close Codex. Activate the immutable `--embeddings` plugin without editing or re-remembering the memory. Wait for the eligible private memory route to publish a vector generation. Repeat all three queries in fresh sessions. For one repetition request:

> Use semantic-only Memory Brain retrieval with lexical/BM25 candidate generation disabled for this query: Which ecosystem should guide an unspecified web interface implementation?

Expected vector contract: Snowflake Arctic XS, 384 dimensions, one vector for the bounded retrieval synopsis, not the body/frontmatter. Semantic-only must select the memory; hybrid must select it for all three prior queries.

**runtime_exec observation:** control uses lexical candidates; enabled run identifies semantic/hybrid mode; semantic-only says lexical disabled rather than merely assigning it low weight; every hit is reauthorized and loaded.  
**Admin observation:** vector row references the retrieval section, provider contract matches, and vector generation appears without a Markdown mutation or Brain rewrite.  
**Failure meaning:** vectors in the control, another default model, semantic-only secretly uses BM25, whole-document embedding, unauthorized bytes used from an index, or changed Markdown hash/mtime.

**Screenshot S09:** exact Markdown synopsis/fact plus lexical-disabled vector status.  
**Screenshot S10:** a successful lexical-control recall.  
**Screenshot S11:** Snowflake 384-dimensional vector status and synopsis-only source span.  
**Screenshot S12:** semantic-only result with lexical disabled.  
**Screenshot S13:** identical pre/post Markdown SHA-256 and modified time.

## 9. F04 - bidirectional code-memory blast radius

Use the F02 memory.

Exact code-to-memory query:

> Use Memory Brain knowledge impact in both directions for `src/invoice/InvoiceRetryWorker.ts#InvoiceRetryWorker.retry`. Which accepted memories may this code affect? Do not mutate memory.

Exact memory-to-code query:

> Use Memory Brain knowledge impact in both directions for the invoice correlation memory ID recorded in F02. Which code symbols, files, callers, and memories require review if this decision changes? Do not modify code or memory.

Expected explanation path includes the F02 memory, `InvoiceRetryWorker.retry`, `SettlementCoordinator.settle`, and their call/link relationship. The foreign marker and React memory must be absent.

**runtime_exec observation:** `analyze_knowledge_impact`, direction `both`, bounded depth, explicit/inferred edge provenance, and zero mutation tools.  
**Admin observation:** generation unchanged by read-only impact.  
**Failure meaning:** one-way only, irrelevant memory, silent mutation, fabricated authority from adjacency, or no readable explanation path.

**Screenshot S14:** code-to-memory path.  
**Screenshot S15:** memory-to-code path and unchanged generation.

## 10. F05 - dynamic scopes, grants, parent-child denial, and multi-scope

In a root session, exact prompt:

> Through runtime_exec, create one ephemeral run scope named `invoice-acceptance-20260825` with child inheritance, capacity 20, and session retention. Grant this root read/write/admin and verified descendants read/write. Return the opaque scope ID, policy version, rights, expiry, and receipt. Store in that run scope exactly: The acceptance run is testing retry-safe invoice settlement.

Launch two real child agents from the app. Child A stores in the supplied run handle:

> The duplicate-settlement reproducer requires two deliveries with one correlation ID.

Child B stores in the supplied run handle:

> The expected audit marker is SETTLEMENT_REPLAY_BLOCKED.

Child B also stores in its private session:

> PRIVATE_CHILD_B_NONCE is B-ONLY-8421.

Ask Child A exactly:

> Search the shared run scope, project scope, and your private session in one bounded Memory Brain request. What must this acceptance run reproduce and which marker proves success?

Expected: two deliveries sharing one correlation ID and `SETTLEMENT_REPLAY_BLOCKED`; parent memory may explain purpose. Child B's private nonce is absent.

In an unrelated root session, pass the opaque run scope handle manually and ask:

> Search this supplied scope for its acceptance marker.

Expected: fail closed with missing grant, without revealing candidate count, marker, or scope membership. Then ask Child A using only an invented scope handle; expect unknown-scope denial.

**runtime_exec observation:** one permissioned `scope.create`, bounded grants, verified inherited lineage, and one globally BM25-ranked query over authorized scopes, with no model-invented grant.
**Admin observation:** each memory has exactly one scope, parent/children rights are explicit, unrelated subject has none, and expiration removes ephemeral rows without tombstoning durable memory.  
**Failure meaning:** child self-grant, parent visibility into child-private session, existence leak, hardcoded scope branch, scope starvation, or unexpired ephemeral state.

**Screenshot S16:** created opaque scope and grants.  
**Screenshot S17:** Child A multi-scope answer and candidate provenance.  
**Screenshot S18:** unrelated parent denial with no leakage.  
**Screenshot S19:** expiration and removed ephemeral working set.

## 11. F06 - short-term caches and promotion to workspace/project

In a `NEW SESSION`, store exact session memory:

> The settlement replay fixture uses correlation ID INDIA-LIVE-20260825-001.

In a separate agent-private cache, store:

> For this checkout, use audit fixture name replay-amber.

Confirm neither creates durable Markdown. Promote the first to project and the second to workspace with exact requests:

> Promote the session observation to project scope because all worktrees must reuse this synthetic correlation ID. Preserve provenance and do not mutate the source scope.

> Promote the agent cache observation to workspace scope because only this checkout uses replay-amber. Preserve provenance and do not mutate the source scope.

Expected: two target memories and two durable Markdown files; source observations remain attributable and become promoted/consolidated only as policy permits. The project value recalls in the other worktree; the workspace value does not.

**runtime_exec observation:** target search before creation, `promote`, source and target IDs, target scope handles, provenance, no in-place scope change.  
**Admin observation:** source cache authority, target Markdown paths, project/workspace distinction, cache hydration.  
**Failure meaning:** Markdown for unpromoted short-term cache, in-place scope mutation, lost source provenance, workspace leakage, or duplicate target.

**Screenshot S20:** session/agent cache with no Markdown.  
**Screenshot S21:** project and workspace promotion lineage.  
**Screenshot S22:** cross-worktree project hit and workspace miss.

## 12. F07 - scope correction, CAS, and complete supersession

Store project M3 exactly:

> Authentication retries stop after three attempts.

Record ID, active/head/blessed, revision, Markdown generation, SQLite import generation, and each Quillstone route generation.

In another session store only as session observation:

> Identity service policy now allows five authentication attempts because two extra transient failures are tolerated.

Start two parallel agents at the same captured M3 revision. Agent A promotes/corrects:

> Correct the project fact to: Authentication retries stop after five attempts because the identity service tolerates two additional transient failures.

Agent B attempts at the stale revision:

> Correct the same project fact to: Authentication retries stop after four attempts.

Expected: Agent A creates M4 as the sole active, head, blessed replacement. Agent B receives CAS/revision conflict, reloads, and must abstain or propose review; it must not create another active head.

Query:

> Use normal Memory Brain recall: How many authentication attempts are now allowed before retries stop?

Expected: five only.

Historical query:

> Show the complete supersession lineage, states, blessed flags, revisions, and Markdown/SQLite/route generations for the current authentication retry fact.

Expected:

- M4 `supersedes -> M3`;
- M3 `supersededBy -> M4`;
- M3 state `superseded`, inactive, not head, not blessed;
- M4 state `active`, active/head/blessed;
- monotonic revisions and publication generations;
- normal recall excludes M3 while audit traversal retains it.

**runtime_exec observation:** semantic fact-key match, `correct_memory`, CAS precondition/conflict/reload, and selected M4.  
**Admin observation:** exactly one active head and both edge directions/state flags across Markdown, SQLite, and Quillstone.  
**Failure meaning:** competing heads, ambiguous edge direction, stale writer wins, state disagreement, old answer in normal recall, or blessed flag disagreement.

**Screenshot S23:** initial M3 full status.  
**Screenshot S24:** CAS conflict and reload.  
**Screenshot S25:** both-direction lineage and all state/blessed/revision/generation fields.  
**Screenshot S26:** fresh normal recall returning five only.

## 13. F08 - transcript epochs, compaction, one review, and integrity

Start a fresh session and record its epoch. Do not say “remember.”

Exact statement before compaction:

> For this repository, deployment manifests must keep readiness probes separate from liveness probes because rollout health and process death have different recovery semantics.

Ask the agent to inspect `src/settlement/SettlementCoordinator.ts`, then force a real Codex compaction using the app's supported compaction action. After compaction say:

> Correction: that probe rule applies to the whole project lineage, not only this checkout.

End normally.

Expected:

- bounded append-only events have stable IDs and monotonic sequence;
- segment 1 seals and segment 2 opens in the same epoch;
- no per-turn semantic `memory.brain.observe` model job;
- end seals one digest and queues one review identity keyed by owner/session/epoch/digest/reviewer;
- exactly one semantic review runs;
- deterministic checks cover duplicate, missing, reordered, truncated, late, boundary, and child-completion conditions;
- review detects scope correction and writes/reuses one project memory;
- integrity report says whether the rule was forgotten or contradicted after compaction.

Replay the same session-end event through the supported recovery/admin action. It must return the existing review identity with no second Brain run or memory.

Open another worktree and ask:

> Use Memory Brain: What distinction must deployment probes preserve, and why?

Expected: readiness is rollout health; liveness is process-death recovery.

**Screenshot S27:** epoch and continuous event sequence around segment seal.  
**Screenshot S28:** absence of per-turn semantic jobs and one sealed review identity.  
**Screenshot S29:** integrity report and project scope correction.  
**Screenshot S30:** idempotent replay and cross-worktree recall.

## 14. F09 - abandoned epoch recovery

Start a new session and state:

> Settlement audit events must include the original correlation ID and final settlement outcome.

After the assistant replies, terminate the Codex app process normally through Windows app controls without ending the chat. At the next app start or after the configured stale threshold, open admin recovery.

Expected: stale epoch seals as abandoned; one review has `incomplete-transcript` evidence; reviewer does not claim full integrity; any accepted memory keeps abandoned-session provenance. If the adapter can replay a delayed end with new transcript bytes, do so once: a superseding review is allowed only when its sealed digest contains new evidence.

**runtime_exec observation:** recovered review is the same review mechanism, not a second policy.  
**Admin observation:** abandoned state, incomplete flag, digest, review ID, and optional old/new review lineage.  
**Failure meaning:** epoch ignored, false complete-integrity claim, repeated reviews on wake, or memory without incomplete provenance.

**Screenshot S31:** open epoch before termination.  
**Screenshot S32:** abandoned seal and incomplete review.  
**Screenshot S33:** delayed-end dedupe or justified superseding digest.

## 15. F10 - parallel agents and single fact head

Launch four real agents nearly simultaneously in the settlement project:

- A: `Remember for this project: Customer imports use deterministic batches of exactly 500 records.`
- B: `Remember for this project: Bulk tenant ingestion is partitioned into stable groups of 500.`
- C: `Remember for this project: Token renewal ownership belongs to TokenRefreshCoordinator.`
- D: `Use Memory Brain: What rules govern bulk onboarding and login recovery?`

After completion, run one review/consolidation.

Expected: A/B converge on one current semantic fact/head or a bounded review-required result, C stays distinct, D loads only committed authorized bytes, atomic files are complete, upserts are idempotent, and review CAS cannot overwrite a newer write.

**runtime_exec observation:** distinct agent contexts, search-before-write, equivalence/CAS result, D's canonical loads.  
**Admin observation:** one current 500-record head, one token head, one node per canonical ID, no temporary files left.  
**Failure meaning:** duplicate equivalent heads, partial Markdown, stale review overwrite, or D presenting uncommitted content as truth.

**Screenshot S34:** four concurrent agent/session identities and receipts.  
**Screenshot S35:** converged fact heads and complete files.  
**Screenshot S36:** D's canonical load timing/provenance.

## 16. F11 - federation across workspaces and indexes

In `settlement-main`, link project memory:

> SettlementCoordinator owns settlement creation and must enforce correlation-ID idempotency.

In `settlement-secondary`, link project memory:

> InvoiceRetryWorker must replay the original correlation ID and emit SETTLEMENT_REPLAY_BLOCKED when a duplicate is prevented.

Ensure both project routes are indexed. Ensure `foreign-payroll` is indexed only under its unrelated project/profile.

From `settlement-main`, exact query:

> Search all authorized workspaces and indexes for this project: what code and accepted memories govern retry-safe settlement? Return every selected route and the route-to-generation vector.

Expected: bounded concurrent queries to main and secondary routes; RRF merge; canonical memory dedupe; final reauthorization; both symbols and both accepted memories. The foreign route must not be queried, and `NEVER_EXPOSE_PAYROLL_RAVEN_7319` must not appear even in candidate counts or timing diagnostics.

Repeat in `settlement-worktree`; expected project memories are identical despite different workspace ID/path.

**runtime_exec observation:** authorized route resolution, per-shard top-K, RRF, canonical dedupe, route-qualified links, and final byte authorization.  
**Admin observation:** generation vector contains only authorized project routes.  
**Failure meaning:** one global generation, foreign route access, post-filter-only ACL, starvation, duplicate canonical memory, or path-bound project identity.

**Screenshot S37:** two-route federation and generation vector.  
**Screenshot S38:** merged explanation paths and canonical loads.  
**Screenshot S39:** worktree equivalence and explicit absence of foreign route.

## 17. F12 - deterministic daily healer idempotency

Use a dedicated durable test scope. Through approved admin fault-injection/staging operations, prepare:

1. one valid Markdown memory absent from SQLite;
2. one SQLite row behind its document revision;
3. one tombstoned memory still in Quillstone;
4. one broken code selector;
5. two near-duplicate active memories without a common fact key;
6. one expired ephemeral run scope.

Set the persisted due watermark to India date `2026-08-25` using the supported admin operation, then `APP RESTART`.

Expected deterministic order without a model: import missing Markdown; refresh stale cache; remove tombstoned node; report broken selector; expire run scope; reconcile generations. Only the ambiguous near-duplicate cluster may invoke Brain.

Restart again on the same owner/date with unchanged bytes.

Expected: same durable job identity/watermark, `already-completed`/no-op outcome, no second model run, no new index generation.

**runtime_exec observation:** deterministic phase precedes any semantic phase and semantic input contains only duplicate cluster.  
**Admin observation:** owner/date idempotency key, before/after generations, repaired artifacts, durable backlog for unresolved ambiguity.  
**Failure meaning:** model used for deterministic repairs, Markdown rewritten for ranking, partial scan treated as deletion, second daily run, or needless generation.

**Screenshot S40:** six prepared conditions.  
**Screenshot S41:** ordered deterministic repairs and single semantic cluster.  
**Screenshot S42:** same-day second wake no-op and unchanged generations.

## 18. F13 - deferred editable-Markdown mode (not part of this release)

This flow is intentionally deferred by the design section **Deferred editable-Markdown mode**. Generated Markdown is durable, inspectable, and indexable authority, but arbitrary human-edited files are not accepted as authorized mutations in the current release. Do not claim the staging, commit, or quarantine behavior below as implemented validation evidence.

Retain this flow as the acceptance script for the future editable-Markdown feature:

Copy the current five-attempt retry Markdown to the admin-reported approved staging root. Change only its body and retrieval section to:

```text
Authentication retries stop after six attempts during the India resilience exercise only.
```

```text
India resilience exercise; authentication retry limit; six attempts; temporary qualified exception.
```

Keep its semantic fact key and provide the current revision precondition. Invoke the supported import/commit operation.

Expected: scope right, path confinement, schema, ID/fact identity, link, and revision checks; accepted content becomes a new revision/replacement rather than an untracked overwrite.

Then submit three files:

- the same edit with the now-stale revision;
- a file that claims a foreign scope/grant in frontmatter;
- malformed frontmatter with a path traversal link.

Expected: all three are rejected and moved to the reported quarantine root with reason records; none becomes visible or indexed. Place an otherwise valid file outside the approved root and run discovery; it must remain non-authoritative.

**runtime_exec observation:** import is explicit/authorized, not a direct model write; stale CAS and validation failures are visible.  
**Admin observation:** accepted lineage plus quarantine paths/reasons; no grant derived from editable Markdown.  
**Failure meaning:** silent overwrite, self-grant, outside-root authority, invalid indexing, or discarded rejected bytes.

**Screenshot S43:** approved staged edit and validation inputs.  
**Screenshot S44:** accepted revision/supersession.  
**Screenshot S45:** three quarantine records and outside-root non-import.

## 19. F14 - forgetting, tombstones, restart, and ghost prevention

Create exactly:

> The cafeteria reconciliation dashboard uses synthetic label FORGET-ME-MANGO-5512.

Verify one recall, then exact prompt:

> Use the authorized Memory Brain forget operation to forget the project memory containing FORGET-ME-MANGO-5512. Return its tombstone ID/path, deleted lifecycle state, affected routes, and generations.

Expected file-first explicit tombstone/deleted state, removal from active SQLite heads and Quillstone readable generation, and retained minimum audit identity according to policy. `APP RESTART`; ask:

> Use Memory Brain: What synthetic label does the cafeteria reconciliation dashboard use?

Also semantic-search `MANGO dashboard label` and exact-search the marker/ID. Normal recall and all active indexes must abstain. Empty/partial filesystem scans must not create tombstones for unrelated memories.

**runtime_exec observation:** authorized `forget`, tombstone write, index remove, and later abstention.  
**Admin observation:** tombstone ledger and deleted state survive restart; no active bytes/node.  
**Failure meaning:** file absence used as deletion, ghost result, active body injection, lost tombstone on restart, or unrelated deletion.

**Screenshot S46:** pre-forget active memory.  
**Screenshot S47:** tombstone and remove generation.  
**Screenshot S48:** post-restart abstention and no active exact/semantic hit.

## 20. Final proof matrix

Every row is mandatory. Put the screenshot filename, not merely its label, in the final `run.md`.

| Design requirement | Live flow | Required retained evidence | Required screenshot |
| --- | --- | --- | --- |
| Real live Codex/runtime/Quillstone | F01 | identities, code context, restart generation | S03, S05 |
| Q VFS confinement | F01 | admin-reported absolute paths under `Q:\.q` | S03 |
| Stable project identity across worktrees/clones | F01, F11 | distinct workspace IDs, same project ID | S04, S39 |
| Markdown is durable authority | F02 | exact file bytes/hash and file-first trace | S06 |
| Empty SQLite imports Markdown before cleanup | F02 | moved DB, import order, matching materialization | S07, S08 |
| Brain-authored retrieval synopsis | F02, F03 | exact synopsis section and selected candidate | S06, S09 |
| Stable semantic fact key | F02, F03, F07 | exact keys and correction lookup | S06, S09, S25 |
| Explicit `--no-embeddings` lexical control | install, F03 | installer/config and BM25/FTS candidate trace | S02, S10 |
| Default Snowflake Arctic XS vectors | install, F03 | model, 384 dimensions, CPU/pooling contract | S01, S11 |
| Lexical disable in semantic-only treatment | F03 | query mode showing BM25/lexical off | S12 |
| Synopsis-only vectorization | F03 | vector source span/row | S11 |
| Enable embeddings without Markdown rewrite | F03 | identical hash/mtime before and after | S13 |
| Code-to-memory impact | F04 | explanation path and no mutation | S14 |
| Memory-to-code impact | F04 | reverse path and unchanged generation | S15 |
| Dynamic scope creation and grants | F05 | opaque ID, policy, receipt, bounded rights | S16 |
| Verified parent-child inheritance | F05 | child grants/lineage | S16, S17 |
| Parent/unrelated-session denial | F05 | fail-closed result with no leakage | S18 |
| Multi-scope retrieval and candidate floors | F05 | one bounded query with per-scope provenance | S17 |
| Ephemeral scope expiration | F05 | expired rows removed | S19 |
| Session cache promotion to project | F06 | source/target/provenance and other-worktree recall | S20-S22 |
| Agent cache promotion to workspace | F06 | source/target and cross-worktree miss | S20-S22 |
| Scope correction is not in-place mutation | F06, F07 | separate source/target IDs and provenance | S21, S25 |
| CAS under parallel correction | F07 | stale precondition conflict/reload | S24 |
| Supersession direction both ways | F07 | `supersedes` and `supersededBy` | S25 |
| State/head/blessed consistency | F07 | Markdown/SQLite/index status | S25 |
| Revision and generation monotonicity | F07 | document/import/route generations | S23, S25 |
| Normal recall excludes superseded facts | F07 | fresh answer `five` only | S26 |
| Transcript epochs and ordered capture | F08 | event IDs/sequences/epoch | S27 |
| Compaction segments | F08 | sealed/open boundaries and continuity | S27 |
| One post-session review | F08 | one review identity/model run | S28 |
| No ambient per-turn semantic observation | F08 | hook trace/model-call absence | S28 |
| Integrity report across compaction | F08 | deterministic findings and report | S29 |
| Idempotent session-end review | F08 | reused review ID | S30 |
| Abandoned-session recovery | F09 | abandoned seal/incomplete flag/provenance | S32, S33 |
| Parallel agents and equivalent-fact convergence | F10 | concurrent receipts, one head | S34-S36 |
| Multiple-workspace/index federation | F11 | authorized routes, RRF, generation vector | S37, S38 |
| Foreign shard isolation | F11 | router evidence excluding foreign route | S39 |
| Deterministic daily healer first | F12 | ordered repairs before Brain | S41 |
| Daily healer idempotency | F12 | same owner/date no-op | S42 |
| Deferred: approved manual Markdown import | F13 | future explicit authorization and new revision | Not required in this release |
| Deferred: quarantine invalid/stale/unauthorized edits | F13 | future retained files and reason records | Not required in this release |
| Deferred: editable Markdown cannot self-grant | F13 | existing rule plus future foreign-scope rejection | Not required in this release |
| Explicit forgetting and tombstones | F14 | tombstone, remove generation, restart state | S47 |
| Ghost prevention after restart | F14 | recall/search abstention | S48 |

## 21. Final acceptance rule

The run passes only if every non-deferred matrix row has live evidence and its required screenshot, every selected memory was canonically reauthorized, all durable bytes remain readable Markdown, SQLite and Quillstone are demonstrably rebuildable derived state, and no foreign or child-private content leaked. F13 remains a future acceptance flow until the separately designed editable-Markdown commit boundary exists. A correct natural-language answer with missing trace/storage proof is a failure. A trace that proves mechanics while the user-visible answer is wrong is also a failure.

Archive the complete evidence directory read-only and record its SHA-256 manifest in:

```text
Q:\.q\live-validation\2026-08-25-india\SHA256SUMS.txt
```
