# Design-studio capstone attempt 6 — 2026-08-01

## Classification

`local-live-smoke` plus a separate `deterministic` recovery probe. This fresh
installed-host attempt completed the frozen task and passed the runtime-side
application and recovery checks. It is **not yet a complete release capstone
pass**: the retained evidence does not prove Codex desktop pixels, an in-app
action click, a host fullscreen/PiP outcome, historical-message recovery after
a real Codex application restart, or reviewed uncut media.

## Frozen prompt

> Create a polished, persistent design workspace for a calm launch-planning
> product. Explore four meaningfully different visual and interaction
> directions, compare and critique them, synthesize the strongest approach,
> and let me refine the result directly here. Preserve editable source and
> state so I can reopen and continue later. Work autonomously and validate the
> result.

The prompt did not name Marshal, TypeScript, MCP Apps, or subagents. The fresh
Codex task alias was `design-studio-attempt-6-task`, rooted at
`%TEMP%\marshal-release-capstone-6`, with installed plugin version
`0.1.0+codex.20260801152705` and detached candidate `p`.

For publication, `%TEMP%` denotes the historical machine-local temporary root;
the retained hashes and timestamps below are unchanged.

## Timeline

All timestamps are UTC. Latencies are measured from the user prompt at
`2026-08-01T15:28:20.068Z`.

| Event | Timestamp | Latency |
| --- | --- | ---: |
| Codex selected Marshal in commentary | `2026-08-01T15:28:27.584Z` | 7,516 ms |
| First delegation-capabilities receipt | `2026-08-01T15:29:07.437Z` | 47,369 ms |
| First four-root review module started | `2026-08-01T15:30:35.219Z` | 135,151 ms |
| First four-root review module completed | `2026-08-01T15:32:08.617Z` | 228,549 ms |
| Second four-root pass and review-archive write completed | `2026-08-01T15:34:44.937Z` | 384,869 ms |
| Original TSX compiled | `2026-08-01T15:43:28.120Z` | 908,052 ms |
| Immutable render created | `2026-08-01T15:43:52.630Z` | 932,562 ms |
| `runtime_render_component` returned | `2026-08-01T15:44:05.356Z` | 945,288 ms |
| Final assistant answer | `2026-08-01T15:45:29.400Z` | 1,029,332 ms |

Marshal was selected immediately, with no generic-visualization detour. The
complete task nevertheless took 17 minutes 9 seconds, so autonomous routing
passed while end-to-end latency did not reach a desirable product bar.

## Passed in the fresh task

- Codex read the packaged Marshal and React authoring contracts, used
  summary-then-exact capability discovery, and inspected truthful delegation
  support before executing authored code.
- It preserved an editable TypeScript orchestration module with explicit
  depth, agent, root-concurrency, elapsed-time, token, retry, permission, and
  effect bounds. Both executions requested a 150,000 ms outer timeout above
  the 120,000 ms nested wait.
- Each execution launched four independent native Codex reviewers concurrently
  for Tidal Ledger, Garden Rooms, Signal Board, and Ritual Notebook. Both
  four-root waits succeeded. The second revision also normalized and wrote the
  four-review archive to `calm-launch/reviews.json`.
- It authored editable React/TSX, editable seed JSON, orchestration TypeScript,
  and reopen notes. The original compiled TSX was 69,041 bytes.
- It wrote authoritative workspace state to
  `calm-launch/workspace.json`, read that state and the review archive back,
  and verified schema `1.0.0`, revision `1`, four milestones, and four reviews.
- `ui.compile`, `ui.render`, `ui.renders.get`, and the single
  `runtime_render_component` invocation returned successfully. The task ended
  with a normal final answer rather than interruption.

## Application contract produced

The immutable render declares:

- presentation modes `inline`, `fullscreen`, and `pip`;
- backend actions `save-workspace` → `artifacts.write` and `load-workspace` →
  `artifacts.read`;
- no app-visible direct tools;
- workspace-scoped local state and authoritative artifact state at
  `calm-launch/workspace.json`;
- authoring profile `quiet-current-design-studio@1.0.0`.

The compiled source calls the two declared actions through the injected Marshal
client, includes fullscreen and PiP requests with honest outcome reporting and
inline fallback, and keeps local view preferences separate from authoritative
workspace data. The original frozen turn declared PiP but did not expose it as
its own visible control; the targeted refinement below added that control.
Persistence was validated by invoking the exact declared actions through a
separate runtime; the trace still does **not** show a desktop user clicking
either declared action.

## Deterministic recovery result

The later two-runtime probe at
`%TEMP%\marshal-release-capstone-6-evidence\ui-history-recovery.json`
reported `status: passed` for the original render:

- render `77092ae66c094d460a6302a0ecb1d5b7ad9a340cfc8d8bf6c8437ca1aaefe2f3`;
- component `70c6d5a2b23b2b0dc5126b3ea97745d28efdcc081dd76fc15f68c0b0cdc97582`;
- bundle digest
  `b64377339b674f4537da6543124fc62ee8d44bb0820cfd4866bf1e92d42f2535`;
- 1,220,804 compiled HTML bytes with SHA-256
  `02b44495d52f12d211f03dbf781358a9b9b1911089b9b925692b8c08026ae65a`;
- stable public binding digest
  `2e90851d7bc2b2de48a60494e2d0c61159078080bdc7ba9a43c2fb2036299d76`;
- stable recovery-envelope digest
  `a6ec250605f63addb1a0126c8e0eb094ed814441a279e297c2349fa231232012`;
