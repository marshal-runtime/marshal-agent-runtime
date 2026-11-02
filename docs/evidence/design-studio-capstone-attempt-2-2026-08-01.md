# Design-studio capstone attempt 2 — 2026-08-01

## Classification

`local-live-smoke`, incomplete. This attempt is retained because it exposed a
real detached-package defect and a discovery-efficiency problem. It is not a
capstone pass and does not support a release claim.

## Frozen prompt

> Create a polished, persistent design workspace for a calm launch-planning
> product. Explore four meaningfully different visual and interaction
> directions, compare and critique them, synthesize the strongest approach,
> and let me refine the result directly here. Preserve editable source and
> state so I can reopen and continue later. Work autonomously and validate the
> result.

The prompt did not name Marshal, TypeScript, MCP Apps, or subagents. The fresh
Codex task alias was `design-studio-attempt-2-task` and used detached runtime
candidate `%USERPROFILE%\.marshal\codex-runtime-0.1.0-20260801f`.

## What worked

- Codex selected Marshal without being instructed to do so.
- It preserved separate editable orchestration, backend, and frontend source.
- The workspace-backed state module passed a save/load round trip and wrote a
  scoped artifact.
- The React component compiled and produced a validated render on the first
  render-schema attempt.
- The application manifest declared inline, fullscreen, and picture-in-picture
  modes, scoped local and authoritative state, and a module-backed save action.
- The final UI remained usable through an explicit, preserved fallback.

Observed files and SHA-256 digests:

| File | SHA-256 |
| --- | --- |
| `marshal/orchestrate-directions.ts` | `1496719D90C6A6DD1256B1B9500DE3FDE2E690121BA23DF6E3A20F004D68CAA3` |
| `marshal/workspace-state.ts` | `CDEF49934278013A592DF927A31D2923E5F83E526D8DF47F72A4E918B8756E58` |
| `marshal/CalmLaunchWorkspace.tsx` | `38CF93C1B71D4E9F28EE415EF9661F5582EC01CEFB9B4CA223B85C0EC97FCE49` |
| scoped `workspace-state.json` | `1744BE67EE5B643A2B248EE44182B4BD9409E45051B0D8E2CE0574D935F2ACA4` |

The retained render ID is
`32899d0ac9426dc35faa5b68c2cd711698d2df3ca1ec568edf22735821573af3`;
its compiled component ID is
`7e09ff37c65008ee36b53f5078b12ff97386e9c560101e388c5dc9cbe852ad70`.

## Why this is not a pass

The authored orchestration program first guessed the wrong result path instead
of reading `spawned.handle.delegationId`. A direct retry then proved that the
installed Codex-specific capabilities package could not resolve its Codex CLI
dependency. Five durable delegation records ended in `failed` with
`MODULE_NOT_FOUND` for `@openai/codex/package.json`. No useful child-agent
result was synthesized; the app used its embedded independent-critique
fallback.

The run also performed repeated broad capability searches whose full embedded
schemas caused disproportionate context and latency. The next attempt must use
compact discovery plus exact schema lookup.

Finally, declared mode support and the save action were not captured as real
host interactions, and restart restoration was not demonstrated in an uncut
recording.

## Required rerun conditions

1. Build a new detached candidate containing the direct Codex adapter
   dependency; never mutate candidate `f` in place.
2. Verify brokered `spawn → spawned.handle.delegationId → wait` outside the
   development repository.
3. Install a brokered/default-deny plugin projection and start a genuinely
   fresh Codex task with the exact prompt above.
4. Require useful completed delegation results, editable frontend/backend
   source, a live declared action, display-mode negotiation, refinement, and
   restart restoration.
5. Preserve the complete trace, receipts, source, UI capture, timings, and all
   failures. A fallback-only result remains a failed capstone.
