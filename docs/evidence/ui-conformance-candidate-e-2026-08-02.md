# Candidate `e` runtime-backed React and restart recovery

Date: 2026-08-02

Evidence class: `local-live-smoke plus deterministic recovery`

Release status: **runtime path passed; reviewed desktop interaction still required**

This observation exercised the active installed candidate
`%USERPROFILE%\.marshal\codex-runtime-0.1.0-20260802e` from an unrelated
workspace. It proves that one editable React application can use the stable
startup-registered bridge for an editable TypeScript action, a capability
action, a declared tool, scoped local state, and cached recovery across a real
Codex application restart. It does not infer visible pixels or user clicks from
tool results.

## Authored application

The model selected the advertised `openai-apps-sdk-ui@1.0.0` authoring profile
and preserved separate editable sources:

| Source | SHA-256 |
| --- | --- |
| `.marshal/ui-conformance/UiConformancePanel.tsx` | `FA5642F1A6291D38D97E1E0C4057575DCEA13D58C53D1A7A70BDD17CD8FBCBBF` |
| `.marshal/ui-conformance/save-selection.ts` | `66E4A4D74E5366A0CE979AD0E0AA4D8F0DAC4A40F86E3C6A27656CDF5CF65E9E` |

The manifest declares:

- presentation modes `inline`, `fullscreen`, and `pip`;
- module action `save-selection`, with project scope, explicit
  `runtime.module.execute` and `artifacts.write` permissions, and required
  idempotency;
- capability action `search-memory`, bound to `memory.search` with project
  scope and `memory.read`;
- direct tool `code-status`, bound to `code.index.status`;
- project-local state schema `1.0.0`; and
- authoritative project artifact `ui-conformance/selection.json`.

The first compile request used the wrong workspace and failed in 1 ms with no
component. After placing the already-authored source in the MCP server's actual
workspace, there was exactly one successful compile and one render binding:

| Operation | Receipt | Duration | Result |
| --- | --- | ---: | --- |
| `ui.compile` | `receipt-msc4ibpm-1j-bw6yjaln` | 216 ms | component `9aa7359216a7855e1ef17f2891541f668b756e544b9f63e6810ab134462cb3e5` |
| `ui.render` | `receipt-msc4iv0i-1o-wdqz2v2o` | 49 ms | render `387b789859313bbea77c86295ee6614cfe72c0febd3f4b92a817255f92ccd55e` |

The immutable bundle digest is
`0128c8cef3f37474e6bf1398e0a959cbb03512a76fb4f7cba4ea06b91600e3af`;
the compiled HTML digest is
`4388bae44b4d63890b95c5e6ad89dcf4337b479b4137f251e5064ad5743aac57`.

## Startup-registered application bridge

A generic MCP client connected to candidate `e`, discovered the three bridge
tools at startup, and operated the existing render without a hot-registered
per-render tool:

| Probe | Observed result |
| --- | --- |
| Editable module action | `success`; action receipt `64a73724-764c-45f7-967d-54f5b03163bd`; nested runtime receipt `receipt-msc5e8it-j-7o4qp9xd` |
| Exact idempotent replay | same action receipt; `replayed: true`; no second backend effect |
| Capability action | `success`; action receipt `99baad6e-006e-4543-9149-7cfdaa0f1e68` |
| Declared direct tool | `success`; runtime receipt `receipt-msc5e8nv-t-0ieddgel`; `code.read` permission |
| Scoped state update | `stored: true`; same render ID; `selectedDirection: Structure` |

An authoritative `artifacts.read` then recovered:

```json
{
  "selection": "Structure",
  "source": "marshal-ui-conformance"
}
```

The read was project-scoped and receipted as
`receipt-msc5enu9-g-qj5bnwr5`. The complete bridge observation retained outside
the repository has SHA-256
`1F3CDE18D209E7530C7AA007C369B77241F063E73C7626FB1FA12FCF5FFD2750`.

## Real application restart and cached recovery

The render was created at `2026-08-02T18:18:28Z`. A detached Windows task then
stopped the exact installed Codex package and relaunched its registered App ID:

- old desktop PID `11316` stopped at `2026-08-02T18:27:35Z`;
- `OpenAI.Codex_2p2nqsd0c76g0!App` launched at
  `2026-08-02T18:27:36Z`;
- new desktop PID `30088` was observed at `2026-08-02T18:27:36Z`; and
- the active Marshal goal resumed automatically in the restored task.

After that real host-process restart,
`runtime_render_component({ renderId })` recovered the same render, component,
bundle, application manifest, and state in 132 ms. The call performed no source
write, successful compile, or new render binding.

The repaired historical recovery probe then constructed two more independent
runtime instances. All 19 checks passed: 1,132,353 compiled HTML bytes, stable
component/bundle/public-binding/recovery digests, both actions, the declared
tool, all three modes, exact saved state, and eight unchanged UI-state files.
The retained report has SHA-256
`CA8DB0A95CB68949350B1D871FD5608D494AFAB4C8A875F43D1938B643A2280E`.

The verifier initially contradicted its own isolation comment by placing its
diagnostic memory database under the workspace; current runtime policy rejected
that path. `scripts/verify-ui-history-recovery.mjs` now uses a unique temporary
database outside the workspace and removes it after disposal.

## Honest remaining gates

This is not the publication UI capture. The following remain unproven here:

- a reviewed recording of the compiled pixels mounted in the historical chat
  message with no stuck placeholder;
- a human clicking the visible action and tool controls rather than a generic
  MCP client invoking the same startup-registered bridge;
- Codex granting, denying, falling back from, or reporting unsupported for the
  fullscreen and PiP requests; and
- reopening the historical message after restart and reviewing its restored
  pixels in one uncut capture.

Those claims remain gated by the capture storyboard and independent review.
