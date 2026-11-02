# Fresh candidate `f` routing diagnostic — 2026-08-02

## Claim boundary

`local-live-smoke`, run through a fresh headless Codex task. This diagnostic
shows that installed candidate `f` naturally selected Marshal from a nearby,
noncanonical product request; authored and ran bounded TypeScript delegation;
created editable backend and React source; persisted project state; compiled
and bound one adaptive application; and invoked its generated render tool.

This is **not** the frozen design-studio capstone, a matched stock-versus-Marshal
evaluation, or desktop-pixel evidence. The task ran through `codex exec`, the
prompt intentionally differs from the canonical prompt with SHA-256
`c9b0e64795a9f63668ec51b816dcebafe79cea2ca6b4c95b8a68a13cb41ed80a`,
and the headless client returned the application's text fallback rather than
evidence of visible pixels or user interaction. No declared app action,
fullscreen/PiP request, restart reopen, or historical-message reopen was
exercised.

Candidate identity and post-restart activation are recorded separately in
[the candidate `f` activation evidence](candidate-f-activation-2026-08-02.md).

## Fresh task and frozen inputs

The task used an otherwise clean workspace containing only the two checked-in
`fixture://product-design-brief` files before execution. The fixture identity in
`docs/evals/fixtures/offline-v1/manifest.json` is
`b0a9fbc0931536c840d2f3c3763ca5f77354f6d3be11cc3deb7eabfac32d8d49`.

| Input | Bytes | SHA-256 |
| --- | ---: | --- |
| `brief.md` | 342 | `899B1DF9571DCB816970528B4310B8CA04E9012B458790EF99E0B51FD9A23E81` |
| `design-system.json` | 307 | `A070D983D816C19EBA4067903D8D77E8AF62F6A4F6A763D12B846F47BD0A6845` |

The exact diagnostic prompt was:

> Create a polished interactive workspace I can use here to explore the
> supplied product brief through four genuinely different interface
> directions. Compare them, let me choose and refine one directly, apply the
> supplied design system, inspect desktop and mobile states, and preserve
> editable source plus saved state so I can continue later. Work autonomously
> and use parallel specialist input where it materially improves the result.

Its 433 UTF-8 bytes have SHA-256
`4F757CF9ABF75421C01B3B0F00C9EE57420CC1648C043EF3DE5FD2EAE5623C91`.
The prompt does not name Marshal, TypeScript, MCP, MCP Apps, or subagents, but
it does explicitly request parallel specialist input. That makes this useful
routing evidence, not a substitute for the stricter canonical prompt.

The retained task metadata is:

- session ID: `019fc3f8-b54a-70c2-9830-c36ce25507a0`;
- session alias:
  `%USERPROFILE%\.codex\sessions\2026\08\02\rollout-2026-08-02T22-34-44-019fc3f8-b54a-70c2-9830-c36ce25507a0.jsonl`;
- session bytes: 2,039,407;
- session SHA-256:
  `C0CBD7AE8CBAFA836E6196F5465B1317B539DF71C64761192381D73B183C710E`;
- Codex CLI `0.144.6`, model `gpt-5.6-sol`, reasoning effort `medium`;
- source `exec`, thread source `user`, approval policy `never`, and
  `danger-full-access` sandbox policy.

Those execution settings identify this diagnostic. They are not the frozen
matched-evaluation configuration or a recommended release security boundary.

## Timeline

All timestamps are UTC. Latencies are measured from the user prompt at
`2026-08-02T19:34:47.272Z`.

| Event | Timestamp | Latency |
| --- | --- | ---: |
| Codex explicitly selected Marshal in commentary | `2026-08-02T19:34:53.836Z` | 6,564 ms |
| Editable orchestration module started | `2026-08-02T19:36:18.804Z` | 91,532 ms |
| Three-specialist orchestration module completed | `2026-08-02T19:36:58.186Z` | 130,914 ms |
| Final frontend/backend patch completed | `2026-08-02T19:40:19.256Z` | 331,984 ms |
| Project artifact write completed | `2026-08-02T19:40:43.434Z` | 356,162 ms |
| TSX compile completed | `2026-08-02T19:40:43.981Z` | 356,709 ms |
| Immutable render created | `2026-08-02T19:40:59.401Z` | 372,129 ms |
| Generated render tool returned its fallback | `2026-08-02T19:41:05.297Z` | 378,025 ms |
| Task completed | `2026-08-02T19:41:35.804Z` | 408,532 ms |

The complete task took 6 minutes 48.532 seconds from prompt to task-complete
(6 minutes 51.139 seconds from session start). Approximately 201.1 seconds
elapsed between delegation completion and the final source patch, so the main
latency concentration was final source generation rather than the 39.382-second
specialist module.

## Editable TypeScript orchestration

Codex discovered delegation and UI schemas using summary searches followed by
exact full-schema resolution. Before authoring the final TSX, it created and
ran `orchestration/review-directions.ts` as a workspace-backed module. The
module used `Promise.all` to spawn three distinct native specialists:

- `calm-launch-ia-reviewer`;
- `calm-launch-responsive-reviewer`;
- `calm-launch-visual-reviewer`.

Each child declared `maxDepth: 1`, `maxAgents: 1`, `maxConcurrency: 1`,
`timeoutMs: 90000`, `maxRetries: 0`, and empty permissions/effects. The module
then performed one `mode: "all"` wait with a 120,000 ms nested timeout; the
outer editable-module call used 150,000 ms. All three durable delegation
records ended `succeeded`.

