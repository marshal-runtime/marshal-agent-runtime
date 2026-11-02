# Installed adaptive-agentic smoke — 2026-08-01

## Classification

`local-live-smoke`. This proves that an immutable detached Marshal candidate can
generate a narrowly scoped Codex plugin and, from an unrelated workspace,
compile authored React while continuing to deny trusted Node execution. It is
not evidence of desktop pixels, application actions, presentation modes,
restart recovery, or matched model-quality improvement.

## Installed artifacts

- detached candidate:
  `%USERPROFILE%\.marshal\codex-runtime-0.1.0-20260801o`
- personal plugin version: `0.1.0+codex.20260801141748`
- installed cache:
  `%USERPROFILE%\.codex\plugins\cache\personal\marshal-runtime\0.1.0+codex.20260801141748`
- permission profile: `adaptive-agentic`
- package wildcard: absent
- builtin wildcard: absent
- UI-package wildcard: absent
- generated launch: pinned to the detached candidate's Node entrypoint

The installed `.mcp.json` uses Codex's current direct server-map shape. The
repository's older generic plugin validator expects a wrapper shape and is not
treated as authority for this Codex-specific file.

## Repeated command and observed result

```powershell
node scripts/smoke-installed-adaptive-agentic.mjs `
  --deployment "$env:USERPROFILE\.marshal\codex-runtime-0.1.0-20260801o"
```

The repeated detached smoke exited successfully and reported:

- installed profile: `adaptive-agentic`
- pinned installed launch: verified
- `ui.compile` status: `success`
- permission decision: `allow`
- exact grant: `trusted_ui`
- component ID:
  `0f10998886a6ac8fc7de297d9d956038fc83d03d22a292de6e99b18bdabc07b9`
- trusted Node execution: denied
- workspace outside the repository: `true`

## Installed-plugin integrity

| Artifact | SHA-256 |
| --- | --- |
| `.mcp.json` | `CC836529CD71E463E03915885B7D375F9508895112DBB2CDEE00814AD9BD70A7` |
| `.codex-plugin/plugin.json` | `4C000C7C96BBCB66A4E8A293B5A07ADAEFB4A7DB6551CAA8A8DBFC8C83593F8C` |
| `hooks/hooks.json` | `54D4C7470E233714EBC713DCEAECE8091FED327E1F4DECAE109BA38738886D86` |
| `skills/use-marshal-runtime/SKILL.md` | `29E67FDAC435E35FADF6BE3D27DAED37CE06CFB11F18BAFDA7F09F6960A22888` |
| `references/react-authoring.md` | `48731D54EA61F64054711CD138A9CBCE123015CB30660D242CCC9E8EB2B4414B` |

## Remaining claim boundary

This smoke establishes the generated authority boundary and real React
compilation only. A fresh desktop-host run must still show the compiled
application, invoke declared actions and tools, negotiate inline/fullscreen/PiP
modes, persist and reopen state, and recover the historical render after a host
restart without recompilation.
