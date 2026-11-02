# Codex release candidate r — 2026-08-01

## Result

Detached candidate `r` was the locally installed Marshal Codex plugin candidate
at the time of this observation. It was deployed only after the complete
repository verification and the separate evaluation, offline-publication, and
package gates passed. It is historical and has been superseded by deployment
`20260802a` / plugin `0.1.0+codex.20260802092659`.

This is deterministic and narrow local-live evidence. It does not establish
desktop rendering, restart recovery, matched model improvement, cross-platform
registry installation, or publication readiness.

## Immutable deployment

- historical deployment: `%USERPROFILE%\.marshal\codex-runtime-0.1.0-20260801r`
- CLI entrypoint SHA-256:
  `1AC13FB7AD5EAB6A7764B96682F939F929EBE74F94366BFF833BA96DEF227EC6`
- plugin version: `0.1.0+codex.20260801170744`
- generated `.mcp.json` SHA-256:
  `298F3A8F194C76F224EFD5F98B805C4D5AFE214780199F7C5C9C6AB95E023A27`
- generated `plugin.json` SHA-256:
  `112D35B017E817D0203A8008797B80912E3AE9B958EF0F15082D4CADDC38E455`
- source and installed-cache plugin trees: 6 files each, exact per-file SHA-256
  match
- MCP configuration: root `mcpServers` wrapper, Node command, single argument
  pinned to candidate `r`, `adaptive-agentic` permission profile, no package or
  Node-builtin wildcard authority
- `codex mcp list --json`: Marshal enabled and resolved to the pinned candidate
  entrypoint

## Verified gates

- `pnpm verify`: all 20 builds and typechecks, every workspace test suite,
  package boundaries, manifests, documentation, and 20 dry-run tarballs passed.
- Eval contract: 18 cases, 55 objective assertions, 8 treatments, 6 frozen
  files, and 25/25 protocol tests passed.
- Offline publication: shared standards-only adaptive-application conformance
  and detached generic MCP restart, memory, receipt, UI, and workspace-isolation
  checks passed.
- Adaptive installed smoke: authored React compiled with exactly `trusted_ui`;
  trusted Node remained denied; component
  `13426fe2b9f7198fa15226db06bd0102811fd8272fa06a2a415b070d184d4f29`.
- Native delegation smoke: one real Codex child completed under the
  `bounded-agentic` profile; delegation
  `delegation-4ae7cca6-9278-468c-a37e-aa4695de69ab`; marker
  `MARSHAL_NATIVE_DELEGATION_OK_40f63eac9fc54494`.
- Scheduling smoke: exact discovery returned full schemas; a read returned an
  explicit adapter-level `unsupported` result when no scheduler was supplied;
  create remained denied under the default permission profile.

## Remaining live gates

The Codex desktop process must be fully restarted before claiming that the app
is using this plugin version. A fresh desktop task must then verify autonomous
routing and the historical render, inline/fullscreen/PiP controls, declared
actions, and real application restart. The frozen 108-attempt matched run,
reviewed media, registry artifacts, supported OS/Node matrix, and independent
security/privacy/accessibility/reproducibility reviews also remain open.
