# Codex release candidate q — 2026-08-01

## Classification

`deterministic` plus a narrow `local-live-smoke`. Candidate `q` was built from
the integrated repository after the attempt-6 capstone fixes, detached from the
source tree, and was installed as the active personal Codex plugin at the time
of this observation. It is historical and has been superseded by deployment
`20260802a` / plugin `0.1.0+codex.20260802092659`. This is release-candidate
evidence, not a Marshal 1.0 release claim.

## Candidate and installed plugin

- detached runtime:
  `%USERPROFILE%\.marshal\codex-runtime-0.1.0-20260801q`;
- installed plugin version: `0.1.0+codex.20260801160544`;
- installed plugin path:
  `%USERPROFILE%\.codex\plugins\cache\personal\marshal-runtime\0.1.0+codex.20260801160544`;
- MCP launch entrypoint:
  `%USERPROFILE%\.marshal\codex-runtime-0.1.0-20260801q\dist\cli.js`;
- permission profile: `adaptive-agentic`;
- MCP tool timeout: 180 seconds;
- generated `.mcp.json` SHA-256:
  `ECABB5650AE7CE69FD64866A889885149AA832530DEAC453C3656AA6636E3DE9`.

The generated source and installed cache copies matched byte-for-byte for the
manifest, MCP configuration, hooks, Marshal skill, and React authoring
reference.

## Integrated repository gates

The uninterrupted `pnpm verify` run passed repository/package boundaries,
builds, typechecks, all package tests, and dry-run tarballs for 20 publishable
packages. Additional explicit gates passed:

- evaluation declaration validation: 18 cases, 55 objective assertions, 8
  treatments, and 6 frozen files;
- evaluation driver/oracle/security tests: 24 passed;
- dry-run package checks: 20 packages;
- offline detached publication: compact discovery, executable TypeScript,
  lifecycle replay, restart memory, receipt journal, standards-only UI,
  workspace isolation, and native-delegation dependency resolution.

## Installed adaptive-profile smoke

The candidate generated a pinned plugin from an unrelated temporary workspace.
Brokered React compilation succeeded with exactly `trusted_ui`; package,
builtin, and UI-package wildcards were absent; trusted Node execution was
denied. Component identity:
`cdc78d6153ac30154f60ca94249092ffbd818e2f4eeb2d4324684f4aa0102ac1`.

## Native Codex delegation smoke

A real native Codex child was spawned and awaited through the detached
candidate under `bounded-agentic`. Exact discovery/schema validation passed,
trusted Node authority remained false, and delegation
`delegation-8b163fde-ace5-433c-beef-cd1663d0095d` completed successfully with
marker `MARSHAL_NATIVE_DELEGATION_OK_4263ad36f0964ffe`.

This proves a single installed child-agent round trip. The attempt-6 capstone
separately exercised four concurrent roots twice; neither result substitutes
for the frozen cancellation/capacity/recursive matched evaluation.

## Known validator mismatch

The real Codex CLI installed the generated plugin and fresh tasks have loaded
the same direct-map `.mcp.json` shape. The plugin-creator validator currently
rejects that shape because it expects an `mcpServers` wrapper. Both the source
and installed plugin report the same two validator errors. This is retained as
tooling drift rather than silently changing a host-proven configuration.

## Remaining live/release gates

- fresh task and host restart using candidate `q` specifically;
- actual desktop pixels and human clicks for declared actions;
- granted, denied, fallback, or unsupported fullscreen/PiP outcomes;
- historical-message recovery after a real Codex application restart;
- frozen paid matched evaluations and blind grading;
- reviewed uncut capture plus derived GIF/MP4 media;
- published-registry and supported OS/Node matrix verification;
- independent security, privacy, accessibility, and reproducibility reviews.
