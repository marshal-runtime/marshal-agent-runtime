# Candidate M post-restart acceptance

This directory freezes the three live gates that must run only after Candidate
M is installed and Codex has restarted. It is a focused acceptance harness, not
a replacement for the matched `v1` evaluation corpus or a release claim.

The machine-readable source of truth is
[`acceptance-plan.json`](acceptance-plan.json). Its Claude Design build,
refinement, and restore prompts are byte-identical to the frozen
[`v1` capstone](../v1/cases/ui.json). The build hash remains
`c9b0e64795a9f63668ec51b816dcebafe79cea2ca6b4c95b8a68a13cb41ed80a`.

Validate the plan before the restart without launching any live task:

```powershell
node scripts/evals/candidate-m-acceptance.mjs
```

After the restart, create fresh projectless tasks outside the development
repository. Record the immutable plugin version, source/cache tree hashes,
restart time and PID, model, reasoning level, permissions, thread IDs, rollout,
runtime receipts, source hashes, and screenshots. Then validate the assembled
JSON evidence:

```powershell
node scripts/evals/candidate-m-acceptance.mjs --evidence C:\evidence\candidate-m.json --json
```

The command exits non-zero if any required assertion fails. Its checks are
deterministic and inspect only supplied evidence; it never runs a model or
manufactures a receipt.

## Gate 1: ordinary implicit memory

Run the plan's `memory.seed` and `memory.recall` prompts in unrelated fresh
workspaces. The seed task must naturally call `memory.brain.remember`; a hook
observation or deterministic parser is not a substitute. The recall task must
call `memory.brain.recall`, select the attributable stored memory, and answer
with `amber kestrel` and keyboard accessibility first.

The `memory` evidence object records:

- exact prompt hashes and distinct workspace paths;
- semantic operation names and whether the main model made the call;
- accepted/finalized remember receipt, stored memory ID, owner scope, and
  cold/warm Brain timing classification;
- recall receipt, selected memory ID, answer, and timing;
- a read-only authoritative-store audit proving one current owner-scoped row
  and no higher-ranked stale contradiction.

One observation may fail or pass the per-call 6-second cold and 2.5-second warm
targets. It cannot establish p95.

## Gate 2: stable dynamic workflow replay

Run `workflow.initial`, then send `workflow.replay` in the same task. Preserve
the editable module byte-for-byte for the replay.

Evidence must include one stable `workflowId`, two distinct runtime execution
IDs, the unchanged module digest, three role-specific idempotency keys and
delegation IDs, initial and replay spawn receipts, exact requested and durable
limits, child task inventories before and after replay, terminal receipt trees,
and explicit zero-orphan arrays.

The accepted nested limit keys are fixed in the plan. Aliases such as
`maxAgents` and `timeoutMs` fail. A separate negative probe must show
`maxAgents` rejected with zero native spawn delta. Replay passes only when all
three spawn receipts say `replayed`, all original delegation IDs are retained,
and the native replay spawn count is zero.

Record `runtime.delegation.capabilities`. If token or cost usage is not
advertised, use `"unsupported"` and leave the corresponding measured value
`null`. A requested or forwarded limit is not measured enforcement.

## Gate 3: frozen design capstone and real host controls

Run the exact `ui.build` prompt in a fresh task, then `ui.refine` in the same
task. After saving through the live app, restart the host and use the exact
`ui.restore` prompt.

Capture separate editable orchestration, backend, frontend-shell, and generated
implementation sources; one initial compile/render/display; render and
component IDs; the application manifest; and renderer version `1.1.0`. The
same-task refinement must invoke a declared module-backed action, retain the
same render and component IDs, and change the authoritative implementation
content and digest while leaving the orchestration, backend, and frontend shell
unchanged. It must not compile or create a new render binding.

The refinement receipt records its declared action ID, action request and
receipt IDs, `marshal_invoke_react_action`, the retained render ID, the
authoritative implementation path, exact before/after content digests, and at
least one nested durable-write receipt. The evidence embeds both source
snapshots so the validator recomputes their digests and proves the content
actually changed.

At exact host outer-container widths of 320 and 1024 CSS pixels, screenshot the
outer renderer chrome with visible named controls for Save workspace, Reopen
workspace, Fullscreen, and Picture in picture. Record surface
`outer-renderer-chrome`, capture kind `outer-control-chrome`, measurement
`host-outer-container-css-px`, and `viewportWidthCssPx`. An app-authored mobile
or desktop preview, authored icon buttons, or source inspection does not
satisfy this check.

For action proof:

1. Select a distinctive direction, edit visible content, and enable mobile.
2. Activate the outer **Save workspace** control.
3. Change the live state.
4. Activate the outer **Reopen workspace** control.
5. Capture the exact restored state digest and pixels.

Each accepted action needs an activation kind of `human-pointer` or
`automated-dom`, surface `outer-renderer-chrome`, method
`marshal/ui/chrome-action-request`, tool `marshal_invoke_react_action`, a
request ID, a distinct success receipt, render ID, state digest, dispatch
overhead, and screenshot reference. Label automated DOM activation as
automated. A direct action tool call or `artifacts.write/read` may be retained
in `directBypassCalls`, but it must have `usedAsClickEvidence: false`.

Activate Fullscreen and Picture in picture through the outer controls. If a
mode was advertised, acceptance requires a granted response and matching
actual mode. If it was not advertised, the control is intentionally disabled:
record `not-activatable`, no request ID, the visible status text, and the typed
unsupported, denied, or fallback outcome. That proves the fallback contract,
not a host click or host support for the mode.

Finally capture a cached redisplay of the exact same render and component IDs
with zero writes, source writes, compiles, or render bindings, plus post-restart
restored pixels. Single observations are checked against the 1-second cold
compile, 10-second cached
display, and 500-millisecond action-dispatch targets, but remain smoke evidence
rather than percentile claims.

These gates implement only the immediate post-restart slice of the broader
[`Marshal 1.0 goal`](../../marshal-1.0-goal.md). Full matched repetitions,
baseline comparison, cross-host evidence, media, and independent review remain
separate completion requirements.
