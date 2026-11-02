# Design-studio capstone attempt 3 — 2026-08-01

## Classification

`local-live-smoke`, incomplete. This attempt is retained because it exposed a
fresh-session learnability defect and a noninteractive host-approval defect. It
is not a capstone pass and supports no UI, delegation, or release claim.

## Frozen prompt

> Create a polished, persistent design workspace for a calm launch-planning
> product. Explore four meaningfully different visual and interaction
> directions, compare and critique them, synthesize the strongest approach,
> and let me refine the result directly here. Preserve editable source and
> state so I can reopen and continue later. Work autonomously and validate the
> result.

The prompt did not name Marshal, TypeScript, MCP Apps, or subagents. The fresh
Codex task alias was `design-studio-attempt-3-task` and used immutable
detached runtime candidate
`%USERPROFILE%\.marshal\codex-runtime-0.1.0-20260801h`.

## What the attempt established

- Codex selected Marshal immediately from the natural request and read the
  freshly installed Marshal skill.
- The model independently chose the intended broad-then-exact discovery
  strategy.
- The installed plugin was current and configured with the bounded-agentic
  profile rather than wildcard trusted authority.

## Why this is not a pass

The generated broad search used `detail:"compact"`. That word appeared in the
human-facing projection, but the Codex MCP schema allowed only `summary` or
`full`; the host therefore rejected/cancelled three retries before the runtime
kernel was reached. This was a real learnability/API-vocabulary mismatch.

An exact-name retry then also surfaced as a cancelled MCP call. The CLI process
had been started without an explicit noninteractive approval policy. The
evidence is consistent with an approval request that the noninteractive host
could not satisfy; it is not evidence of a runtime operation failure.

No application source, compiled component, render, child-agent result, or UI
interaction was produced. The run was deliberately terminated after the
repeated cancellation pattern was confirmed, so it cannot be presented as a
latency or capability result.

## Corrective conditions for attempt 4

1. Teach the exact canonical `detail:"summary"` spelling in every projection.
2. Accept `compact` only as a backward-compatible Codex-adapter alias and
   normalize it to the portable protocol's canonical `summary` value.
3. Start the fresh noninteractive host with `approval_policy="never"` while
   retaining workspace-write sandboxing and the bounded-agentic Marshal
   permission profile.
4. Rebuild and reinstall an immutable detached candidate; do not modify
   candidate `h` in place.
5. Rerun the unchanged frozen prompt and retain the complete result, including
   failures.
