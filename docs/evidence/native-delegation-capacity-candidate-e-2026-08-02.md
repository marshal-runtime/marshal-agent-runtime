# Candidate `e` native-delegation capacity and cancellation — 2026-08-02

## Classification

`local-live-smoke`. This is a real installed Codex-native delegation run under
the `bounded-agentic` profile. It proves the named candidate and frozen fixture
result. It is not uncut desktop evidence, a matched evaluation, or proof for a
host that was not exercised.

## Frozen input and installed identity

The installed deployment was
`%USERPROFILE%\.marshal\codex-runtime-0.1.0-20260802e`; the runner used its
installed `@marshal/agent-runtime-codex` CLI and `@marshal/codex-gitnexus`
kernel. Trusted Node authority remained disabled.

| Item | SHA-256 |
| --- | --- |
| Frozen TypeScript module | `b8c175c74bc94a319143edcde20740d1cead8ad85448e22f8003197101e5ca02` |
| Frozen fixture manifest | `c0fc4a1a6ff542e756ad08c29f63b226fb0f02c1e0aa4d5af0df6202390e1d43` |
| Independent verifier | `0a93ddc2a481c88dc26ed8d29c6c930d2eda79ae27deb30cfb33367dbb594f06` |
| Installed-host runner | `41861978d59d1a551eef27524820412d0cabc7faca956b679bc10d1206e712b9` |
| Installed CLI | `1ac13fb7ad5eab6a7764b96682f939f929ebe74f94366bff833ba96def227ec6` |
| Accepted raw result | `a0c2f7c8777a04b3ac07ee5fb85f150557d5f2bf8efc6243b2b8ef35b77665d8` |

The accepted attempt id was `candidate-e-capacity-r3-20260802`. It ran from
`2026-08-02T18:46:30.257Z` through `2026-08-02T18:47:22.416Z`.

## Accepted result

The frozen editable TypeScript module executed twice without a workflow DSL.
Both executions used broker peak concurrency eight, no retries, shared
read-only child workspaces, and no child permissions or effects.

| Scenario | Requested | Terminal result | Broker calls | Orphan audit |
| --- | ---: | --- | ---: | --- |
| completion | 16 | 16 succeeded | 34 | passed |
| cancellation | 12 | 2 controls succeeded, 10 roots cancelled | 36 | passed |
| aggregate | 28 | 28 unique terminal handles | 70 | zero orphans |

The independent verifier reconstructed all 28 roots and returned `ok: true`
with no errors. Each completed root retained `spawn` and `wait` receipts; each
cancelled root retained `spawn` and `cancel` receipts. The retained workspace
contains exactly 28 delegation records, 28 idempotency records, and 72 broker
execution-receipt lines. It additionally proves 28 unique external thread ids,
28 exact retry-free idempotency keys, all retry attempts equal to zero, maximum
observed depth zero, exact frozen per-root limits, least-authority shared
requests, and an exact idempotency-index-to-delegation-record mapping.

The host truthfully advertised cancellation, steering, and follow-up. It
advertised `recursiveDelegation: false`; deterministic delegation tests cover
the required typed `recursive_delegation_unsupported` limitation and the
program-controlled flattening path rather than pretending recursion occurred.

## Commands and retained state

Deterministic contracts and verifier negatives passed first:

```powershell
pnpm --filter @marshal/agent-runtime-delegation verify
pnpm --filter @marshal/agent-runtime-codex exec vitest run --config vitest.config.ts src/__tests__/delegationRuntime.spec.ts
node --test examples/publication/__tests__/native-delegation-capacity.test.mjs
```

The accepted live run used:

```powershell
$env:AGENT_RUNTIME_KERNEL_MODULE = '<candidate-e>\node_modules\@marshal\codex-gitnexus\dist\index.js'
node scripts/run-native-delegation-capacity.mjs `
  --deployment '<candidate-e>\node_modules\@marshal\agent-runtime-codex' `
  --output 'C:\tmp\marshal-native-capacity-e-20260802-2149.json' `
  --attempt-id 'candidate-e-capacity-r3-20260802' `
  --retain
```

The retained runtime state is
`%TEMP%\marshal-native-capacity-xclFR0\workspace\.marshal\runtime`.

## Honest limitations

The first live attempt already produced the correct 16/2/10 terminal trees and
zero-orphan audit, but an evidence-runner compatibility bug omitted the
synthetic `executionStatus` field when the installed runtime returned a valid
module result without that optional field. The strict verifier rejected that
attempt. The runner now normalizes a non-error, identity-validated module
result to `success`; its GitNexus blast radius was LOW (one direct caller, no
affected execution flow). A prior accepted rerun proved terminal topology; the
final `r3` rerun used the strengthened verifier to reject altered concurrency,
budgets, retry attempts, depth, idempotency mappings, and broker call counts.
The frozen program was unchanged.

Codex's thread-inspection API stalled when asked to reopen representative
directly spawned child threads, so this document does not claim a separate UI
inventory comparison or transcript review. Durable records retain all 28
external Codex thread ids for later inspection. Uncut capture, desktop review,
and matched quality/cost evaluation remain open publication gates.
