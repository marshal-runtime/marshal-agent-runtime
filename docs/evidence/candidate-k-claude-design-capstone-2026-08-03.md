# Candidate `k` fresh Claude Design-class capstone

Date: 2026-08-03

Evidence class: local-live-smoke, partial Codex-host evidence

Codex thread: `019fc71a-60c3-78d1-9de1-094a570e2000` (`local`)

Model: `gpt-5.6-sol`, medium reasoning, default service tier

Installed plugin: `marshal-runtime@personal`
`0.1.0+codex.20260803092351`

Workspace:
`C:\Users\admin\Documents\Codex\2026-08-03\marshal-k-claude-design-capstone`

This run covers the exact frozen build and refinement prompts plus a separate
save/read verification turn. Candidate `k` autonomously selected Marshal,
authored and ran bounded TypeScript orchestration over three real Codex
children, produced separate editable backend and React source, displayed one
compiled application, and refined only the React source. The refinement also
exposed a serious file-replacement failure, and the save/read turn bypassed the
declared application-action bridge. This is therefore **not** a complete
capstone or release pass.

## Frozen inputs and timings

The projectless task received each prompt in the normal
`<codex_delegation>` envelope. Hashes below cover the inner prompt text only.

| Phase | SHA-256 | Task timing |
| --- | --- | ---: |
| Build | `c9b0e64795a9f63668ec51b816dcebafe79cea2ca6b4c95b8a68a13cb41ed80a` | 362.548 s |
| Refinement | `885b396115fc6a15ea95eb24e56f5c81fcf38a6d96ea6ad27f3f0e22bf0ec9bc` | 315.393 s |
| Save/read verification | `26c8d6b6a4df707c7a3a1dab073772e381998c77f2eaa8b7533371edf4153fb0` | 57.220 s |

The build prompt matches the canonical frozen hash exactly. It does not name
Marshal, TypeScript, MCP Apps, workflows, or subagents. The task selected the
installed Marshal skill in its first commentary 3.407 seconds after the user
event and did not select the generic visualization skill.

Candidate `j` completed the same build in 345.971 seconds and the same
refinement in 243.397 seconds. Candidate `k` was therefore about 4.8% slower on
the build and 29.6% slower on the refinement. Marshal's measured operations
were short; model generation and the refinement recovery dominated latency.

## Build trace

The task read the installed Marshal and React authoring contracts, made 15
`runtime_search` calls, resolved the selected capabilities, and authored:

- `work/design-orchestrator.ts`;
- `outputs/foundry-workspace/backend.ts`;
- `outputs/foundry-workspace/FoundryWorkspace.tsx`.

The editable orchestrator used `Promise.all` to start three
`runtime.delegation.spawn` calls and one `runtime.delegation.wait`. The three
durable records were created within 37 milliseconds and all reached terminal
success:

| Specialist | Child thread | Duration |
| --- | --- | ---: |
| Editorial director | `019fc71b-819d-7342-a778-2ba734a5d741` | 20.819 s |
| Systems director | `019fc71b-815e-79f2-8e69-3de2e01fbac4` | 20.736 s |
| Spatial director | `019fc71b-81fb-7c63-919f-03858fc1ff32` | 26.549 s |

Each authored request used an idempotency key, `maxDepth: 0`, `maxTurns: 1`,
`maxTokens: 3500`, `timeoutMs: 45000`, `retryAttempt: 0`, and empty tools,
permissions, and effects. The enclosing editable module used a 90-second
timeout, above its 60-second wait. Its durable runtime record additionally
captured the installed root policy: `maxTotalAgents: 16`,
`maxConcurrency: 4`, and `maxRetries: 1`.

Those names must not be conflated. The module's returned `maxAgents: 3` and
`concurrency: 3` values are descriptive result fields, not accepted spawn-limit
aliases. The three-child fan-out and observed overlap prove concurrency for
this run, while the durable root-policy fields prove the installed broker caps.
Also, the Codex adapter advertised `tokenUsage: false` and `costUsage: false`.
The `maxTokens` request is retained and forwarded, but this run does not prove
runtime-measured token or cost enforcement.

Important execution receipts:

| Operation | Receipt | Duration |
| --- | --- | ---: |
| Delegation wait | `receipt-msd2l6wd-1i-k0cucxfr` | 26,796 ms |
| Editable orchestration module | `receipt-msd2l6wx-1k-az3fbo7a` | 28,205 ms |
| Initial compile | `receipt-msd2q5fc-1u-ingjpdff` | 243 ms |
| Initial render | `receipt-msd2qj7l-1z-m8ilnu0c` | 53 ms |

The first version compiled once, created one render, and called
`runtime_render_component` once in 41.6 ms. It used:

- source digest:
  `21082ef955a899e2f4671d8d4f2b89fba77b8e3ce7f6578dcf657274bc8e26d4`;
- component ID:
  `65a34c7fea9341e943df122c2651c6b29e450eaf6ca8e48094d7d816f185b5f2`;
- render ID:
  `8d745857feed0b41bf762ee0dc50071ab434d0984465534a69e79288967b7bdd`.

The render returned a complete structured fallback and the stable MCP Apps
runtime resource. This proves a validated application binding on the first
display attempt. The rollout alone does not prove successful desktop pixels or
human interaction inside the mounted iframe.

## Authored application

The source contains three visually and structurally distinct directions,
side-by-side comparison and focus, direction selection, editable brief and
canvas copy, inspector controls, local conversational refinement, design-token
application, and desktop/tablet/mobile inspection. The application manifest
declares:

- inline, fullscreen, and PiP presentation modes;
- project-scoped state;
- separate `save-workspace` and `load-workspace` module actions;
- the `openai-apps-sdk-ui@1.0.0` adaptive authoring profile;
- complete fallback summary and details.

