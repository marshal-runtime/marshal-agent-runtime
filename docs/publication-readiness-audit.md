# Marshal 1.0 publication-readiness audit

Audit date: 2026-08-01; installation-status correction: 2026-08-02. Scope:
repository state plus the local evidence indexed
in [`docs/evidence`](evidence/README.md). This audit does not assert that
unchecked live, statistical, review, packaging, or cross-platform work has
occurred.

## Current position

The repository has a substantial portable implementation, detachable Codex
adapter, documentation set, reproducible examples, deterministic conformance
fixtures, and several useful local live smokes. A named standards-only MCP Apps
host now has integrity-checked automated browser evidence for its advertised
modes, action receipt, host context, fallbacks, and restart recovery. It is not
yet publication-ready as Marshal 1.0 because this evidence is not an uncut
human-reviewed capture, the Codex-host UI gates and matched evaluation remain
open, and the complete capstone, published-package matrix, and independent
reviews are not complete.

## Definition-of-done audit

| # | Goal | Current evidence | Status | Remaining release gate |
| ---: | --- | --- | --- | --- |
| 1 | Portable contracts and security boundaries | Architecture, harness contract, security model, threat model, package boundaries, conformance kit, and hardened standards-host attempt `standards-host-security-20260803-k`: its `local-request-boundary` gate plus 3/3 focused adversarial tests prove exact-origin, exact-JSON, same-origin fetch-metadata, and per-host capability-token enforcement without rejected-request mutation | deterministic-ready | Independent security/privacy review and final full-suite result; the local demonstration boundary is not remote authentication or multi-user authorization |
| 2 | Natural and appropriate selection | Indirect installed-host TypeScript selections and simple negative controls, including a post-restart editable-module task; a fresh headless candidate-`f` diagnostic selected Marshal in 6.564 s from a request that named neither Marshal, TypeScript, MCP Apps, nor subagents | local-live-partial | The diagnostic prompt explicitly requested parallel specialist input and was one non-randomized run. Complete the frozen randomized routing corpus, negative controls, and matched repetitions; the semantic-memory trials intentionally constrained the route and do not by themselves prove ambient selection |
| 3 | Scoped Memory Brain | Deterministic queue/worker/semantic-recall tests, production warm-Luna probes, historical candidate-`d` exact pairs/correction, and candidate-`e` live validation in which three concurrent remember calls completed through one durable job per label, including two second attempts, followed by exact SQLite-authoritative recall in 8.631 s | local-live-partial | Run the full correction/isolation/restart/concurrency corpus and release latency samples; candidate `e`'s roughly 20.5 s brokered run is not a warm-p95 sample, and its 8.631 s recall remains above the provisional warm target |
| 4 | General editable TypeScript | Direct examples, brokered composition, source/digest tests, a post-restart installed-host edit/rerun with changed digest and behavior, candidate `e` executing three independent Brain calls concurrently with peak concurrency three, and the fresh candidate-`f` diagnostic naturally authoring separate reusable orchestration/backend TypeScript before its final TSX | local-live-partial | Retained cache-hit benchmark evidence and matched agent-choice evaluation |
| 5 | Every advertised presentation mode | Negotiated contracts and deterministic fallback/conformance; hardened automated standards-host attempt `standards-host-security-20260803-k` passed all 10 report gates, captured inline pixels, granted fullscreen, and retained a typed PiP `unsupported` limitation because that host advertises only inline/fullscreen | local-live-partial | The named standards host now has granted-or-limitation evidence for every mode it handled, but PiP support itself was not observed. Capture Codex outcomes and produce independently reviewed uncut media before publication |
| 6 | Interchangeable UI authoring profiles | Portable/adaptive boundary documented and implemented | deterministic-ready | Live alternate-profile/custom-UI host proof |
| 7 | Declared application actions and tools | Capability/editable-module examples plus action and direct-tool conformance; attempt 6 later invoked its refined render's declared load/save actions through a separate runtime. Standards-host attempt `k` activated its authored action through disclosed CDP DOM-click automation, persisted `Direction B`, recorded receipt `standards-host-action-19`, and accepted a correctly origin/token-bound declared-tool call | local-live-partial | The standards-host action is real automated browser activation, not a human pointer event or Codex-host click. Codex host-originated tool calls, edit/rerun, and independently reviewed uncut interaction evidence remain required |
| 8 | Bounded dynamic native-agent trees | Installed one-child smoke, attempt-6 orchestration, the post-restart five-agent module, and candidate `e`'s frozen capacity run: 16 completed roots plus two completed controls and ten cancelled roots, with 28 unique terminal handles, complete receipt trees, and zero orphans. A fresh candidate-`f` diagnostic also authored one workspace-backed TypeScript module, spawned three distinct bounded specialists concurrently, waited once for all three, and retained three succeeded durable records without a duplicate review wave. The host truthfully advertised recursion unsupported; deterministic tests prove the typed limitation and flattening path | local-live-partial | The candidate-`f` diagnostic did not test recursion, cancellation, duplicate delivery, or token/cost controls. Capture and independently review the retained native inventory/transcripts and uncut desktop evidence; prove duplicate-delivery behavior at the intended live scope and run the matched orchestration evaluation |
| 9 | Fresh implicit design-studio capstone | Attempt 6 selected Marshal implicitly, authored editable orchestration/React/state, used concurrent native reviewers, rendered inline, refined PiP, passed deterministic two-runtime recovery, and proved the declared actions executable from a separate runtime. Active candidate `f` has now passed a fresh headless readiness diagnostic: it selected Marshal in 6.564 s, completed one three-specialist editable orchestration, authored separate backend/React source, persisted project state, compiled and bound an adaptive render, and returned its text fallback | local-live-partial | The candidate-`f` diagnostic prompt requested parallel specialist input and differs from frozen canonical build prompt `c9b0e647...`; headless fallback is not desktop UI. The canonical prompt has never run. Run it in a genuinely fresh recorded desktop task, then prove clicks/mode outcomes, in-Codex actions, refinement, another real application restart and historical reopen, uncut capture, and the matched stock comparison |
| 10 | Deterministic history/restart/failure | Shared cached-reopen and fallback tests plus standards-host attempt `k`: a 4,069 ms visible hydration fallback, complete text fallback, remount, and process restart that reopened render `10d2a8e2…` with `Direction B` and zero new compile/render calls | local-live-partial | The standards-host automated pixels, report, traces, receipts, and hashes pass the evidence verifier, but no uncut video or independent human review exists. Codex historical-message inspection and restart pixels remain required |
| 11 | Detachable Codex adapter | Active deployment `20260802f`, plugin `0.1.0+codex.20260802191116`, retains 21 local archives, passed its frozen offline install and detached generic MCP smoke, was installed through the personal marketplace with source/cache hash equality, survived a real Codex restart, exposed the compact Marshal surface, reopened the cached React render, and returned the corrected schema-valid malformed-state error. Earlier candidates retain the recorded Linux, packed-consumer, retry, memory, and capacity evidence | deterministic-ready | Verify published registry artifacts across the supported OS/Node matrix; post-restart tool/render use is still not desktop-pixel or capstone proof |
| 12 | Measurable comparative improvement | The frozen 18-case runner validates and materialized 108 model-disabled or UI-unavailable records with zero tokens. The checked-in Windows launcher now enforces a real suspended-start, no-breakaway, kill-on-close Job Object over targets and descendants; 17/17 focused confinement tests and 12/12 Codex-driver regressions pass | missing-live-result | The Job Object profile remains correctly release-ineligible: filesystem and network access are unrestricted, model transport is shared with descendants, and no loaded network/filesystem kernel-policy measurement exists. `docs/evals/v1/manifest.json` still says `baselineStatus: not-captured`; provision a reviewed full-contract confinement provider and desktop driver before running, grading, or publishing the 108 live attempts |
| 13 | Publication package | The offline publication gate passes for all 20 publishable packages; guides, examples, capture automation, SBOM/license inventory, checklist, and threat model exist | partial | Current checkout has zero GIF/MP4/WebM files, no `.github/release-authority.json`, no Git remote or tag, and no package repository metadata. Owner authority, registry artifacts, raw evaluated evidence, reviewed media, compatibility review, and independent release reviews remain required |

