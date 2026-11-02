# Marshal 1.0 publication checklist

Checked items below mean the repository contains the named source or validator.
They do not declare Marshal 1.0 complete. Live and statistical items remain
unchecked until linked raw evidence is reviewed.

The status-by-definition audit is
[`publication-readiness-audit.md`](publication-readiness-audit.md), and every
recorded smoke or benchmark is indexed in
[`docs/evidence`](evidence/README.md).
Release authority, deterministic SBOM/license generation, ordered npm dry-runs,
and the gated provenance workflow are documented in
[`release-engineering.md`](release-engineering.md).

## Reproducible examples

- [x] Ordinary non-UI TypeScript source, fixture, offline runner, permission profile, and receipt matcher.
- [x] Memory lifecycle runner covering slim hook enqueue, recovered long-lived Brain processing, and direct semantic cross-session recall.
- [x] Brokered multi-capability composition source with bounded permissions.
- [x] Declared UI capability action manifest and complete fallback.
- [x] Declared editable-module UI action, editable backend source, idempotency requirement, and complete fallback.
- [x] Presentation-mode adaptation source with explicit unsupported/denied/fallback handling.
- [x] Restart-recovery runner using durable render metadata and project-scoped UI state.
- [x] Bounded TypeScript delegation source and clearly labeled generated fixture result.
- [x] Design-studio capstone source, manifests, fixture props, permissions, receipts, fallback, and capture script.
- [x] Offline source/manifest validation and focused tests that require no live or paid run.
- [x] Shared standards-only and Codex-adapter conformance stress 100 cached reopens across isolated scopes and a runtime restart without source writes, recompilation, or new render bindings.
- [x] Historical-render probe reconstructs two independent Codex runtime instances, compares immutable public and private payload digests, verifies expected scoped state, and rejects any UI state-tree write during the probe while explicitly excluding desktop-pixel claims.

## Documentation

- [x] Public host/capability compatibility matrix separates contract, adapter, and evidence status.
- [x] Limitations and threat model state cooperative-isolation and optional-host-feature boundaries.
- [x] Capture storyboard labels fixture material and requires uncut live evidence.
- [x] Capture preparation freezes prompt, source, fixture, and capture-plan hashes outside the repository without creating evidence or media.
- [x] Capture and publication verifiers require continuous-run metadata, redaction review, file hashes, GIF/MP4 provenance, and disclosed source ranges.
- [x] Supporting automation canonicalizes raw JSON/JSONL traces, extracts only existing receipt-shaped records with source pointers and hashes, and rejects conflicting duplicate receipt IDs without reconstructing evidence.
- [x] FFmpeg derivative automation requires a capture-accepted uncut bundle, validates disclosed ranges against source duration, refuses overwrite, and records exact commands plus source/output hashes; host clicks, restart, and fairness review remain human gates.
- [x] Multi-bundle verification reconciles every structurally verified demo with a frozen all-attempt ledger, preserves failed/interrupted outcomes, rejects unlisted bundle directories, and states the operator-preservation trust boundary.
- [x] Deterministic SPDX/license inventory, authority template, dependency-ordered npm dry-run matrix, and OIDC provenance workflow are implemented without inventing repository, registry, scope, version, tag, access, or publisher identity.
- [x] Generic MCP quickstart verified from a self-contained detached package deployment in an unrelated temporary workspace.
- [ ] Codex adapter guide verified from a blank and an unrelated repository. The model-free installed-MCP check is complete; a fresh installed-plugin task remains live evidence.
- [x] Adapter authoring guide and unchanged shared conformance kit verified through the generic composer and standards-only MCP Apps fixtures.
- [ ] Versioned package documentation reviewed against published package contents. Manifest/README/link drift is automated; published-registry artifacts remain a release gate.
- [ ] Release authority file, package repository metadata, protected GitHub environment, and npm Trusted Publisher identity approved by the publication owner; the checked-in template intentionally contains no authority decisions.

## Recorded development evidence

These checks acknowledge narrow local observations. They do not check off the
broader live or release gates below.

