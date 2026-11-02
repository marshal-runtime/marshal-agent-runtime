# Marshal publication examples

This directory is the source of truth for the public Marshal 1.0 examples. It
contains editable source, deterministic fixtures, complete non-UI fallbacks,
permission profiles, and receipt expectations. It does **not** contain claimed
live evidence.

## Evidence labels

- `offline-executable`: can be run locally after the workspace packages are
  built; no model, paid API, or network access is required.
- `generated-fixture`: deterministic input/output used to review and validate
  a path without claiming a host interaction occurred.
- `required-uncut-live`: must be captured from a fresh installed-host run before
  the corresponding publication claim can be checked off.

Fixture JSON, expected receipts, and storyboard frames are plans or generated
test evidence. They are never substitutes for an uncut host trace, screenshot,
GIF, or video. This repository intentionally contains no fabricated media.

The [evidence index](../../docs/evidence/README.md) records the narrow local
smokes and deterministic measurements that actually exist. The
[publication-readiness audit](../../docs/publication-readiness-audit.md)
separates those observations from the remaining release gates.

## Catalog

| Example | Editable entry point | What it proves offline | Remaining live proof |
| --- | --- | --- | --- |
| Ordinary TypeScript | `ordinary-typescript/analyze-orders.ts` | Pure bounded TypeScript through `@marshal/agent-runtime-typescript` | Automatic implicit routing in stock-vs-Marshal run |
| Automatic memory | `automatic-memory-lifecycle/run.ts` | Deterministic pre-response write and cross-session recall | Installed-hook behavior in two fresh tasks |
| Capability composition | `capability-composition/compose-project-brief.ts` | Runtime search plus nested memory/artifact calls | Natural selection and host receipt tree |
| Declared capability action | `ui-actions/ActionBoard.tsx` | Schema-bound `memory.search` action | Click in a rendered MCP App |
| Editable module action | `ui-actions/update-priority.ts` | Workspace-file action binding and idempotency contract | Click, source edit, rerun, and changed digest |
| Presentation adaptation | `presentation-adaptation/AdaptiveStatus.tsx` | Standards-first mode negotiation and complete fallback | Host-granted inline/fullscreen/PiP transitions |
| Restart recovery | `restart-recovery/run.ts` | Durable render metadata and scoped local state after reconstruction | Reopen historical message after host restart |
| Delegation | `bounded-delegation/orchestrate-review.ts` | Search, parallel spawn, returned IDs, and ordinary completion observation | Execute against an installed native-agent host and retain the uncut trace |
| Design studio capstone | `design-studio/DesignStudio.tsx` | Full source/manifests/fixtures and bounded orchestration program | Fresh-session autonomous uncut capstone run |

## Validation

From the repository root:

```sh
node examples/publication/validate.mjs
node --test examples/publication/__tests__/*.test.mjs
pnpm exec tsc -p examples/publication/tsconfig.json --noEmit
```

The first two commands validate sources, JSON manifests, fallbacks, permission
profiles, receipt expectations, and evidence labels without compiling a UI,
starting a model, or contacting a service. Type checking resolves package names
to package public entry points in this workspace.

Offline runners are deliberately separate from validation because they create
temporary runtime state. In this unpublished workspace, build the packages and
use the repository-only loader that maps public package names to their built
`dist` entry points:

```sh
node --experimental-strip-types --experimental-loader ./examples/publication/workspace-loader.mjs ./examples/publication/ordinary-typescript/run.ts
node --experimental-strip-types --experimental-loader ./examples/publication/workspace-loader.mjs ./examples/publication/automatic-memory-lifecycle/run.ts
node --experimental-strip-types --experimental-loader ./examples/publication/workspace-loader.mjs ./examples/publication/restart-recovery/run.ts
```

Installed consumers import the published package names normally and do not use
the workspace loader.

Each runner prints actual receipts or structural results from that invocation.
Values shown in `expected-receipts.json` are matchers, not pre-recorded claims.

## Live capture inputs

Prepare a fresh external evidence directory before recording:

```sh
node examples/publication/demo-capture/prepare-evidence.mjs /absolute/empty/evidence-directory
```

Preparation freezes hashes for the plan, prompts, sources, and fixtures; it
does not create media or evidence. After capture, run the capture-level
verifier. After independent review and short-media production, run the stricter
publication level:

```sh
node examples/publication/demo-capture/verify-evidence.mjs /absolute/path/to/evidence --level capture --write-index
node examples/publication/demo-capture/verify-evidence.mjs /absolute/path/to/evidence --level publication --write-index
```

The [storyboard](../../docs/demo-capture-storyboard.md) defines the GIF, MP4,
and uncut WebM relationship and the required disclosure for unsupported
features and generated fixtures.
