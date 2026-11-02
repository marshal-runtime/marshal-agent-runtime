# Codex desktop UI release-gate audit

Date: 2026-08-01
Evidence class: `deterministic`
Release status: **live desktop evidence still required**

This audit separates repeatable runtime and MCP Apps behavior from claims that
only a reviewed Codex desktop run can establish. No screenshot, screen
recording, host click, or host restart is inferred from a fixture or tool
result.

## Deterministic coverage

| Gate | Repeatable evidence now available | What it establishes |
| --- | --- | --- |
| Compiled React | shared standards-only suite, unchanged Codex composite-adapter suite, renderer smoke, and historical-render probe | a compiled content-addressed resource and stable public render binding can be recovered |
| Declared action | adaptive-application conformance | declaration lookup, input/output schema checks, scope, permission, receipt, denial, idempotency, and restart replay |
| Declared direct tool | adaptive-application conformance | undeclared and invalid calls are rejected; a declared tool uses canonical MCP Apps `tools/call` and validates its output |
| Inline/fullscreen/PiP | adaptive-application conformance | canonical request shape plus granted, fallback, unsupported, and denied typed outcomes |
| Saved state | adaptive-application conformance and historical-render probe | project-scoped values survive runtime reconstruction without leaking into an isolated project scope |
| Historical render reuse | 100-reopen stress and historical-render probe | the same render/component/bundle/binding/state recover across independent runtime instances without modifying the UI state tree |

The reusable historical probe is:

```text
node scripts/verify-ui-history-recovery.mjs <workspace> <renderId> \
  --expect-storage expected-storage.json \
  --require-action <action-id> \
  --require-tool <tool-id> \
  --require-mode fullscreen \
  --require-mode pip \
  --output recovery-probe.json
```

Each `--require-*` option is repeatable. The report contains compiled HTML and
binding digests, declared action/tool IDs, presentation modes, recovered state,
and before/after hashes for every React UI state file. It exits nonzero when an
invariant fails. It does not call an action or tool and therefore cannot be
used as evidence that a user control worked in Codex.

## Live Codex desktop checklist

One continuous reviewed attempt must still show all of the following:

- the compiled React app mounts inside the historical Codex message; no stuck
  placeholder or terminal error is hidden above or below it;
- a visible control invokes one declared capability action and the resulting
  receipt identifies the originating render, declaration, scope, permission,
  target receipt, and outcome;
- a visible control invokes one manifest-declared direct tool and the trace
  identifies its declared ID, concrete MCP tool name, validated input, and
  returned output;
- inline is usable before and after all transitions;
- fullscreen and PiP are requested from the app and the recording preserves
  the exact host result: granted, fallback, denied, or unsupported;
- a selected view is saved through the scoped state path and the expected
  storage JSON is retained beside the trace;
- Codex is restarted using the product operation, the historical message is
  reopened, the same render ID and selected view appear, and the trace contains
  no new source write, compilation, or render binding;
- the complete textual fallback is inspected in a non-Apps path;
- `recovery-probe-before-host-restart.json` and
  `recovery-probe-after-host-restart.json` both pass, but are treated only as
  supporting machine evidence for the continuous recording.

Until that run passes independent review, Marshal may claim deterministic UI
contract readiness, not actual Codex desktop action, presentation, pixel, or
restart compatibility.

## Current environment capture audit

The local audit on 2026-08-01 found no model-controlled Codex desktop surface:

- the browser-control runtime reported no connected browser instances;
- the exposed Codex app operations can open panels, navigate to a task, and
  read a task terminal, but do not inspect or click chat DOM, capture the main
  window, drive authored-app controls, or restart the product; and
- no desktop screenshot, pointer, keyboard, window, or recording tool is
  exposed to this task.

The machine does provide FFmpeg
`2024-12-26-git-fe04b93afa-full_build-www.gyan.dev` with Windows `gdigrab`.
The read-only preflight found one visible `ChatGPT` process titled `Codex` and
reported both full-desktop and window capture available. This is a supported
local **pixel-recording preparation path**, not Codex host automation and not
evidence by itself.

`examples/publication/demo-capture/capture-host.mjs` now probes that boundary
and can run a foreground, non-overwriting WebM capture outside the repository.
Full-desktop capture can remain continuous through a human product restart;
window-title capture cannot. The driver deliberately never clicks, sends keys,
requests fullscreen/PiP, reopens a historical task, or stops/starts Codex.

The remaining human gates are exact:

1. start full-desktop capture before opening the fresh task and keep it uncut;
2. inspect the inline pixels and record the video range;
3. click the capability action and editable-module action, retaining their
   trace/receipt IDs;
4. request fullscreen and PiP from visible app controls and retain the exact
   granted, denied, fallback, unsupported, or failed outcome;
5. inspect the non-Apps textual fallback;
6. save the selected state and run the pre-restart deterministic probe;
7. restart Codex using the documented product operation, then reopen the
   historical task and inspect the restored pixels;
8. verify the same render ID and no compile/rebind in the trace, then run the
   post-restart probe; and
9. stop recording, complete `recorder.json` and `host-gates.json`, redact,
   independently review, and only then derive GIF/MP4 media.

The capture verifier now rejects placeholder media signatures and requires
every UI/restart/capstone host gate to have an uncut-video range. Machine-action
gates also require a trace or receipt reference. Structural verification still
does not decide whether the pixels or interaction are correct; that remains an
independent review obligation.

## Focused verification

- `pnpm --filter @marshal/agent-runtime-conformance typecheck`
- `pnpm --filter @marshal/agent-runtime-conformance test`
- `pnpm --filter @marshal/agent-runtime-codex-capabilities test`
- `node --test examples/publication/__tests__/ui-history-probe.test.mjs`
- `node scripts/validate-docs.mjs`

Observed result on 2026-08-01: conformance 5/5, Codex capabilities 29 passed
with one opt-in real-backend smoke skipped, recovery-probe tests 2/2, and docs
validation passed.
