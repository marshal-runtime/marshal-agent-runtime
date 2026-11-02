# Frozen native-delegation capacity/cancellation fixture — 2026-08-02

## Classification

`deterministic`, frozen live input and verifier only. No 28-agent live run is
claimed by this document. The checked-in manifest explicitly says
`notALiveRun: true`; only an installed-host result accepted by the capture
verifier can become `local-live-native-agent-capacity` evidence.

## Frozen scenarios

One editable, harness-neutral TypeScript module is executed twice so each
brokered execution remains below the 64-call runtime ceiling:

| Scenario | Native roots | Required outcome | Root fan-out ceiling |
| --- | ---: | --- | ---: |
| Completion | 16 | 16 succeeded, zero pending | 8 |
| Cancellation | 12 | 2 succeeded controls and 10 cancelled roots | 8 |

All 28 roots are single-node trees with depth, total-agent, and concurrency
limits of one. Retries are zero. Children receive no declared permissions or
effects and use the shared read-only workspace mode, so the fixture creates no
worktree leases. The source performs exact capability discovery, retains
spawn/wait/cancel receipts, reconstructs every receipt tree, and rejects
missing, extra, duplicate, non-terminal, invalid-root, or receipt-incomplete
handles.

This is dynamic TypeScript using small delegation capabilities, not a workflow,
stage, lambda, or graph DSL.

## Installed-host command

Run against a detached candidate while the uncut capture is active. The output
path must not already exist, so a previous attempt cannot be overwritten.

```powershell
node scripts/run-native-delegation-capacity.mjs `
  --deployment <absolute-detached-candidate> `
  --output <absolute-capture-directory>\native-delegation-capacity.json `
  --attempt-id publication-capacity-001 `
  --retain
```

The runner executes both scenarios even if the first fails, writes the raw
attempt, independently reconstructs the 28-handle audit, and exits non-zero for
any missing schema, unexpected state, digest mismatch, or orphan. Retained
state must remain available until the native task inventory, trace, and receipt
files have been independently compared.

## Frozen identities

| Artifact | SHA-256 |
| --- | --- |
| `live-capacity-cancellation.ts` | `b8c175c74bc94a319143edcde20740d1cead8ad85448e22f8003197101e5ca02` |
| `live-fixture.json` | `c0fc4a1a6ff542e756ad08c29f63b226fb0f02c1e0aa4d5af0df6202390e1d43` |
| `verify-live-capacity.mjs` | `5192451893a2f95b3b33be310dba944a3f1a1515af552923b9879ebde1b34760` |
| `run-native-delegation-capacity.mjs` | `f868836d240d38558c08e855a2c24f0967efaccf3dd4980de150c15621d46b06` |

## Remaining claim boundary

The fixture and its synthetic negative tests prove frozen inputs and strict
verification behavior. They do not prove that 28 native agents ran, that ten
native cancellations propagated, or that no native task survived. Those claims
remain pending until a fresh installed-host run, retained native inventory,
uncut recording, and independent evidence review all agree.
