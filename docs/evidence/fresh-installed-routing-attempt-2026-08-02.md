# Fresh installed routing attempt — 2026-08-02

## Classification

`local-live-smoke`, interrupted and not a routing pass. The detached candidate
and personal plugin were updated while the Codex desktop process was already
running. A new task selected Marshal immediately, but the process still exposed
the previous plugin cache path and had not registered the new MCP server tools.

## Installed candidate

- Candidate root:
  `%USERPROFILE%\.marshal\codex-runtime-0.1.0-20260802a`
- Plugin version: `0.1.0+codex.20260802092659`
- Installed plugin root:
  `%USERPROFILE%\.codex\plugins\cache\personal\marshal-runtime\0.1.0+codex.20260802092659`
- Kernel module:
  `%USERPROFILE%\.marshal\codex-runtime-0.1.0-20260802a\node_modules\@marshal\codex-gitnexus\dist\index.js`
- Task alias: `fresh-installed-routing-task`

The model received this indirect prompt without the words Marshal, TypeScript,
MCP, plugin, or subagent:

> I have a growing set of incident records with inconsistent severity labels,
> owner names, and timestamps. Build me a reusable, editable transformation
> that normalizes them, run it on a representative sample, verify the result,
> and preserve it so I can rerun it later.

## Observed behavior

The first commentary selected the correct product behavior:

> I’m using the Marshal runtime skill because this calls for a durable,
> editable transformation—not just a one-off cleaned sample.

The task then reported that the catalog's cached Marshal path had rotated.
Because the already-running desktop process had not refreshed the reinstalled
plugin's MCP registration, the model began authoring a manual JSON-RPC client
to the pinned candidate. The validation was stopped before transformation work
continued.

This is evidence that the compact skill metadata routed correctly, but it is
not evidence that a fresh installed session can use Marshal naturally. The
valid retry boundary is a complete Codex desktop restart followed by a new
task. The partial task and files are retained rather than relabeled or removed.

## Separate deterministic installation evidence

Before this task, the same candidate passed:

- clean packed installation of the complete unpublished dependency closure;
- direct and Brain memory projection through the real embedded graph;
- process restart/reopen with SQLite byte reauthorization;
- profile isolation and workspace canary scanning; and
- unrelated-workspace MCP startup and discovery of all required tools,
  including `marshal_invoke_react_tool`.

Those deterministic checks establish packaging and transport behavior, not
desktop plugin refresh or autonomous task success.
