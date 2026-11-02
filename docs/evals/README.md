# Marshal evaluation corpus

This directory freezes the first product evaluation before routing, memory,
execution, or UI performance is optimized. It measures Marshal as a general
augmentation layer for Codex, not only as an application builder.

## Headline comparison

- `codex-baseline`: an otherwise unmodified Codex installation with its normal
  tools and bundled skills, without Marshal.
- `codex-marshal`: the identical Codex build and configuration with Marshal
  enabled. Prompts do not tell the model to use Marshal.

Forced-use and single-capability ablations are diagnostic arms. They must not be
reported as the headline comparison.

## Corpus layout

- `v1/manifest.json` fixes the protocol, primary comparison, scoring rules, and
  hashes of every frozen input.
- `v1/treatments.json` defines the two headline arms and diagnostic ablations.
- `v1/cases/*.json` contains routing, memory, editable TypeScript execution,
  UI/full-app, and ordinary-control tasks.
- `schema/*.schema.json` defines the machine-readable formats.
- `schema/evidence-record.schema.json` is the schema for each line of an
  evidence JSONL file.

No benchmark result is claimed by this scaffold. A runner must execute every
eligible case in randomized paired order and write one evidence record per
case, treatment, and repetition.

## Methodology invariants

1. Use the same Codex version, model, reasoning level, timeout, default tools,
   workspace fixture, and network snapshot in both headline arms.
2. Run at least three repetitions per pair. Do not select the best attempt.
3. Keep development prompts separate from this frozen test set.
4. Grade deterministic state automatically where possible. Human graders see
   outputs and artifacts without treatment or tool names.
5. Publish every attempt, timeout, error, exclusion, trace digest, token count,
   cost, and wall-clock duration.
6. Record display-mode assertions only when the host advertised that mode;
   graceful fallback is the assertion otherwise.
7. Report paired effects and confidence intervals. A release claim requires a
   positive overall effect and no material regression on control tasks.

## Reproducible runner

The runner treats a case, repetition, and the two headline treatments as one
matched pair. It deterministically shuffles the order inside every pair and the
order of the pairs from a predeclared seed. It never selects a best attempt.

Create a run configuration conforming to `schema/run-config.schema.json`. The
configuration fixes one Codex build, model, reasoning level, native tool
manifest, fixture manifest, recorded network fixture, retry policy, and output
limit for both arms. Each input file has an exact SHA-256 digest. The treatment
object supplied to the driver is the only intended difference between stock
Codex and Codex with Marshal installed.

Inspect the complete randomized plan without invoking an agent:

```powershell
node scripts/evals/run.mjs --config C:\evals\marshal-v1.json --dry-run
```

Execute the plan or resume an interrupted append-only run:

```powershell
node scripts/evals/run.mjs --config C:\evals\marshal-v1.json --output C:\evals\runs\marshal-v1
node scripts/evals/run.mjs --config C:\evals\marshal-v1.json --output C:\evals\runs\marshal-v1 --resume
```

At least three repetitions are mandatory. Resume verifies the configuration
and corpus digests and skips only attempt keys already present in
`evidence.jsonl`. Timeouts, errors, retries, and zero-scoring attempts remain in
the evidence; exclusions make a release claim ineligible.

### Driver adapters

- `dry-run` writes only `plan.json` plus an explicit `DRY_RUN_ONLY.txt` marker.
- `fixture` reads a hashed deterministic result fixture for runner tests. Every
  record and report is marked non-live and can never support a release claim.
- `command` is the real-driver boundary. The runner starts the configured executable
  without a shell, sends one JSON request on stdin, and expects one JSON result
  on stdout conforming to `schema/adapter-result.schema.json`. Its driver file
  and every declared local dependency are verified against predeclared SHA-256
  digests. Evidence records a canonical combined adapter digest, so changing a
  security helper invalidates the matched configuration.

The command receives the full case phases, selected treatment, pair/order
metadata, fixed environment, verified input paths/digests, bounded output
directory, timeout, turn limit, retry limit, and output-byte limit. A real
Codex driver must create a fresh correctly configured task boundary for every
case phase and must enforce the treatment: stock Codex has no Marshal plugin;
the treatment arm has the exact published Marshal installation. Do not emulate
either arm in prompts.

