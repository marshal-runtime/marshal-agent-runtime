# Marshal evidence index

This directory indexes observed evidence without turning development smokes,
deterministic tests, or generated fixtures into release claims. The governing
acceptance criteria are in [`marshal-1.0-goal.md`](../marshal-1.0-goal.md), and
the remaining gates are tracked in
[`publication-checklist.md`](../publication-checklist.md).

## Evidence classes

| Class | What it can establish | What it cannot establish |
| --- | --- | --- |
| `deterministic` | A bounded implementation path passed a repeatable local test or benchmark | Autonomous model choice or host pixels |
| `local-live-smoke` | A named installed-host task exhibited the recorded behavior | Statistical improvement, cross-platform support, or release readiness |
| `uncut-live` | A continuous reviewed recording matches its trace, receipts, inputs, and source | Generality beyond the named host/configuration |
| `paired-evaluation` | Repeated stock-versus-Marshal attempts under a frozen matched configuration | Capabilities outside the evaluated corpus |
| `generated-fixture` | Schemas, layouts, and fallbacks can be rehearsed deterministically | A host, model, agent, tool, or visual event actually occurred |

Only `uncut-live` evidence that passes the capture verifier and independent
review may back a published visual claim. Release performance claims also need
raw benchmark data; model-quality claims need the frozen paired evaluation.

## Recorded local evidence

