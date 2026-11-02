# Native delegation from final detached candidate — 2026-08-02

## Classification

`local-live-smoke`. This diagnostic proves that editable TypeScript in the
detached candidate can discover the exact delegation schema, spawn one real
Codex-native child, wait for it, and recover its marker through the portable
receipt path. It is not the implicit-routing capstone or a multi-agent capacity
claim.

## Candidate and command

- Candidate root:
  `%USERPROFILE%\.marshal\codex-runtime-0.1.0-20260802a`
- Kernel module:
  `%USERPROFILE%\.marshal\codex-runtime-0.1.0-20260802a\node_modules\@marshal\codex-gitnexus\dist\index.js`
- Permission profile: `bounded-agentic`
- Trusted Node authority: `false`

The repository's `smoke-native-delegation.mjs` launched the candidate's pinned
MCP entrypoint and supplied the detached kernel module. The authored inline
module performed exact capability discovery, `runtime.delegation.spawn`, and
`runtime.delegation.wait` with depth, agent, concurrency, timeout, token, retry,
permission, and effect bounds.

## Result

```json
{
  "ok": true,
  "exactSchemaVerified": true,
  "delegationId": "delegation-f8baa976-5a64-450c-ac1d-1a29db4a25b6",
  "marker": "MARSHAL_NATIVE_DELEGATION_OK_887c7106ebc3491f",
  "waitStatus": "success",
  "completed": 1
}
```

The temporary workspace and candidate-test state were removed after the run.
The test does not establish useful multi-agent synthesis, recursion, desktop
presentation, matched quality, token/cost improvement, or the final design
studio experience.
