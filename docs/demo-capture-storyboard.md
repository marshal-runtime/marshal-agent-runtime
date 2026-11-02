# Demo capture storyboard

The executable capture plan is
[`examples/publication/demo-capture/capture-plan.json`](../examples/publication/demo-capture/capture-plan.json)
and the verbatim operator prompts are in
[`live-run-script.md`](../examples/publication/demo-capture/live-run-script.md).
Neither file is evidence. They are advance plans that make inputs, omissions,
and edits auditable.

The capture plan is version `1.4.1`. It names the supporting export,
derivative, and campaign-index tools below and explicitly preserves their trust
boundaries. Existing prepared bundles with an earlier plan hash must not be
silently upgraded; prepare a new empty bundle for the new campaign.

## Prepare before recording

Use a new absolute directory outside the source repository:

```sh
node examples/publication/demo-capture/prepare-evidence.mjs /absolute/empty/evidence-directory
```

The preparation tool snapshots and hashes the capture plan, prompts, editable
sources, and fixtures. It creates metadata templates and a prominent
`NOT EVIDENCE` notice. It does not create a trace, receipt, screenshot, GIF,
MP4, or uncut recording. Keep the generated `capture-input.json` beside each
attempt so later verification can reject prompt or source drift.

Start the operating-system recorder before the fresh task is opened. Record the
full host window at native resolution and a stable frame rate. Do not pause,
splice, speed up, hide errors, or replace failed attempts. Preserve every
attempt under a unique `captureAttemptId`.

On Windows, the repository includes a foreground-only FFmpeg preflight and
recorder. The preflight is read-only and explicitly reports `not-evidence`:

```powershell
node examples/publication/demo-capture/capture-host.mjs probe
node examples/publication/demo-capture/capture-host.mjs record C:\absolute\outside-repo\screen.webm --source desktop
```

Use desktop capture, not window-only capture, for restart evidence: it remains
continuous while Codex is closed and reopened. The command refuses relative
paths, repository-local media, and existing output files. It writes
`recorder.json` only after capture ends. It never clicks, requests a mode,
reopens history, or restarts Codex; the operator performs those product actions
on-screen and records their ranges in `host-gates.json`.

## Export trace and receipts without reconstruction

Export the task or harness event stream as JSON or JSONL. Preserve that raw
file, then canonicalize it into the demo directory:

```sh
node examples/publication/demo-capture/export-trace-receipts.mjs \
  /absolute/evidence-set/round-1/raw-task.jsonl \
  /absolute/evidence-set/round-1/ordinary-typescript
```

The helper writes `trace.jsonl`, `receipts.export.jsonl`, and
`trace-export.json`. The manifest hashes the raw source and both outputs and
records a JSON Pointer for every extracted receipt. Extraction recognizes only
objects already present with `receiptId`, `status`, and a target, operation, or
execution ID. Conflicting duplicate receipt IDs fail closed. It never invents
a receipt or claims that one is truthful.

Use `--no-receipts` when the source is known not to contain receipts, or
`--allow-no-receipts` when an empty receipt export is an expected negative
result. Demo-specific files such as `write-receipt.json` and
`action-receipts.json` still need to be exported from their authoritative
runtime records; the generic extraction does not reinterpret or split them.
The human redaction and trace/receipt-correspondence reviews remain mandatory.

## Visual sequence

| Beat | Short GIF/MP4 edit | Uncut evidence requirement | On-screen disclosure |
| --- | --- | --- | --- |
| Request | Show the untouched user prompt | Recording begins before the fresh task opens | Host, version, model, reasoning setting, permission profile |
| Autonomous routing | Show discovery and editable source creation | Preserve complete trace, including failed or unused routes | Do not narrate hidden reasoning |
| Permission boundary | Show configured grants and bounds | Save the exact permission profile and approvals | “Pre-authorized within these bounds” |
| Execution | Show useful module, capability, or delegation activity | Retain parent-child receipts and timing/token/cost records | Unsupported features remain visible |
| Result | Show text output or the inspected live app and complete fallback | Save final response, source, props, fallback, artifacts, and receipts | Say “payload delivered” unless pixels were inspected |
| Interaction | Invoke a declared action or request a mode | Preserve schemas, decision, output, and receipt | Identify capability versus editable-module action |
| Edit | Change only the targeted backend or frontend source | Show changed digest and unchanged unrelated source | Do not imply rebuild-free behavior if rebuilding occurred |
| Recovery | Restart and reopen the historical result | Show same render ID and no source write, compile, or new binding | State scope and restored values |
| End card | Summarize observed and unsupported behavior | Link the uncut run and raw evidence index | Separate measurements from targets |

## Demo-specific short storyboards

These are edit guides, not permission to omit anything from the uncut run.
Every short-media range must be listed in `derivatives.json` with its source
start/end milliseconds.

