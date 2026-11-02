# Design-studio prototype validation

Status: incomplete local live prototype, not capstone evidence and not an uncut
publication run.

## Fresh implicit request

Codex Desktop task alias `design-studio-prototype-task` ran in the unrelated,
projectless directory
`%USERPROFILE%\Documents\Codex\2026-08-01\marshal-design-capstone` with this
prompt:

> Create a polished design workspace for a calm launch-planning product.
> Explore meaningfully different directions, let me compare and refine them
> directly, preserve the work, and make it usable here.

The prompt did not name Marshal, TypeScript, MCP Apps, or subagents.

## What the run demonstrated

- Codex selected Marshal autonomously despite encountering a stale installed
  skill-cache path in the already-running desktop process.
- It authored editable React source at
  `outputs/launch-planning-workspace.tsx`.
- It compiled, bound, and displayed the application inline on the first render.
- The application contained three meaningfully different directions, a compare
  view, focused preview, visual controls, decision notes, and a launch checklist.
- Browser-local preferences survived component openings through `localStorage`.
- The task completed in 243,493 ms; time to first token was 7,630 ms.

Editable source SHA-256:
`478D269F68F78EB78BE6C51177A6F45ECC7F3E5BF474DF1CED4EE41E3339A334`

Local trace:
`%USERPROFILE%\.codex\sessions\2026\08\01\design-studio-prototype-task.jsonl`

Trace SHA-256 at audit time:
`D33BCADDD5FB1A69B7931EAAA7D3DABF9E24DF2D715710508C8BF4A51639455B`

## Why this is not a capstone pass

The run did not author a TypeScript orchestration backend, launch native
subagents, declare runtime-backed application actions, exercise fullscreen or
picture-in-picture, persist authoritative backend state, perform a targeted
chat-driven refinement, or demonstrate restart restoration. There is no uncut
recording, redaction manifest, receipt-tree review, or short-media provenance.

This run is retained because it proves useful autonomous routing and a working
inline authored application, while exposing the exact remaining capstone gap.
It must not be presented as the design-studio release demonstration.