`scripts/evals/codex-driver.mjs` is the reference command driver for the stable
Codex CLI automation surface. It uses `codex exec --json` for a new task and
`codex exec resume <thread-id> --json` for `same-task` and `restart-host`
phases. Every phase is a new CLI process; resume always targets the exact
`thread.started` ID rather than `--last`. The driver fixes model, reasoning,
sandbox, approval policy, workspace, config overrides, and the full Marshal
plugin ID on every invocation. It verifies the effective config through the
app-server `config/read` probe before any model turn.

The command adapter copies `adapter.driverOptions` into the driver request. A
Codex run must pin at least:

```json
{
  "codexCommand": "C:\\absolute\\path\\to\\node.exe",
  "codexArgs": ["C:\\absolute\\path\\to\\@openai\\codex\\bin\\codex.js"],
  "marshalPluginId": "marshal-runtime@personal",
  "pluginStateOverrides": {
    "disabled": "plugins={...marshal enabled=false...}",
    "enabled": "plugins={...marshal enabled=true...}"
  },
  "sandbox": "workspace-write",
  "approvalPolicy": "never",
  "allowModelInvocation": false,
  "configOverrides": [
    "web_search=\"disabled\"",
    "features.apps=false",
    "apps._default.enabled=false",
    "apps._default.open_world_enabled=false",
    "sandbox_workspace_write.network_access=false"
  ],
  "networkFixtureGuard": {
    "command": "C:\\absolute\\path\\to\\node.exe",
    "args": ["C:\\repo\\scripts\\evals\\offline-network-guard.mjs"],
    "file": "C:\\repo\\scripts\\evals\\offline-network-guard.mjs",
    "sha256": "exact-64-character-guard-digest"
  }
}
```

The hashed tool manifest must declare `schemaVersion: "1.0.0"` and a
`codexCommandDriver` object with versioned `commonEnabledPlugins`, a versioned
`marshalPlugin` (including its canonical local tree digest), and
`effectiveConfigWithoutMarshalSha256`. The driver compares the installed
inventory, effective enabled plugins, plugin source, and effective config with
those pins after applying the arm override, so the baseline retains every
pinned stock plugin and disables only Marshal. The driver exports
`digestFixtureTree()` and `digestEffectiveCodexConfig()` so the manifest
generator can compute both canonical digests with the same implementation used
by preflight.

The hashed fixture manifest must declare `schemaVersion: "1.0.0"`, map every
`fixture://...` workspace to `{ sourcePath, sha256 }`, and optionally map phase
fixtures to `{ workspace, path, sha256 }`. `sha256` for a workspace is the
canonical tree digest returned by the exported `digestFixtureTree()` helper.
The source is verified before being copied under the attempt directory; an
agent never edits the frozen source fixture.

`fixtures/offline-v1/manifest.json` is the checked-in deterministic workspace
set for every non-UI routing, execution, and control case. It includes exact
tree and individual fixture digests. `network-deny-all.json` declares the
offline policy.

Codex model transport is not treated as fixture data. Instead,
`scripts/evals/offline-network-guard.mjs` denies every Codex-native route to
external data: web search and apps are disabled, workspace shell networking is
false, all user MCP servers must be effectively disabled, and no common plugin
may remain enabled. The guard file is itself hash-pinned. It verifies the
effective config returned by Codex, and those exact overrides are then passed
again to every `exec` and `exec resume` process. A one-shot digest stamp or a
merely declared policy does not pass. Without the exact guard and enforcement
attestation the attempt is unavailable and excluded. This configuration
attestation does not claim OS-level egress isolation for Marshal, hooks, or
workspace-command descendants. Consequently a live run is fail-closed unless
`driver.processConfinement` names a hash-pinned launcher and profile. Every
model phase is actually started through that launcher; its attestation must
cover the Codex process, Marshal/plugin children, and workspace-command
children. A release run also requires Marshal's brokered `default` or
`bounded-agentic` profile with no wildcard package or builtin authority.
Subagent/capstone cases specifically require `bounded-agentic` or
`adaptive-agentic`: both remain brokered and default-deny, grant only bounded
delegation/runtime authority selected for the task, and do not grant trusted
Node execution or wildcard imports.

On Windows, the checked-in Job Object launcher provides real inherited
process-tree membership, suspended assignment before target execution, and
kill-on-close/owner-death cleanup. It intentionally remains ineligible for a
live matched evaluation because it cannot enforce filesystem isolation,
descendant egress denial, or parent-only model transport. Its profile and
attestation are typed accordingly, so the live driver continues to fail closed.
See
[`windows-confinement-capability-probe.md`](windows-confinement-capability-probe.md)
for the exact commands and boundary.