`deterministic-ready` means the repository path is ready for its named live or
review gate; it does not mean the overall definition item is complete.

## Critical path to a release claim

1. Freeze the implementation, development/hidden tasks, fixtures, graders, and
   environment; record hashes before any final optimization. The checked-in
   `v1` corpus is frozen, but no separately identified hidden task set is
   currently evidenced; resolve that gap without rewriting the frozen corpus.
2. Candidate `f` now packages the retry fix plus the React state-tool
   success/error output-schema fix, has survived a host restart, and has passed
   the post-restart cached-render and malformed-state regressions. Its fresh
   headless noncanonical diagnostic also passed routing, one bounded
   three-specialist editable orchestration, persistence, compile, render, and
   fallback delivery. Expand memory evidence through the frozen corpus, then
   run the exact canonical capstone in a genuinely fresh recorded desktop task;
   neither the diagnostic nor attempt 6 is a substitute because both prompts
   differ. Deployment `20260802d` remains a historical defect boundary; active
   deployment `20260802f` / plugin `0.1.0+codex.20260802191116` is not yet a
   release claim.
3. The standards-only host now has an integrity-checked, 10-gate automated
   attempt for its local request boundary, UI action, advertised mode outcomes,
   theme/resize/safe-area, hydration and complete fallback, remount, and
   process-restart recovery. Preserve attempt
   `standards-host-security-20260803-k` at
   `C:\tmp\marshal-standards-host-security-run-20260803k` (external bundle
   report SHA-256
   `61fc5ab3c85629fcc8b8b1e9a2a6a4d477dea81f4cd8382c317f2388df44e918`),
   capture the remaining Codex UI/restart gates, then record and independently
   review uncut media. Automated DOM-click screenshots alone are not a
   publication claim.
4. Independently review and capture the preserved 28-root native delegation
   inventory/transcripts; the frozen completion/cancellation run and
   zero-orphan receipt audit now pass on candidate `e`.
5. The checked-in Windows Job Object launcher now provides real descendant
   membership and kill-on-close/owner-death cleanup without changing firewall
   or machine policy. It cannot satisfy the release profile because it lacks
   filesystem isolation, descendant egress denial, parent-only model transport,
   and a loaded network/filesystem policy measurement. Provision and review a
   full-contract provider, then capture untouched stock-Codex baselines and at
   least three randomized paired Marshal attempts for every predeclared family.
   Publish failures too.
6. Prepare reviewed uncut evidence bundles, derive the GIF/MP4 edits from
   disclosed source ranges, and generate the deterministic evidence index.
7. Verify published package artifacts outside the source repository across the
   supported OS/Node matrix; complete security, privacy, accessibility, and
   reproducibility reviews.

The exact operator gates are in the
[`publication checklist`](publication-checklist.md). No release claim should be
made from this audit alone.
