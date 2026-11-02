# Design-studio capstone attempt 4 — 2026-08-01

## Classification

`local-live-smoke`, incomplete. This fresh installed-host attempt establishes
implicit routing, editable TypeScript orchestration, real bounded native
delegation, durable state, and an honest declarative fallback. It is not a
capstone pass: the installed profile denied authored React compilation, and no
live action, presentation-mode, restart, or uncut-media validation occurred.

## Frozen prompt

> Create a polished, persistent design workspace for a calm launch-planning
> product. Explore four meaningfully different visual and interaction
> directions, compare and critique them, synthesize the strongest approach,
> and let me refine the result directly here. Preserve editable source and
> state so I can reopen and continue later. Work autonomously and validate the
> result.

The prompt did not name Marshal, TypeScript, MCP Apps, or subagents. The fresh
Codex task alias was `design-studio-attempt-4-task`, running detached
candidate `%USERPROFILE%\.marshal\codex-runtime-0.1.0-20260801n` with
workspace-write sandboxing and noninteractive host approval disabled.

## What the attempt established

- Codex selected Marshal autonomously and discovered its capabilities.
- The model authored an editable orchestration module, launched four native
  design agents concurrently, waited for all four successful outcomes, and
  preserved their results and synthesis in a durable artifact.
- The model authored an editable backend module with save/load operations,
  saved an initial workspace state, reopened it, and observed an exact cache
  hit with no diagnostics.
- The model authored a 47,751-byte React component and 30,246-byte stylesheet,
  then ran a source-level UI quality check covering four directions, four
  views, two backend calls, interaction targets, typography, press feedback,
  and the absence of `transition: all`.
- When React compilation was denied, the model did not claim success. It
  recovered to a read-only declarative artifact and rendered that fallback in
  chat at
  `ui://marshal-declarative/8c8e1ebf-3e78-4a50-a69e-4d662879ea4c/r/1`.

The receipt journal contains 54 top-level receipts: 45 successful, four
cancelled, one denied, and four failed. The successful orchestration receipt
shows four concurrent child spawns, four successful waits, peak concurrency
four, and a 48,104 ms module duration.

## Defects exposed

The first complete orchestration used the advertised 30,000 ms module default.
All children continued making progress, but the outer module timed out while
waiting. The model recovered by requesting 180,000 ms; the host silently
clamped it to 60,000 ms and completed in 48,104 ms. The discovery contract did
not expose that default or maximum, making the first failure avoidable.

Authored React compilation was then denied immediately:

- target: `ui.compile`
- receipt: `receipt-msafbb90-51-4808ogmp`
- status: `denied`
- code: `explicit_grant_required`
- reason: `Missing explicit permission grant(s): trusted_ui.`

Candidate `n` installed the `bounded-agentic` profile, which grants bounded
delegation but intentionally omits `trusted_ui`. Switching to `trusted-local`
would be overbroad because it also grants trusted Node and wildcard imports.
The corrective design is a distinct narrow profile that combines bounded
delegation with authored UI while retaining the other denials.

Creating the declarative fallback also required four failed schema-discovery
iterations before success. The tool schema omitted enough recursive node
details that the model had to learn required node IDs and enum vocabulary from
validation errors.

## Retained artifact hashes

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `calm-launch/source/orchestrate-directions.ts` | 4,631 | `64B7E04AE36EF0DADB6A7315BE8F5A874E4855F95438DBD653E05D29A8D098C5` |
| `calm-launch/source/workspace-actions.ts` | 2,431 | `35AE33344E919A940A7F80BA1E5466D4C7FFE3B65BEA44609B3C6B4DD621C14F` |
| `calm-launch/source/CalmLaunchWorkspace.tsx` | 47,751 | `42B54B8168AEEE688CAE6F143A5C3B444F8743D3CCE2925CED9D3CC1CA94453F` |
| `calm-launch/source/calm-launch.css` | 30,246 | `EFE135F559A106EBC6047C72E93B90A40EE6B779BEC0FCD1C5F335F53D2DB12A` |
| `calm-launch/state/design-evidence.json` | 19,019 | `C887DF7997E31CFBD6821FDC542A6D705DA28DB9C3792870F6922C1187E4ADBF` |
| `calm-launch/state/workspace.json` | 1,782 | `152545ED09D57BC9B73248B88F95D22164F41ECF12601221EDF94B5573C3CE43` |
| `calm-launch/render-plan.json` | 5,163 | `92A0AAB0FC062414B0DD29D6046F807F450D9E7C2CAF846C259E228EC2C33234` |
| `receipts/executions.jsonl` | 108,713 | `2000C52F4742D508B891835525C20EE249048AFBCA0325656DDD326EB44275E7` |

These files remain outside the repository in the named capstone workspace.
Hashes establish identity only; they are not uncut visual evidence.

## Corrective conditions for attempt 5

1. Install a narrow, explicit authored-UI plus bounded-delegation profile that
   continues denying trusted Node, wildcard imports, effects, and network.
2. Resolve one effective profile consistently across the Codex adapter and
   portable host.
3. Publish execution timeout defaults and maximums in discovery and reject,
   rather than silently clamp, impossible requests.
4. Package an exact React authoring/action/display-mode reference in the
   installed plugin and accept the standards response `{ mode }`.
5. Rerun the unchanged frozen prompt in a fresh workspace and require compiled
   React, direct in-chat rendering, live action dispatch, mode negotiation,
   saved-state reopen, host restart recovery, and retained receipts.