| Operation | Receipt | Duration | Status |
| --- | --- | ---: | --- |
| specialist spawn | `receipt-msc7aztg-1d-mjuhlkpd` | 958 ms | success |
| specialist spawn | `receipt-msc7aztr-1f-aol95hd6` | 967 ms | success |
| specialist spawn | `receipt-msc7azu0-1h-lpakjz8a` | 977 ms | success |
| wait for all three | `receipt-msc7btbw-1l-vbluy7vo` | 38,225 ms | success |
| complete editable module | `receipt-msc7btca-1n-pfle6vuo` | 39,382 ms | success |

The session subsequently stated a concrete synthesis—Steward Board as the
operational default, Horizon as the responsive baseline, and an equivalent
mobile list for Constellation—and the authored interface implements those
choices. This is a useful single-run synthesis observation. It does not prove
recursive delegation, cancellation, duplicate delivery, token/cost controls,
or a general orchestration-quality improvement.

## Persistent application result

Codex authored separate editable frontend, backend, and orchestration files.
It wrote a 1,360-byte authoritative project artifact at
`calm-launch/workspace-state.json`; receipt
`receipt-msc7gn56-1s-zzuukisr` completed successfully in 8 ms with the
`artifacts.write` grant.

`ui.compile` selected authoring profile `openai-apps-sdk-ui@1.0.0` and returned:

- component ID
  `11484dd8d5c7f94b589cb810479c8b6bf068111e4de9fef24cac5321172bf804`;
- source digest
  `dac02e7f5e02103a6224f8a8689c87817a210aa6c08a862226170346a4e18aae`;
- bundle digest
  `dbb5fb03c1d554e61002b5eccea34cb2852bd643fb95a059b051a898973f9f13`;
- HTML digest
  `aeff6275a427a8542b107834910799b6ed83b38d2d71b95e6c1117af908fbaa8`;
- receipt `receipt-msc7gnkd-1x-f7veoqn9`, successful in 189 ms with
  the `trusted_ui` grant.

`ui.render` created immutable render
`23ed2e7276a744d0324b382686a227f9655e91ac11dfc450ad2331e9fe895398`
for that component. Receipt `receipt-msc7gzgp-22-abmr9vw8` completed
successfully in 49 ms. Its application manifest declares:

- presentation modes `inline`, `fullscreen`, and `pip`;
- project-local state schema `1.0.0`;
- authoritative state at `calm-launch/workspace-state.json`;
- `save-workspace`, backed by editable `state-actions.ts#saveWorkspace`, with
  `runtime.module.execute` and `artifacts.write` permissions;
- `load-workspace`, backed by editable `state-actions.ts#loadWorkspace`, with
  `runtime.module.execute` and `artifacts.read` permissions; and
- no direct app-visible tools.

The task invoked the generated render through `runtime_render_component` once.
In this headless client, the returned content was the complete text fallback.
That proves successful binding and fallback delivery, not an embedded Codex
component, visual quality, host mode negotiation, or action clicks.

## Retained identities

All workspace paths below are relative to the diagnostic workspace alias
`%USERPROFILE%\.codex\marshal-capstone-f-routing-diagnostic-20260802`.

| Item | Bytes | SHA-256 |
| --- | ---: | --- |
| `orchestration/review-directions.ts` | 3,645 | `A39D7D188F614F86605ECF61DD51379B98BC14ABD5009DD60B410D85D45EE0B8` |
| `state-actions.ts` | 1,058 | `0358DC224DA1EC84D2FD6E361FA11CBDB1C7C78F46A959046AD6DB64ADE382D1` |
| `calm-launch-workspace.tsx` | 29,277 | `DAC02E7F5E02103A6224F8A8689C87817A210AA6C08A862226170346A4E18AAE` |
| `README.md` | 1,022 | `1FF456778DEF70E1028A7C68173DF4DA025D6EAAF86B3550EF36825771BCEB5A` |
| authoritative `workspace-state.json` | 1,360 | `909F6275AA96DE4AE648C622DCC7C12BD9E9AD6BD3713B900CC53EC2000252C9` |
| receipt ledger `executions.jsonl` | 22,525 | `B0FC1CBCF81B3C262BC24E0240EE43CF1460C1EFE2BEEBE71AB7594ECFFF44E9` |
| IA durable delegation record | 7,525 | `1A0D9737BCAA7DCF04C9E7269E19A9DEDD089F52A01476FA2E008984AC432DDA` |
| responsive durable delegation record | 6,770 | `A99F1951F8A417E901E4374C1A0AC4B3A1BFBDA60598E4F079ADD9BDC7E9CFE0` |
| visual durable delegation record | 6,860 | `F507942D7E15849F19915A81616EF81296333DCB147B4D4B0FEE243BCB07BE34` |

The TSX file hash exactly matches the compile receipt's source digest after
case normalization.

## What remains unproven

- the exact canonical fresh-session prompt and its full refinement/restart
  sequence;
- autonomous delegation selection from a prompt that does not request parallel
  specialist input;
- actual Codex desktop pixels, action clicks, fullscreen/PiP outcomes, and
  historical-message recovery;
- execution of either declared backend action from the application;
- recursive/cancellation/duplicate-delivery orchestration behavior in this
  task;
- matched baseline quality, latency, tokens, cost, or statistical improvement;
- reviewed uncut media and a publication-ready Marshal 1.0 claim.