### Explicit live-run authorization

`allowModelInvocation: true` is necessary but deliberately insufficient. A
live driver also requires all of the following:

- `liveAuthorization`: a hash-pinned, expiring operator authorization bound to
  the exact run ID, corpus digest, authorization-safe configuration digest,
  Codex/model versions,
  and maximum attempt count;
- a USD pricing snapshot in that authorization so token-derived cost is
  captured for every attempt;
- `processConfinement`: the descendant-confining launcher described above;
- `environmentAllowlist`: the exact non-secret environment names inherited by
  Codex and descendants; names that look like API keys, tokens, passwords,
  cookies, credentials, or secrets are rejected;
- `objectiveOracle`: a hash-pinned deterministic command that emits exactly
  every non-human assertion observation for the case;
- a clean declared repository commit and the default-deny Marshal plugin;
- a desktop-host driver with real UI captures for UI-family cases.

The exact missing host boundary and the fail-closed requirements are recorded
in [`desktop-host-driver-boundary.md`](desktop-host-driver-boundary.md). Codex
App Server is sufficient for task and trace automation, but not for desktop
render coordination, UI interaction, pixel capture, or product-restart
attestation.

The checked-in deterministic implementation is
`scripts/evals/objective-oracle.mjs`; it covers all 55 frozen non-human
assertions and is automatically added to generated offline profiles. See
`objective-oracle.md`. The process-launch contract is specified in
`confinement-launcher-contract.md`.

The authorization file is intentionally not generated by repository scripts.
An operator must review the frozen plan and create it explicitly. A typical
authorization document has this shape (all digests and prices are examples):
`authorizationBindingDigest` hashes the complete run configuration after
removing only the authorization-file descriptor, avoiding a circular digest
while still binding the driver, confinement profile, oracle, fixtures, model,
and treatments.

```json
{
  "schemaVersion": "1.0.0",
  "authorizationId": "review-ticket-or-run-approval",
  "approvedBy": "operator-id",
  "approvedAt": "2026-08-01T00:00:00Z",
  "expiresAt": "2026-08-02T00:00:00Z",
  "allowModelInvocation": true,
  "runId": "marshal-v1-release",
  "corpusDigest": "<sha256>",
  "authorizationBindingDigest": "<sha256>",
  "model": "<fixed-model>",
  "harnessVersion": "<fixed-codex-version>",
  "maxAttempts": 108,
  "maxAdapterInvocationsPerAttempt": 1,
  "pricing": {
    "currency": "USD",
    "unitTokens": 1000000,
    "inputUsdPerUnit": 0,
    "cachedInputUsdPerUnit": 0,
    "outputUsdPerUnit": 0,
    "source": "dated-pricing-source"
  }
}
```

The runner records SHA-256 attestations for authorization, network
enforcement, process confinement, and the objective oracle in every evidence
record. Reports are release-ineligible if any attestation, cost estimate,
objective signal, or required UI capture is missing.

### Safe offline smoke profile

`offline-smoke.profile.json` is the checked-in safe run profile. Generate its
machine-local exact run config from the repository-pinned `@openai/codex`
package and the installed Marshal plugin:

```powershell
pnpm evals:prepare-offline-smoke --output C:\evals\marshal-offline-smoke
node scripts/evals/run.mjs --config C:\evals\marshal-offline-smoke\run-config.json
```

The default smoke selects one read-only control pair for a quick six-attempt
preflight. Before requesting live-run authorization, freeze the exact complete
108-attempt plan and publish model-disabled preflight records for every attempt:

```powershell
pnpm evals:prepare-offline-smoke --output C:\evals\marshal-full-preflight --full-corpus
node scripts/evals/run.mjs --config C:\evals\marshal-full-preflight\run-config.json --output C:\evals\marshal-full-preflight\dry-run --dry-run
node scripts/evals/run.mjs --config C:\evals\marshal-full-preflight\run-config.json --output C:\evals\marshal-full-preflight\unavailable-run
```

`--full-corpus` removes only the case filter; it does not enable model
invocation, create operator authorization, or make the resulting unavailable
records release-eligible. The generated plan must report `fullCorpus: true`,
18 cases, and 108 expected attempts. Configuration probing runs from a neutral
generated workspace, matching the attempt workspaces rather than inheriting
repository-local Codex configuration.

