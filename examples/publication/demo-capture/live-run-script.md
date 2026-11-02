# Uncut live capture script

These are operator scripts, not recorded evidence. Start capture before opening
the fresh task and stop only after the final receipt is saved. Do not pause,
splice, accelerate, or replace failures. Publish every attempt and link the
short edit to its uncut source recording.

Prepare the external bundle first with `prepare-evidence.mjs`. Before the run,
replace the generated metadata template with `metadata.json` containing the
exact host, model, reasoning, runtime/adapter/plugin versions, permission
profile, timestamps, prompt hashes, and stable attempt ID. After the run,
record every redaction and its rule in `redaction-manifest.json`; redaction must
not change event order or manufacture trace continuity.

On Windows, run `capture-host.mjs probe` before opening the fresh task. If its
desktop-capture check passes, start `capture-host.mjs record` with an absolute
external `screen.webm` and `--source desktop`. Keep the foreground recorder
running until every product action and receipt export is complete. This driver
captures pixels only; the operator must perform clicks, display-mode requests,
historical reopen, and the documented product restart. Copy each required
on-screen range and its trace/receipt references into `host-gates.json`.

## Automatic memory

1. Fresh task: `Remember that my publication accent color is ultramarine.`
2. Capture the response and automatic write receipt without manually invoking a memory tool.
3. Open a fresh unrelated task: `What publication accent color did I choose earlier?`
4. Capture the naturally selected semantic Brain recall, its receipt, and the
   owner/scope metadata. The lifecycle hook may enqueue ambient evidence, but
   it must not synchronously run the Brain or inject a compatibility-path
   recall.
5. Preserve both lifecycle receipts and the full traces; do not merge the two tasks into a reconstructed trace.

## Ordinary TypeScript

1. Fresh task: `Summarize the attached order fixture by region, make the calculation reusable, and show the exact result.`
2. Capture autonomous routing, editable non-UI TypeScript, execution receipt, digest, and result.
3. Edit one fixture amount, rerun the same module, and capture the changed result without adding UI.
4. Run the simple negative-routing control in its own fresh attempt and preserve it even if Marshal activates unexpectedly.

## Capability composition

1. Fresh task: `Create a reusable project brief from the attached project notes. Include any relevant preference you already know, preserve the result, and report where it was saved.`
2. Capture the editable module, project/attachment input, relevant memory lookup, durable artifact write, and complete parent-child receipts.
3. Reopen the saved artifact from a fresh task and verify its scope and provenance.

## Delegation

1. Fresh task: `Review this release candidate from architecture, security, and operator perspectives in parallel, then synthesize one recommendation and preserve the review.`
2. Capture the editable orchestration source, returned delegation IDs, host
   session handles, and plain terminal results.
3. Preserve the synthesized review and the uncut trace. Cancel a child only when
   the user or orchestration explicitly requests cancellation.

## UI actions and modes

1. Fresh task: `Turn these project decisions into an interactive review panel I can use here.`
2. Capture compilation, render binding, the single inline display call, and complete fallback.
3. Invoke one declared capability action and one editable-module action.
4. Request fullscreen and PiP. Record granted, denied, unsupported, or fallback status exactly as returned.
5. Open the non-Apps fallback and verify it contains the result, action summary, scope, and recovery guidance.

## Restart recovery

1. Open the persistent panel and select the evidence view.
2. Record the render ID and source digest.
3. Before restarting the desktop host, save the expected project-scoped storage
   object as `expected-storage.json` and run the deterministic runtime probe:

   `node scripts/verify-ui-history-recovery.mjs <workspace> <renderId> --expect-storage expected-storage.json --require-mode fullscreen --output recovery-probe-before-host-restart.json`

   This reconstructs the adapter twice, verifies immutable public/payload
   bindings and scoped state, and proves that the probe did not rewrite the UI
   state tree. It does **not** prove desktop pixels or a desktop restart.
4. Restart the host using the documented product operation.
5. Reopen the historical message and capture the same render ID and restored view.
6. Run the same deterministic probe again as
   `recovery-probe-after-host-restart.json`.
7. Verify the desktop trace contains no new source write, compile, or render
   binding during reopen. Review the recording for actual restored pixels; the
   probe deliberately lists those claims as unverified.

## Design studio capstone

Use this fresh-session prompt verbatim:

> Build me a complete interactive design workspace I can use here. I want to turn a product brief into several genuinely different interface directions, compare them side by side, select one, refine it conversationally and directly on the canvas, apply the supplied design system, inspect responsive states, and keep an editable implementation I can reopen and continue later. Handle the complex work efficiently and show me the finished usable workspace, not a static mockup or a plan.

The prompt deliberately does not name Marshal, TypeScript, agents, or MCP Apps.
Capture automatic routing, the pre-authorized permission profile, useful agent
assignments, synthesis, editable sources, live interaction, one targeted
backend refinement, receipt lineage, restart, and restoration. If delegation,
PiP, or rendering is unsupported, capture the typed limitation and complete
fallback; do not substitute fixture output or claim the missing behavior.

The run is not complete when the first interface appears. Use an application
control that invokes a declared editable TypeScript action, ask in chat for one
targeted refinement without rebuilding unrelated source, request every
advertised display mode, restart the host, reopen the historical message, and
audit the final receipt tree and durable state.