- [x] One historical compatibility-hook write/recall pair is retained as superseded evidence; it is not evidence for the current Brain architecture.
- [x] One fresh indirect reusable-module prompt selected Marshal and executed editable TypeScript; one matched simple negative prompt avoided Marshal.
- [x] One fresh implicit design-workspace prompt authored and displayed an editable inline React application.
- [ ] The design-workspace run met the full capstone bar. Attempt 6 now covers
  implicit selection, editable dynamic orchestration, concurrent native agents,
  declared backend actions, all mode declarations, targeted PiP refinement, and
  deterministic two-runtime restoration. It did not use the frozen canonical
  `c9b0e647...` prompt and predates candidate `e`; after current fixes are
  frozen and reinstalled, the canonical fresh task, desktop clicks/mode
  outcomes, a real application restart, uncut media, and the matched stock
  comparison remain.
- [x] A seeded 100,000-memory local benchmark report and SHA-256 are recorded with exact metrics and an explicit cached-TypeScript blocker.
- [x] The native-agent live fixture freezes exact source, prompts, permissions,
  effects, retries, 16-agent completion, 12-agent partial cancellation, all 28
  expected handles, receipt-tree reconciliation, and a zero-orphan verifier.

## Live evidence gates

- [ ] Freeze and hash development and hidden prompts/fixtures before optimization.
  The checked-in `v1` corpus is frozen; no separately identified hidden task
  set is currently evidenced.
- [ ] Capture untouched stock-Codex baseline with the same model, reasoning, tools, workspace, timeout, and fixture data.
- [ ] Run at least three randomized paired repetitions and publish every attempt.
- [ ] Record permissions, approvals, full redacted traces, receipts, timings, tokens, cost, retries, files, UI evidence, and grades.
- [ ] Demonstrate ambient hook observation, completed worker processing, and naturally selected direct Brain recall in fresh tasks without explicit Marshal instructions.
- [ ] Demonstrate implicit ordinary TypeScript selection and a matched negative control where TypeScript is not used.
- [ ] Demonstrate declared capability and editable-module actions from live UI controls.
- [ ] Demonstrate inline plus every host-advertised larger mode; capture typed limitations for unavailable modes.
- [ ] Reopen a historical render after host restart with the same render ID and no compile/render-write activity.
- [ ] Execute the frozen 16-complete/12-cancel native-delegation fixture and
  retain all 28 terminal handles, complete receipt trees, the zero-orphan
  audit, native inventory, and uncut capture.
- [ ] Capture the exact frozen canonical fresh-session implicit design-studio
  capstone as one uncut run on the then-current frozen installed candidate
  through restoration. Earlier attempts used other prompts and do not satisfy
  this gate.
- [ ] Run cross-host conformance on Codex and a standards-only MCP Apps host.
- [ ] Verify installation from published artifacts outside the development repository on every supported OS/Node matrix entry.

## Release-claim gates

- [ ] Cold and warm latency acceptance targets are met by raw benchmark data.
- [ ] Memory scale/relevance and isolation suites meet predeclared targets.
- [ ] Headline paired evaluation is statistically positive overall and in targeted families.
- [ ] Ordinary control-task regression is no greater than five percentage points.
- [ ] Independent security, privacy, accessibility, and reproducibility reviews are complete.
- [ ] Every GIF/short video links to its uncut run, prompt/fixture hashes, source, permissions, trace, and receipts.
- [ ] No fixture image, mock receipt, reconstructed trace, or edited sequence is presented as live evidence.

## Current publication boundary

The deterministic offline publication gate currently passes for all 20
publishable packages. This is packaging readiness, not publication: the
checkout currently has no release-authority file, Git remote or tag, package
repository metadata, published registry artifacts, or GIF/MP4/WebM evidence.
Those owner-controlled and live-evidence gates remain unchecked above.

## Capture-bundle gate

Before recording, prepare an empty bundle outside the repository:

```sh
node examples/publication/demo-capture/prepare-evidence.mjs /absolute/empty/evidence-directory
```

After the continuous recordings and raw artifacts exist, validate the uncut
capture set:

```sh
node examples/publication/demo-capture/verify-evidence.mjs /absolute/path/to/evidence --level capture --write-index
```

After independent review and GIF/MP4 derivation, run the stricter publication
gate:

```sh
node examples/publication/demo-capture/verify-evidence.mjs /absolute/path/to/evidence --level publication --write-index
```

The verifier checks structure, provenance, hashes, and required review fields.
It cannot determine whether a model result was good, a reviewer was
independent, pixels were visually correct, or a short edit was persuasive and
fair; those remain human review gates.