- both action declarations and all three mode declarations present;
- local saved state `{}` recovered; and
- both component/render state files unchanged in bytes, hash, and modification
  time across the two runtime opens.

This establishes deterministic runtime recovery without recompilation or a new
binding. It does not establish a real Codex application restart or desktop
history pixels.

## Targeted PiP refinement

A follow-up in the same Codex task requested only an explicit PiP control and
truthful host outcome handling. Codex reopened the existing render and state,
edited the retained TSX and README without rerunning the four-review research,
compiled once, created one new immutable render binding, and displayed it.

- refined source: 73,416 bytes, SHA-256
  `2D1C106904E97D0A904DD3EDC14FF450ACE0B08B72436BD7349DA417EF19E3D1`;
- component
  `13d5a4247e5cbbf986882833da7f5c60adedf0324d2cce1709921985418ab96c`;
- bundle digest
  `600308834580ba5a3498e91d4883f7fc63e9ef00e8825729825155e2be4dbfa9`;
- render
  `fa1a3e0397211bf941122240e66e7d0f31bb8479ea4ab4bcfaf8b1c0a9bb97f0`.

The refined interface places PiP beside fullscreen in both the top bar and
refinement controls. A shared typed display-mode handler feature-detects the
host API and reports `granted`, `denied`, `fallback`, or `unsupported` rather
than claiming success optimistically. Inline remains the baseline.

The two-runtime recovery report at
`%TEMP%\marshal-release-capstone-6-evidence\ui-history-recovery-refined.json`
passed with 1,225,815 compiled HTML bytes, stable component, bundle, public
binding, recovery envelope, saved state, action declarations, and all three
presentation modes. Its SHA-256 is
`0ECF797FE9AF2C927187D1445C7C6386F507B7A76181C26CE01BA09791CFBD76`.

A separate runtime then invoked `load-workspace` and `save-workspace` through
the refined render's declared action bridge. Both returned `success`, explicit
`artifacts.read` / `artifacts.write` permission grants, and complete receipts;
the save used idempotency key
`capstone-6-refined-live-action-validation-v1`. This proves the action contract
is executable after refinement, but it is not evidence of a human desktop
click.

## Receipts, lineage, and no-orphan check

The frozen turn produced 20 top-level Marshal receipts, all `success`: one
delegation-capabilities read, eight spawns, two multi-root waits, two module
executions, two artifact writes, one compile, one render, two artifact reads,
and one render read. The recovery probe subsequently added four successful
operations: an artifact read/write pair, another artifact read, and a render
metadata read.

There are eight durable delegation records across two orchestration IDs. All
eight are `succeeded`; none is `running`, `cancel_requested`, `cancelled`, or
failed. Each module reports peak broker concurrency four. This is a no-orphan
pass for this completed attempt, not a cancellation-path test.

## Latency and cost caveats

The first module took 93,398 ms and the second took 89,341 ms. The second run
repeated all four reviews because Codex revised the module to add archive
persistence after the first successful pass. That duplication created eight
reviewer executions where four useful reviews should have been sufficient and
is the clearest avoidable latency/cost defect in the trace.

The last pre-final Codex token snapshot reports 2,002,993 input tokens
(1,873,920 cached), 36,376 output tokens, and 5,598 reasoning-output tokens.
This is cumulative host accounting across the long turn, not a final billing
statement. The orchestration explicitly reports `tokenUsageAvailable: false`
and `costUsageAvailable: false` for delegated agents, so exact subagent cost
and a complete task price are not established.

## Retained identities

| Item | Bytes | SHA-256 / content identity |
| --- | ---: | --- |
| Original compiled `calm-launch-workspace.tsx` | 69,041 | `261C720075E04F55CA129C9FBD4495BBD3ECA05B1CBD0FEA3C02E1CF769A3CE2` |
| Final frozen-turn `design-orchestration.ts` | 6,758 | `42D8CC847CE4F70C3ED4B474F11F87A909CB7CFE11D1EFB866457415FEC34E2E` |
| `workspace-seed.json` | 1,829 | `BEA406F96A601A80EE3105C682EBF3394E61250D57C7D996F8C1E62AC6AE55A5` |
| Durable `reviews.json` | 49,767 | `5E7BDBAFF7D5B161782D9BCF3C2D074EDA7F07069BD869BB7DCE4D83791BDDD8` |
| Immutable render metadata | 8,259 | `E8756AB7D40C6E2B7FDA217C59708C19D59902FDF7AD0F6F0F3689E9F5F78588` |
| Recovery report | 11,987 | `27193166115AE3B61C165B7B6B23BC29BD00C4B8F2DA11376C5DF8D99ED833B2` |

The retained Codex session is recorded publicly under the alias
`%USERPROFILE%\.codex\sessions\2026\08\01\design-studio-attempt-6-task.jsonl`.
The workspace was subsequently used for a separate PiP-refinement follow-up,
so the mutable TSX file can no longer be assumed byte-identical to the original
immutable component; the component metadata retains the original source
digest above.

## Still required for a release capstone pass

1. Capture actual Codex desktop pixels for the inline component.
2. Click Save and Reopen through the app bridge and reconcile their receipts.
3. Exercise fullscreen and PiP controls and retain the host's granted, denied,
   fallback, or unsupported outcomes while proving inline remains usable.
4. Restart the real Codex application and reopen the historical message without
   recompiling or rebinding.
5. Record and independently review the uncut run and derived release media.
6. Repeat with the frozen matched evaluation and compare quality, latency,
   token use, and cost against stock Codex.