| Demo | GIF preview | Short MP4 | Essential uncut continuation |
| --- | --- | --- | --- |
| Memory Brain | Ambient observation → worker receipt → fresh-task semantic recall | Prompt, queued observation receipt, finalized worker receipt, task switch, naturally selected Brain recall, scope receipt | Include the earlier task closure, worker completion, and full second-task opening |
| Ordinary TypeScript | Editable source → verified result | Indirect prompt, autonomous route, module source/digest, run, fixture edit, rerun | Preserve all compile/diagnostic attempts and the negative control as a separate attempt |
| Capability composition | Project input → persisted brief | Indirect prompt, memory lookup, attachment/project data, artifact write, nested receipts | Preserve source, input hashes, scope decisions, and historical artifact reopen |
| Bounded delegation | Specialist fan-out → synthesized decision | Indirect prompt, declared bounds, useful assignments, synthesis, complete receipt tree | Publish a separate cancellation attempt with partial results and no-orphan audit |
| UI actions and modes | Inline control click → visible result | Mount, capability action, module action, fullscreen, PiP or typed limitation, fallback | Preserve denials/errors and action receipts |
| Restart recovery | Selected view before restart → same view after reopen | Render ID, selected state, host restart, historical reopen, no-compile trace | Keep the host exit/start sequence continuous |
| Design studio capstone | Directions → comparison → targeted refinement | Prompt, autonomous routing, bounded fan-out, synthesis, app, action, mode, refinement, restoration | Preserve the entire fresh task, failures, restart, and receipt-tree audit |

Recommended delivery files per demo are the native continuous `screen.webm`, a
short H.264 `short.mp4`, and a compact `preview.gif`. The verifier does not
assume that transcoding is bit-identical across FFmpeg versions. Record the
encoder version and exact command in `derivatives.json`, hash every output, and
map every edited range back to the uncut source.

After the **complete bundle** passes capture-level structural verification,
copy `derivatives.template.json` to a separate absolute edit-manifest path,
replace its demo ID and `edits`, and run:

```sh
node examples/publication/demo-capture/generate-derivatives.mjs \
  /absolute/evidence-set/round-1 ui-actions-and-modes \
  /absolute/evidence-edit-ranges/ui-actions-and-modes.json
```

The generator refuses repository-local evidence, existing outputs, malformed
or out-of-duration ranges, and a bundle that has not passed the capture gate.
It invokes external FFmpeg/FFprobe without a shell, removes audio, applies the
listed source ranges in their listed order, and writes output/source hashes,
the encoder version, probe, and exact arguments to `derivatives.json`. It does
not perform host interaction, restart Codex, or decide whether an edit is fair.
Those remain recorded human actions and review judgments.

## Generated fixture rehearsal

Fixture props and generated delegation results may be used to rehearse framing
or responsive layouts before the live run. Every rehearsal frame must carry the
persistent overlay:

> GENERATED FIXTURE — NOT LIVE EVIDENCE

Fixture rehearsal must not be cut into a live demonstration. Media belongs in
an external evidence bundle until review. No fixture screenshot, mock receipt,
or reconstructed trace may be promoted by changing its filename or metadata.

## Review and verification

After every required capture file and human review is complete, remove
`CAPTURE-BUNDLE-NOT-EVIDENCE.md` immediately before the first verification
run. Removing the notice is an explicit operator declaration that the prepared
bundle has been populated; it is not evidence and does not replace any gate.

The capture-level gate requires continuous-run metadata, trace/receipt files,
redaction review, and the uncut WebM:

```sh
node examples/publication/demo-capture/verify-evidence.mjs /absolute/path/to/evidence --level capture --write-index
```

The publication-level gate additionally requires `review.json`, `preview.gif`,
`short.mp4`, and `derivatives.json` whose source and output hashes match:

```sh
node examples/publication/demo-capture/verify-evidence.mjs /absolute/path/to/evidence --level publication --write-index
```

Structural success is necessary, not sufficient. A reviewer must inspect
continuity, redaction, trace/receipt correspondence, host pixels,
accessibility-sensitive interactions, unsupported-feature disclosure, and
whether every short edit fairly represents the linked uncut run.

## Verify a multi-bundle, all-attempt campaign

Create one prepared bundle per randomized round under a common external
directory. Before each run, add its expected `bundle`, `demoId`, and stable
`captureAttemptId` to `all-attempts.json`, based on
[`all-attempts.template.json`](../examples/publication/demo-capture/all-attempts.template.json),
and retain the dated/hash history of that ledger. Outcomes are declarations:
`succeeded`, `failed`, `interrupted`, or `unsupported`. A failed attempt still
gets its uncut recording and complete evidence files; its outcome is not
converted to success.

```sh
node examples/publication/demo-capture/verify-evidence-set.mjs \
  /absolute/evidence-set --level capture --write-index

node examples/publication/demo-capture/verify-evidence-set.mjs \
  /absolute/evidence-set --level publication --write-index
```

The aggregate verifier runs the selected structural gate for every named
bundle, rejects unlisted bundle directories, requires an exact bundle/demo and
capture-attempt-ID match, rejects duplicate IDs, preserves declared outcomes,
and hashes every indexed file into `evidence-set-index.json`. This proves
closure relative to the preserved campaign root and ledger. It cannot detect a
run that the operator never preserved there, so the ledger history and
independent review remain part of the publication evidence.

For UI, restart, and capstone demos, `host-gates.json` must cover every frozen
host gate with an exact uncut-video range. Action, mode, state, and binding
gates also need receipt or trace references. Status may honestly be `observed`,
`granted`, `denied`, `fallback`, `unsupported`, `failed`, or
`not-applicable`; `UNVERIFIED` is rejected. This makes failed attempts
auditable without converting a typed limitation into a pass.