| Date | Evidence | Class | Observed | Release caveat |
| --- | --- | --- | --- | --- |
| 2026-08-03 | [Candidate `m` current-source release-gate audit](candidate-m-release-gates-current-source-2026-08-03.md) | deterministic and unavailable-evidence preflight | Frozen evals passed 65/65, portable conformance passed 6/6, publication/release/package gates passed, and a clean replacement full-corpus preflight produced 108/108 unique model-disabled records; the audit also found and fixed concurrent eval-writer duplication with an exclusive lock and guarded recovery only for a definitely dead PID | The repository was dirty and every matched attempt was intentionally unavailable. Candidate M live acceptance, 108 live matched attempts, release confinement/authorization, desktop evidence, registry matrix, reviewed media, and independent reviews remain open |
| 2026-08-03 | [Candidate `k` fresh Claude Design-class capstone](candidate-k-claude-design-capstone-2026-08-03.md) | local-live-smoke, partial Codex-host evidence | The exact frozen prompt autonomously selected Marshal in 3.407 s, authored editable orchestration/backend/React, completed three concurrent real Codex specialists, compiled/rendered/displayed once, and made a TSX-only canonical refinement | The build took 6m02.548s; refinement took 5m15.393s and temporarily destroyed the TSX for about 3m23s before rollout-based recovery. Fullscreen/PiP controls disappear below 680px. The later save/read proof bypassed declared app actions, and pixels, UI clicks, restart restore, uncut media, and review remain open |
| 2026-08-03 | [Candidate `j` fresh Claude Design-class capstone](candidate-j-claude-design-capstone-2026-08-03.md) | local-live-smoke, partial Codex-host evidence | The exact frozen implicit prompt autonomously selected Marshal, authored editable orchestration/backend/React, completed three genuine native Codex specialists at peak concurrency three, compiled and rendered once, then applied a same-task source-only mobile/hierarchy refinement without rerunning orchestration; Candidate `j` kept each public render result below 3,200 characters | The build took 5m45.971s and refinement 4m03.397s. A later initial-render Save produced a real action receipt, but it saved pre-refinement state; no latest-state Save or Reopen receipt exists. A fullscreen-looking screenshot lacks a durable typed outcome, PiP has no control, and restart recovery, uncut recording, and publication review remain open |
| 2026-08-03 | [Candidate `j` frozen matched-evaluation preflight](matched-evaluation-candidate-j-preflight-2026-08-03.md) | deterministic, unavailable-evidence | From clean commit `ef9f6a4`, Candidate `j` was hash-pinned as the only treatment difference; all 108 frozen attempts were planned and published in identical randomized order with 54 attempts per arm, three repetitions, zero missing/unexpected attempts, and 59/59 evaluation tests passing | All attempts intentionally made zero model calls and remained excluded: 78 by the model-invocation latch and 30 by the missing desktop-host boundary. No operator authorization or release confinement exists, and no stock-quality/statistical claim is made |
| 2026-08-03 | [Current-source standards-only MCP Apps host, candidate `j` preinstall](standards-host-candidate-j-preinstall-2026-08-03.md) | automated-local-live-standards-host | The current built UI package passed the verified named-host run in 7.224 s: a 2,453-byte public render hydrated through the app-only 1,165,033-byte payload, inline/action/fullscreen/remount/fallback/restart pixels were retained, PiP was truthfully unsupported, and restart restored the same render plus `Direction B` with zero compile/render calls | External bundle: `C:\tmp\marshal-standards-host-candidate-j-preinstall-20260803T1052`; report SHA-256 `C094ED299FA842AB455BFB1A8733F5C40E3A06BACBED76EED6FAEFAB6210CE1A`. CDP DOM activation is not human input, and there is no uncut recording or independent review, so `publicationClaimEligible` is `false` and Codex desktop remains unproven |
| 2026-08-03 | [Current-source 100,000-memory deterministic acceptance benchmark](capacity-current-source-2026-08-03.md) | deterministic | The unchanged full configuration passed 10/10 gates: Recall@5 and nDCG@5 1.000, zero irrelevant results, memory p95s below 9 ms, uncached/cached TypeScript p95s 133.644/66.171 ms with 40/40 valid executions and 20 verified cache hits, and UI-action dispatch overhead p95 0.053 ms | One dirty-worktree Windows run without a raw checked-in report; the first attempt hit transient disk exhaustion, and the successful retry is not Luna/model, hook, live Codex, host-pixel, matched-evaluation, or cross-platform evidence |
| 2026-08-03 | [Standards-only MCP Apps host example](../../examples/standards-mcp-apps-host/README.md), hardened attempt `standards-host-security-20260803-k` | local-live-smoke, automated | A named harness-neutral local host consumed installed `@marshal/agent-runtime-ui` and passed all 10 report gates: the `local-request-boundary` gate, eight live browser PNGs covering action/host-context/mode/fallback/remount/restart behavior, and complete fallback. The host rejected seven forged `/tool` or `/event` requests without mutating state and accepted a correctly protected declared-tool call; the focused adversarial suite passed 3/3 and the portable conformance suite remains 6/6 | The immutable bundle is external at `C:\tmp\marshal-standards-host-security-run-20260803k`; `report.json` SHA-256 is `61fc5ab3c85629fcc8b8b1e9a2a6a4d477dea81f4cd8382c317f2388df44e918`. Activations were deterministic CDP DOM dispatch, not human pointer input; there is no uncut video or independent human review, so `publicationClaimEligible` remains `false`. PiP support was not observed |
| 2026-08-02 | [Candidate `f` activation and post-restart regression](candidate-f-activation-2026-08-02.md) | local-live-smoke plus deterministic package evidence | The 21-archive detached candidate passed its generic MCP smoke, installed as personal plugin `0.1.0+codex.20260802191116` with source/cache hash equality, survived a real Codex restart, exposed the compact tool surface, reopened the existing React render, and returned a schema-valid malformed-state error | No desktop clicks or pixels, canonical fresh-session capstone, matched evaluation, registry publication, or release claim |
| 2026-08-02 | [Fresh candidate `f` routing diagnostic](fresh-candidate-f-routing-diagnostic-2026-08-02.md) | local-live-smoke, headless and noncanonical | A fresh task selected Marshal in 6.564 s without naming it, authored one editable TypeScript module, completed three distinct bounded native specialists, wrote editable backend/React source and project state, compiled and bound one inline/fullscreen/PiP application, and returned its complete fallback; task-complete arrived in 6m48.532s | The prompt requested parallel specialist input and differs from the frozen canonical prompt; headless fallback is not desktop pixels, app-action clicks, mode outcomes, restart recovery, matched evaluation, or a capstone pass |
| 2026-08-02 | [Candidate `e` runtime-backed React and restart recovery](ui-conformance-candidate-e-2026-08-02.md) | local-live-smoke plus deterministic recovery | One editable React app used a startup-registered bridge for an idempotent TypeScript action, a capability action, a declared tool, project state, and an authoritative artifact; after a real Codex process restart the same immutable render reopened in 132 ms, and all 19 recovery checks passed | Bridge calls are not visible user clicks; pixels, fullscreen/PiP host outcomes, historical-message inspection, and uncut reviewed media remain required |
| 2026-08-02 | [Windows Node 22/24 file identity](windows-node-file-identity-2026-08-02.md) | deterministic | Across 3,000 stable files per runtime, Node 22.13.0 differed only by pathname `dev=0` versus descriptor `dev=3700311042`; Node 24.14.0 had no differences, and replacement changed inode in 250/250 attempts on both | One Windows x64 environment; symbolic-link creation was denied, concurrent races are bounded samples, and this does not establish full Node 22 or release compatibility |
| 2026-08-02 | [Ubuntu 24 committed-source final candidate](linux-ubuntu24-final-candidate-2026-08-02.md) | deterministic | Exact committed archives built on Ubuntu 24/glibc 2.39/Node 24, the leaf passed its packed consumer, and a network-disabled frozen reinstall reused 613/613 packages with zero downloads before a real composed-kernel smoke | Ubuntu 24 x64 and local package archives only; not ARM64, Linux pixels, registry publication, or a complete OS/Node matrix |
| 2026-08-02 | [Warm Luna production adapter probe](warm-luna-appserver-adapter-probe-2026-08-02.md) | local-live-smoke | Eight exact two-round canary pairs passed across low/none efforts with isolated warm threads, usage capture, no dynamic tools, and no real memory writes | Two singles plus two three-sample Windows sets; both named warm p95 values miss 2.5 s, and no real Brain quality, durable-job, cross-host, or release-p95 claim is proven |
| 2026-08-02 | [Warm Luna Brain app-server probe](warm-luna-brain-probe-2026-08-02.md) | local-live-smoke | A persistent authenticated Codex app-server reused one Luna thread; the second memory turn completed in 1.406–2.175 seconds and correctly recalled the prior fact | Two non-randomized samples without dynamic Brain tools, tokens, durable jobs, isolation, or release-grade p95 evidence |
| 2026-08-02 | [Post-restart installed-candidate smokes](post-restart-installed-smokes-2026-08-02.md) | local-live-smoke, partial | Historical candidate `d` completed two exact semantic Brain store/recall pairs and exposed a retry race; active candidate `e` then completed three concurrent remember calls through one job per label, including two successful second attempts, and exactly recalled an SQLite-authoritative value; the earlier editable-TypeScript, negative-control, and bounded five-agent smokes remain recorded | Candidate `e`'s brokered run took about 20.5 seconds and recall took 8.631 seconds; the artifact reopen is rejected; a diagnostic delegation rerun consumed a second complete five-agent wave; no complete memory corpus, desktop UI, matched-eval, or release claim is proven |
| 2026-08-01 | [Superseded compatibility-hook cross-task memory](automatic-memory-2026-08-01.md) | historical-local-live-smoke | One explicit write and one fresh unrelated-task recall completed on the now-disabled deterministic fallback; the earlier failed injection attempt is retained | Not current-architecture evidence; one pair, no frozen corpus or repetitions |
| 2026-08-01 | [Implicit TypeScript routing](fresh-session-routing-2026-08-01.md) | local-live-smoke | One indirect reusable-module prompt selected Marshal and executed in 338 ms; one simple arithmetic negative control avoided Marshal | Not a randomized stock-versus-Marshal evaluation |
| 2026-08-01 | [Design-studio prototype](design-studio-prototype-2026-08-01.md) | local-live-smoke, incomplete | A fresh implicit prompt produced and rendered an editable interactive React workspace in 243,493 ms | It did not meet the delegation, backend-action, presentation-mode, recovery, or uncut-media capstone bar |
| 2026-08-01 | [Design-studio capstone attempt 2](design-studio-capstone-attempt-2-2026-08-01.md) | local-live-smoke, incomplete | A fresh implicit prompt produced editable orchestration/backend/frontend source, a scoped state round trip, and a validated adaptive render | Native delegation failed in the detached package; mode/action/restart interaction and uncut evidence remain absent |
| 2026-08-01 | [Design-studio capstone attempt 3](design-studio-capstone-attempt-3-2026-08-01.md) | local-live-smoke, incomplete | A fresh implicit prompt selected Marshal and the broad-then-exact discovery strategy immediately | A projection/schema vocabulary mismatch plus missing noninteractive approval configuration prevented runtime execution; no source or UI was produced |
| 2026-08-01 | [Design-studio capstone attempt 4](design-studio-capstone-attempt-4-2026-08-01.md) | local-live-smoke, incomplete | A fresh implicit prompt authored editable orchestration/backend/React, completed four concurrent native agents, round-tripped durable state, and rendered an honest declarative fallback | The installed bounded-agentic profile denied authored React; live actions, modes, restart recovery, and uncut media remain absent |
| 2026-08-01 | [Design-studio capstone attempt 5](design-studio-capstone-attempt-5-2026-08-01.md) | local-live-smoke, interrupted | A fresh implicit prompt selected Marshal in 6.3 seconds, preserved editable TypeScript orchestration, and completed a final set of four bounded native design critiques | The stream ended after about 10m50s before state persistence or any frontend authoring, compile, render, interaction, recovery, or media evidence; this is not a capstone pass |
| 2026-08-01 | [Design-studio capstone attempt 6](design-studio-capstone-attempt-6-2026-08-01.md) | local-live-smoke plus deterministic recovery | The unchanged implicit prompt selected Marshal in 7.5 seconds, completed editable orchestration/frontend/state, eight bounded reviewer runs across two four-root passes, authoritative persistence, one immutable render, and a two-runtime recovery probe | The run took 17m9s and duplicated the four reviews; desktop pixels, app-action clicks, host mode outcomes, real Codex restart recovery, uncut media, and matched baseline remain unverified |
| 2026-08-01 | [Installed native delegation](native-delegation-installed-smoke-2026-08-01.md) | local-live-smoke | Detached candidate `h` completed exact discovery and a real Codex child spawn/wait with durable receipts under the bounded-agentic profile | One child only; not recursive/capacity/capstone or matched-evaluation evidence |
| 2026-08-01 | [Installed adaptive-agentic profile](installed-adaptive-agentic-2026-08-01.md) | local-live-smoke | Detached candidate `o` generated a pinned least-authority plugin, compiled authored React with exactly `trusted_ui`, and denied trusted Node from an unrelated workspace | No desktop pixels, live actions, modes, restart recovery, or matched evaluation |
| 2026-08-01 | [Codex desktop UI release-gate audit](codex-desktop-ui-gate-2026-08-01.md) | deterministic | Shared conformance now invokes declared actions and direct tools, exercises mode outcomes, and a two-runtime probe verifies immutable render/state recovery without UI-state writes | Actual Codex pixels, clicks, host mode outcomes, and a real application restart remain live evidence |
| 2026-08-01 | [Linux/WSL2 detached package](linux-wsl2-detached-2026-08-01.md) | deterministic | A Linux-local Node 24 deployment passed generic MCP restart/memory/receipt/UI isolation, host, adapter, conformance, plugin-generation, and 20-package tarball checks without the Windows global install | WSL2/root user and local stdio only; no Linux pixels, HTTP host, paid subagent run, ARM64, or published registry artifact |
| 2026-08-01 | [Codex release candidate q](release-candidate-q-2026-08-01.md) | deterministic plus local-live-smoke, historical | The fully integrated detached candidate passed repository, eval-contract, package, offline-publication, least-authority UI, and one-child native Codex delegation checks; it was the active personal plugin during this observation | Superseded by deployment `20260802a`; actual desktop clicks/modes/restart, matched paid evals, reviewed media, registry publication, and independent reviews remain open |
| 2026-08-01 | [Codex release candidate r](release-candidate-r-2026-08-01.md) | deterministic plus local-live-smoke, historical | The verified tree passed strict output-schema enforcement for 65 capabilities, portable scheduling, repository/release gates, adaptive UI, native delegation, and detached scheduling smokes; its plugin bytes matched the installed cache during this observation | Superseded by deployment `20260802a`; Codex desktop restart/fresh task, pixels and controls, matched paid evals, reviewed media, registry publication, and independent reviews remain open |
| 2026-08-02 | [Fresh installed routing attempt](fresh-installed-routing-attempt-2026-08-02.md) | local-live-smoke, interrupted | A new task selected Marshal immediately for an indirect reusable-transformation prompt | The desktop process still exposed the pre-reinstall plugin cache and lacked the new MCP registration; the manual-client fallback was stopped, so a full desktop restart and new task remain required |
| 2026-08-02 | [Programmable concurrency](programmable-concurrency-2026-08-02.md) | deterministic | One editable TypeScript execution overlapped Brain-like, agent-like, and artifact-like operations with a 178.301 ms critical path versus a 390 ms sequential sum (2.187×), peak concurrency three, and no orphan receipts | Controlled provider fixtures; not a live-model latency, quality, token, or cost claim |
| 2026-08-02 | [Native delegation from final detached candidate](native-delegation-final-candidate-2026-08-02.md) | local-live-smoke | Editable TypeScript discovered the exact schema, launched one real Codex-native child, waited successfully, and recovered the expected marker under bounded-agentic authority | Explicit diagnostic with one child; not implicit routing, multi-agent synthesis, recursion, or matched evaluation |
| 2026-08-02 | [Frozen native-delegation capacity/cancellation fixture](native-delegation-capacity-fixture-2026-08-02.md) | deterministic, input only | Frozen editable TypeScript, exact prompts and bounds, installed-candidate runner, and independent verifier now require 16 completed roots plus a 12-root two-complete/ten-cancel attempt with 28 unique terminal handles and zero orphans | No 28-agent installed-host run, native inventory comparison, or uncut recording has occurred; the manifest explicitly says it is not live evidence |
| 2026-08-02 | [Candidate `e` native-delegation capacity/cancellation](native-delegation-capacity-candidate-e-2026-08-02.md) | local-live-smoke | The frozen TypeScript fixture completed 16 roots, then completed two controls and cancelled ten roots; the independent verifier reconstructed 28 unique terminal handles with zero orphans | Host recursion was truthfully unsupported and covered by deterministic typed-limitation tests; Codex thread inspection stalled, and no uncut desktop capture or matched evaluation occurred |
| 2026-08-02 | [Final-source 100,000-memory capacity benchmark](capacity-final-2026-08-02.md) | deterministic | The final source passed all 10 declared gates: Recall@5 and nDCG@5 1.000, zero irrelevant results, bounded memory/TypeScript/UI p95s, and 40/40 valid TypeScript executions with 20 verified cache-hit receipts | Single local Windows run on a dirty candidate; cached TypeScript p95 was 224.703 ms against a 250 ms target; not model or hook latency |
| 2026-08-02 | [Post-gate exact 100,000-memory rerun](capacity-final-2026-08-02.md#post-gate-exact-rerun) | deterministic | The same full configuration passed 10/10 again after the complete release gate; Recall@5 and nDCG@5 remained 1.000, irrelevant results remained zero, and cached TypeScript p95 was 112.728 ms | A second local Windows run on the same dirty candidate; useful repeat evidence, not an immutable-revision, cross-platform, model, or hook-latency claim |
| 2026-08-02 | [Frozen post-hardening 100,000-memory rerun](capacity-final-2026-08-02.md#frozen-post-hardening-rerun) | deterministic | The exact runtime bytes after stable-file race hardening and the full publication gate passed all 10 gates: Recall@5 and nDCG@5 1.000, zero irrelevant results, cached TypeScript p95 101.295 ms, and UI dispatch p95 0.058 ms | Final pre-commit local Windows capacity evidence; still not a live-model, hook-latency, matched-evaluation, or cross-platform performance claim |
| 2026-08-02 | [Automated agent release-boundary review](agent-release-boundary-review-2026-08-02.md) | deterministic audit, blockers found | Reviewed three-repository authority, package closure, installed launch pins, path/secret leakage, and evidence wording; found immutable-revision, public-path privacy, installed-lock reproducibility, and status-drift blockers | Agent review only; not a human/third-party security, privacy, accessibility, or reproducibility certification |
| 2026-08-01 | [Matched-evaluation readiness](matched-evaluation-readiness-2026-08-01.md) | deterministic | The full frozen 18-case corpus produced all 108 model-disabled/UI-required attempt records with zero tokens, exact fixture hashes, and explicit release blockers | No live model comparison, statistical result, desktop evidence, blind grading, or release claim |

## Deterministic benchmark snapshot

The two checked-in final-source passing reports and the preserved invalid first
attempt are documented in
[the final capacity evidence](capacity-final-2026-08-02.md). The passing raw
report is [`capacity-final-2026-08-02.json`](capacity-final-2026-08-02.json),
SHA-256
`6DD95C746EBF40EFA15AA5FD3EF443EC1365AE79C772D68DDF8DFCAB9BF3EDCA`.
The post-gate raw rerun is
[`capacity-final-post-gate-2026-08-02.json`](capacity-final-post-gate-2026-08-02.json),
SHA-256
`D2FCB77AE3AFA12ADFB09F884741AE605BD56FEDA638EED297B44BEA4479D9F9`.
The frozen post-hardening rerun is
[`capacity-final-frozen-2026-08-02.json`](capacity-final-frozen-2026-08-02.json),
SHA-256
`20360FCF60BFC4D880C277FF3E53781A0C50C060EC985CB77D6D44125D6D3518`.
All ten predeclared thresholds pass in all three. They are deterministic local
Windows runs on the final dirty source candidate, not cross-platform or live
model claims.

### Earlier 2026-08-01 snapshot

The local raw capacity report remains outside the repository pending redaction
and review:

- historical local path alias:
  `%TEMP%\marshal-capacity-fixed-default.json`
- SHA-256: `03F374BAF14B5922FD9EF40675AE86C0C0D77AA57F0A6A92C711FB0CF8F96412`
- environment: Node `v24.14.0`, Windows x64, 8 logical CPUs
- configuration: 100,000 memories, 20 quality queries, 20 cold samples, 20
  warm samples, 20 TypeScript samples, 100 UI-action samples, seed `20260801`

Exact observed results from that report:

| Measure | Observed | Goal threshold | Snapshot result |
| --- | ---: | ---: | --- |
| Memory Recall@5 | 1.000 | at least 0.90 | pass |
| Memory nDCG@5 | 1.000 | at least 0.85 | pass |
| Irrelevant injection | 0% | at most 5% | pass |
| Warm memory store p95 | 8.757 ms | at most 250 ms | pass |
| Warm memory recall p95 | 1.208 ms | at most 250 ms | pass |
| Cold memory store p95 | 33.665 ms | at most 1,000 ms | pass |
| Cold memory recall p95 | 2.003 ms | at most 1,000 ms | pass |
| TypeScript uncached p95 | 257.770 ms | at most 1,000 ms | pass |
| Verified cached TypeScript p95 | 110.324 ms | at most 250 ms | pass |
| UI action dispatch overhead p95 | 0.079 ms | at most 500 ms | pass |

All ten predeclared capacity thresholds pass. The TypeScript cache result is
backed by 20 same-source hit receipts, and all 20 report dependency-graph
validation; 40/40 cold-plus-cached executions returned valid results. The
separate Codex-hook benchmark at
`%TEMP%\marshal-hooks-fixed-default.json`
(SHA-256
`AA4A37C1EE1E7BFC32FCE9B2F17F050504E5F81823CFCD366CF027A3ED783CC9`)
reports 100% subprocess, briefing, explicit-memory receipt, cross-workspace
recall, and repeat-recall rates across five samples with zero diagnostics.
These remain local deterministic performance snapshots, not matched model
quality evidence or a published cross-platform benchmark.

## Evidence still required

- frozen and hashed development and hidden evaluation sets;
- untouched stock-Codex baseline and at least three randomized paired attempts;
- live declared UI action clicks, fullscreen/PiP negotiation, and text fallback;
- host restart and historical-message recovery with no compile or new binding;
- bounded native delegation with cancellation, partial outcomes, and complete
  receipt-tree reconstruction;
- standards-only and Codex host runs of the same conformance scenario;
- the exact canonical fresh-session design-studio capstone, including its
  refinement and restart phases;
- reviewed uncut recordings, GIF previews, MP4 edits, redaction manifests, and
  deterministic evidence indexes;
- published-package and remaining supported OS/Node installation verification.

Use the [capture storyboard](../demo-capture-storyboard.md) and prepare a bundle
outside the repository before recording. The source tree deliberately contains
no claimed live media.

## Active local candidate after the 2026-08-02 UI output-schema remediation

Deployments through `20260802e` and their referenced plugin versions are
historical. The active local deployment is `20260802f`, with personal plugin
cache version `0.1.0+codex.20260802191116`. Candidate verification retained 21
archives, passed a frozen offline install and detached unrelated-workspace MCP
smoke, and installed a source/cache-identical plugin whose MCP server and
GitNexus kernel are pinned to the detached candidate. After a real Codex
restart, the new process discovered the candidate-`f` skill and tools, reopened
the existing immutable React render, and passed the malformed-state
output-schema regression. A subsequent fresh headless candidate-`f` diagnostic
selected Marshal in 6.564 seconds, completed one bounded three-specialist
TypeScript orchestration, and produced editable backend/React source plus an
immutable adaptive render. Candidate `e` remains the named live retry, memory,
UI, and 28-agent evidence boundary. The diagnostic was noncanonical and did not
produce desktop pixels. Registry publication, the complete memory corpus, live
desktop UI, matched evaluation, and Marshal 1.0 completion remain unproven.
