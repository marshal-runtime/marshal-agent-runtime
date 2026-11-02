# Installed native-delegation smoke — 2026-08-01

## Classification

`local-live-smoke`. This proves one bounded native Codex child-agent round trip
through an immutable detached Marshal candidate. It is not the dozens-of-agents
capacity claim, the full design-studio capstone, or a matched evaluation.

## Environment and command

- runtime candidate:
  `%USERPROFILE%\.marshal\codex-runtime-0.1.0-20260801h`
- Codex adapter dependency: `@openai/codex` `0.144.6`
- profile: `bounded-agentic`
- trusted Node authority: disabled
- package/builtin wildcards: absent
- retained state:
  `%TEMP%\marshal-native-delegation-CmVXYK`

```powershell
node scripts/smoke-native-delegation.mjs `
  --deployment "$env:USERPROFILE\.marshal\codex-runtime-0.1.0-20260801h" `
  --retain
```

The smoke used the candidate's packaged MCP CLI from an unrelated temporary
workspace. It performed exact schema discovery, ran an inline brokered
TypeScript module, spawned one real Codex child, read the opaque ID only from
`spawned.handle.delegationId`, waited through `runtime.delegation.wait`, and
required the child to return a unique marker.

## Observed result

- delegation ID:
  `delegation-08091ea1-0e00-4fe0-a76c-521e510ca2c9`
- native Codex task alias: `native-delegation-child-task`
- final state: `succeeded`
- wait status: `success`
- completed children: `1`
- marker: `MARSHAL_NATIVE_DELEGATION_OK_a973c2544f4f4df2`
- spawn receipt duration: `1,997 ms`
- wait receipt duration: `6,931 ms`

The stored record retained the request, effective limits, native task ID,
response, revision, and separate successful spawn/wait receipts. The effective
portable limits included depth `1`, concurrency `1`, read-only child
permissions, shared/isolated workspace-mode bounds, and no external effects.

## Integrity

| Artifact | SHA-256 |
| --- | --- |
| candidate `dist/cli.js` | `1AC13FB7AD5EAB6A7764B96682F939F929EBE74F94366BFF833BA96DEF227EC6` |
| candidate Codex-capabilities `package.json` | `646637A0402D36ACAB8B5BF85711A257E6B63A868EF85DCB04531143DF3F1CAE` |
| smoke script | `A7DD14AB23540A647BFBDADD08B33B8E49CA6189D9372A655984B60D10D3710E` |
| durable delegation record | `CCE1DDD5B45FE0D52C9DBD72C563B4E80BFCF1270AA2C7777905F287E4E873B1` |
| execution receipt journal | `662D7A5FEE9E4D6E8E08B07BE732A313FF44F44B37BFE8F2ABA1906AA3A657E4` |

## Remaining claim boundary

This single-child smoke does not establish recursive delegation, 32-agent
capacity, cancellation propagation, no-orphan behavior under failures, UI
synthesis, or task-quality improvement. Those require their separate
deterministic capacity evidence, live capstone, and matched evaluation.