The React source calls the two declared actions, subscribes to host-context
changes, feature-detects display modes, and handles typed display-mode results.
However, its fullscreen and PiP controls are icon-only, and the CSS hides both
with `.top-actions .icon-btn { display: none }` below 680 CSS pixels. The same
breakpoint removes the visible `Reopen` text. That violates Candidate `k`'s
visible-named-control and no-silent-removal contract even though accessible
names remain in the DOM.

## Same-task refinement and recovery failure

The exact refinement turn made zero capability searches, executed no
orchestration module, and spawned no child. The orchestrator and backend hashes
remained unchanged. The final TSX keeps only Direction B (`Folio`), calms its
headline, navigation, supporting copy, and primary action, and defaults to a
linked desktop/mobile pair.

The intended targeted edit did not complete cleanly. The first large
`apply_patch` call failed to write and left `FoundryWorkspace.tsx` at zero
bytes. The file remained empty for approximately 3 minutes 23 seconds. The
task then extracted the original `Add File` patch text from its rollout,
reapplied the requested replacements, deleted the empty file, and recreated
it. Commentary initially described this as recovery from the runtime component
cache, but the trace shows that the successful recovery source was the rollout
patch text.

The recovered source compiled successfully. The refinement performed exactly
one new compile, one new render, and one display:

| Operation | Receipt | Duration |
| --- | --- | ---: |
| Refined compile | `receipt-msd30spg-29-tymbfyjs` | 246 ms |
| Refined render | `receipt-msd317ug-2e-rx1svd7j` | 70 ms |
| Cached display | no execution receipt | 56.6 ms |

Refined identifiers:

- source digest:
  `a0707fb7875dd9968f3e19a9262fe98371dbf3e02e411bcb715085ed81036d33`;
- component ID:
  `ac06d8b0764d49b1dfb4cda29113165b9d538b8f8d62b9255c531522b3c1f259`;
- render ID:
  `e5895427a703e5bc042837fd93e6abf0642f932d3035e53ba1b1926494d55d50`.

The final source is intact, but temporarily destroying the only editable source
during a routine refinement is a release-blocking failure mode. Cumulative
thread usage increased from 841,878 tokens after the build to 2,854,873 after
the refinement, largely because recovery repeatedly reread large trace/source
payloads.

## Save/read verification is not app-action evidence

The third prompt asked the task to save and reopen the refined workspace
without rebuilding. The task discovered that the already-rendered app's button
actions were not exposed as a callable model tool. It therefore did **not**
invoke the declared `save-workspace` or `load-workspace` actions, did not execute
`backend.ts`, and did not produce an application `action-results` record.

Instead, the task manually reconstructed the refined default state from source,
called `artifacts.write` and `artifacts.read` directly, validated the returned
JSON, and redisplayed the same refined render ID. It made no source edit,
compile, render binding, or delegation call.

| Direct operation | Receipt | Duration |
| --- | --- | ---: |
| `artifacts.write` | `receipt-msd34tnm-2k-ppr2vg0k` | 18 ms |
| `artifacts.read` | `receipt-msd34to6-2p-6p4j9hdo` | 4 ms |

The 1,129-byte artifact contains exactly one active `Folio` direction, the
headline `Plan clearly. Move together.`, CTA `Start planning`, two-item
navigation, `mobilePreview: true`, and base viewport `desktop`. This proves a
project-scoped direct artifact round trip. It does **not** prove that the live
React client state was captured, either declared backend action ran, either
visible button invoked the app bridge, or `Reopen` restored the mounted UI.

## Pass/fail matrix

| Requirement | Result |
| --- | --- |
| Exact implicit routing | Pass |
| Editable bounded TypeScript orchestration | Pass, with token/cost enforcement caveat |
| Three useful parallel native children | Pass |
| Separate backend and TSX | Pass |
| One initial compile/render/display | Pass |
| Substantial interactive design surface | Pass by source and binding trace |
| Targeted same-task refinement | Pass after a destructive recovery incident |
| Direct project-scoped artifact round trip | Pass |
| Declared Save/Reopen app-action bridge | Not exercised |
| Visible Fullscreen/PiP controls at every width | Fail |
| Desktop pixels and user interaction | Not captured |
| Real host-restart restoration | Not run |
| Uncut media and independent review | Not run |

## Frozen evidence pointers

- Rollout:
  `C:\Users\admin\.codex\sessions\2026\08\03\rollout-2026-08-03T13-10-22-019fc71a-60c3-78d1-9de1-094a570e2000.jsonl`
  (960,957-byte shared-read snapshot; SHA-256
  `81DBBA2C10C88CEE04E29CE207A70F53939B617B14FA118FDA8037716C8EBB3B`)
- Receipts:
  `C:\Users\admin\Documents\Codex\2026-08-03\marshal-k-claude-design-capstone\.marshal\runtime\receipts\executions.jsonl`
  (30,267 bytes; SHA-256
  `F5524B2761C2DB1CBE41DBE82D57EE79EA7F57B2B1122D1BA3E21AA2878907CB`)
- Orchestrator SHA-256:
  `1720101F7FB23A50FA319DB212A8C25D833F37014747F213CBD6D082E4A2F7D5`
- Backend SHA-256:
  `B9028B9A69E10CD480C45F5529E7BBB7E199561A39AC021F6473BFE2242154C8`
- Refined TSX SHA-256:
  `A0707FB7875DD9968F3E19A9262FE98371DBF3E02E411BCB715085ED81036D33`
- Direct artifact SHA-256:
  `4F83224674933A0B07E2537E1F3D295CCF347CFF32FCC8BD6B66266CCF901F1A`

These paths remain local audit material. They require redaction, frozen copies,
uncut capture, and independent review before supporting a publication claim.