Preparation probes only version, plugin inventory, and `config/read`. The
generated config pins absolute executable paths, CLI/plugin/guard/tree hashes,
the complete effective config without Marshal, and arm-specific full plugin
tables. It replaces user MCP definitions with inert disabled definitions. Its
`allowModelInvocation` latch is `false`, so the runner performs all
reproducibility preflights and publishes excluded `unavailable` attempts
without starting a model turn or spending model quota. Enabling that latch is
an explicit operator action for a separately approved real run; a smoke result
is never claim-eligible.

Inspect a request without invoking a model:

```powershell
Get-Content C:\evals\attempt-request.json -Raw |
  node scripts/evals/codex-driver.mjs --preflight
```

The CLI exposes trace events, final messages, file-change paths, some
permission events, MCP results/receipts, wall time, and token usage. It does
not expose billed monetary cost, so a live run derives an estimate from the
observed token counts and the authorization's hash-pinned USD pricing snapshot.
The CLI does not render MCP Apps or capture screenshots or video. UI evidence
is explicitly unavailable. UI-required cases fail
this driver's preflight and require a separately validated desktop-host driver;
the CLI driver never labels such a skip as live evidence. Objective assertion
signals remain empty unless an external deterministic oracle supplies them;
the driver never infers or fabricates scores from prose.

The driver returns the full trace, per-phase outputs, final output, generated
files, permission decisions, receipts, observed tools, timings, tokens, cost
when available, retries, failure category, and UI screenshots/video. Text is
redacted by literal values declared in `redactions`; secret-bearing trace keys
are always redacted. Binary UI evidence must already be safe to publish,
declare whether it was redacted, and set `blindSafe: true` before it can enter
a human-grading packet.

### Grading and reports

For every non-human assertion, the driver exposes a deterministic
`assertionObservations[assertion-id]` score produced by a fixture oracle,
test/command result, state check, trace query, file digest/content check, or
latency check. Missing objective evidence receives zero; the runner never asks
a language model to fill the gap.

The built-in data-only graders support boolean checks, canonical JSON equality,
required-substring checks, numeric ranges, SHA-256 equality, and explicit
fractional scores from a named external oracle. These comparisons run after
the adapter returns, so the same grading code evaluates both treatments.

Assertions whose corpus kind is `human-rubric` are emitted to
`blind/review.jsonl`. Those packets contain the prompt, rubric, redacted final
output, and copied UI evidence, but no treatment, repetition, tool name, or
pair order. Keep `blind/private-map.jsonl` away from graders. Grades conform to
`schema/human-grade.schema.json`:

```json
{"blindId":"0123456789abcdef01234567","score":0.8,"grader":"ui-reviewer-07","notes":"Evidence-based rationale."}
```

Regenerate the report after collecting blind grades:

```powershell
node scripts/evals/report.mjs --run C:\evals\runs\marshal-v1 --human-grades C:\evals\grades.jsonl
```

`report.json` lists every attempt. `report.md` reports the paired mean and a
two-sided 95% paired-t confidence interval. The release gates are predeclared:

1. every frozen case and attempt is present, with at least three repetitions;
2. all records use the same corpus, fixed configuration, and clean declared
   repository commit;
3. the lower bound of the overall paired 95% confidence interval is above zero;
4. every targeted non-control family improves on average; and
5. the ordinary-control family regresses by no more than five percentage
   points.

Only complete, full-corpus, live command-adapter evidence can be eligible.
Fixture runs, partial selections, pending human grades, missing attempts, and
excluded attempts always say that no release claim is permitted.

### Published run contents

```text
run-metadata.json       immutable run identity and per-attempt evidence policy
plan.json               randomized paired order and expected attempt keys
config.snapshot.json    redacted fixed configuration and hashes
evidence.jsonl          one append-only record for every attempt
attempts/               redacted traces, outputs, files, receipts, timings, UI
blind/review.jsonl      treatment-hidden human grading packets
blind/private-map.jsonl private unblinding map
report.json             complete machine-readable metrics and gates
report.md               publication-oriented matched comparison
```

No live evidence or untouched baseline has been captured by this repository
scaffold yet.

## Validation

The validator has no third-party dependencies:

```powershell
node scripts/validate-evals.mjs
node --test scripts/evals/__tests__/*.test.mjs
```

It parses every JSON document, checks the frozen-file SHA-256 digests, validates
the structural contracts used by the corpus, and rejects duplicate case or
treatment IDs.

## Changing the corpus

Do not silently edit `v1`. Correcting or expanding a task creates a new corpus
version with a new manifest and hashes. Preserve prior evidence with the exact
manifest digest used for that run.
