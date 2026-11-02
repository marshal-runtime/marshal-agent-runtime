# Programmable concurrency — 2026-08-02

## Classification

`deterministic`. This host-level test proves that one editable TypeScript
execution can overlap heterogeneous brokered operations while retaining bounds
and a complete receipt tree. The operations are controlled fixtures standing
in for Brain recall, native-agent review, and artifact preparation; this is not
a live-model latency or quality claim.

## Command

```powershell
cd packages\agent-runtime-host
corepack pnpm@10.32.1 exec vitest run __tests__/host.e2e.spec.ts `
  -t "shortens the critical path" --config vitest.config.ts
```

## Result

```json
{
  "criticalPathMs": 178.301,
  "sequentialSumMs": 390,
  "speedup": 2.187,
  "peakConcurrency": 3
}
```

The authored inline module started all three independent calls through
`Promise.all`. The runtime recorded three nested invocations, peak broker
concurrency three, and one parent-linked receipt tree with no orphan receipts.
All operation starts were required to occur within 50 milliseconds; the
measured critical path was required to remain below 70% of the declared
sequential sum.

The test is part of the normal host suite. It complements, but does not replace,
the installed native-delegation and fresh design-studio evaluations, where
model latency, useful synthesis, cancellation, token use, and cost must be
measured separately.
