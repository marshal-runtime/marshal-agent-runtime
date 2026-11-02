# Candidate `j` frozen matched-evaluation preflight — 2026-08-03

## Claim boundary

This is complete, model-disabled, fail-closed preflight evidence for the frozen
stock-Codex-versus-Marshal evaluation. It proves that Candidate `j` can be
pinned as the treatment, that every matched request can be materialized in its
frozen randomized order, and that unavailable attempts cannot become a product
claim. It does **not** contain a live model turn, a stock-Codex quality result,
desktop MCP Apps evidence, or a statistical improvement claim.

The authoritative retained machine-local bundle is:

```text
C:\tmp\marshal-full-preflight-candidate-j-clean-20260803
```

It was generated from clean detached worktree
`C:\tmp\marshal-eval-clean-candidate-j`. An earlier bundle without `-clean`
was generated from the main worktree while user-owned documentation changes
were present. It remains valid fail-closed evidence, but is superseded because
its configuration truthfully recorded `repositoryDirty: true`.

## Commands

```powershell
node scripts/validate-evals.mjs
node --test scripts/evals/__tests__/*.test.mjs
node scripts/evals/prepare-offline-smoke.mjs --output C:\tmp\marshal-full-preflight-candidate-j-clean-20260803 --full-corpus
node scripts/evals/run.mjs --config C:\tmp\marshal-full-preflight-candidate-j-clean-20260803\run-config.json --output C:\tmp\marshal-full-preflight-candidate-j-clean-20260803\dry-run --dry-run
node scripts/evals/run.mjs --config C:\tmp\marshal-full-preflight-candidate-j-clean-20260803\run-config.json --output C:\tmp\marshal-full-preflight-candidate-j-clean-20260803\unavailable-run
```

Observed terminal results:

```text
Validated 18 cases, 55 objective assertions, 8 treatments, and 6 frozen files.
tests 59; pass 59; fail 0
Wrote dry-run plan for 108 attempts. No evaluation was executed.
Published 108/108 attempts. Release claim eligible: false.
```

## Frozen configuration

```text
Corpus digest: 5755f63481d62c2e37b084be17f9eec40378ae4828ed9f5e2195d2bad544550a
Configuration digest: 09469ef816e034d88d1f45063e90e5d724c62083ec7a0da50cc680fb88597678
Harness: Codex 0.144.6
Model: gpt-5.6-sol
Reasoning: medium
Repetitions: 3
Seed: offline-full-corpus-v1
Repository commit: ef9f6a4fcbe95f57b73beb8bba0e859110b8dad8
Repository dirty: false
Marshal plugin: marshal-runtime@personal 0.1.0+codex.20260803081313
Marshal plugin tree digest: e9879939d82a7c52afb2b08b6d4b95d2cf06f880e1a050cae2e08b9ca5a6ab00
Marshal permission profile: adaptive-agentic
Allowed packages: none
Allowed builtins: none
Effective config without Marshal: db226cc3a0b86bf95d2cede777fdb317f4a16b51bfa3b9d58bb709e443c1511e
Model invocation: false
Network fixture: deny-all
```

The two headline arms use the same frozen configuration. The generated full
plugin tables disable every common plugin in both arms and change only
`marshal-runtime@personal` from disabled in `codex-baseline` to enabled in
`codex-marshal`.

## Result

```text
Expected attempts: 108
Observed attempts: 108
Baseline attempts: 54
Marshal attempts: 54
Missing attempts: 0
Unexpected attempts: 0
Excluded attempts: 108
Input/output/cached tokens: 0/0/0
Publish-all-attempts gate: PASS
Minimum-repetitions gate: PASS
Matched-configuration gate: PASS
Artifact-publication-safety gate: PASS
Clean-repository-snapshot gate: PASS
Statistical gates: NOT EVALUATED
Release claim eligible: false
```

The inspected dry-run plan and executed plan are byte-identical. Expected
exclusions are preserved rather than scored:

```text
78: model invocation is disabled by allowModelInvocation=false
30: interactive UI evidence requires a separately validated desktop-host driver
```

## Artifact digests

```text
39c7933ed6a2fda3ed3c64587745f8837d7fde25352a18b0dba36d1189379f4d  run-config.json
2ed17b6be53b55e8d23b95e46b96e06be283eb5558a03da9c616eff7572a40c3  tool-manifest.json
ffbb650d27952aa17d510815a56f0e256c31b77afeeb7e405ce60949f2657245  dry-run/plan.json
ffbb650d27952aa17d510815a56f0e256c31b77afeeb7e405ce60949f2657245  unavailable-run/plan.json
a763774ac3ec81c3c8fc477b0a840a09b4a8c16a102bc45d3df73ed915cedb9b  unavailable-run/evidence.jsonl
68da5b69d6dab7985175d2fc933b2cd25ed21a8ad2e3322fff88a86bd49f291e  unavailable-run/report.json
63d34f17ec662383b49e480a1aa5338e5418a9f7c7c85aab1d9f6b0628c1adc6  unavailable-run/report.md
9d697c348abe51e488266007c27484153a793ac262f07ca9f208f5e2f2c052ad  unavailable-run/run-metadata.json
```

## Exact remaining live boundary

The same final runner command is the executable paired-evaluation boundary:

```powershell
node scripts/evals/run.mjs --config C:\evals\marshal-v1-live\run-config.json --output C:\evals\marshal-v1-live\run
```

It may be run only after a separately reviewed configuration binds all of the
following: `allowModelInvocation: true`, an unexpired hash-pinned operator
authorization and USD pricing snapshot, a
release-eligible descendant-confinement lease covering Codex, Marshal, oracle,
and workspace-command descendants, the existing hash-pinned deterministic
objective oracle, and a desktop-host driver for the 30 UI attempts. Blind human
grades are then applied with:

```powershell
node scripts/evals/report.mjs --run C:\evals\marshal-v1-live\run --human-grades C:\evals\marshal-v1-live\grades.jsonl
```

No checked-in component currently supplies the required release-eligible
Windows filesystem/egress confinement or Codex desktop capture/interaction
boundary. The repository deliberately does not generate its own operator
authorization. Therefore the untouched live stock baseline remains honestly
uncaptured.
