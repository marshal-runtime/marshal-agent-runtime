# `@marshal/agent-runtime-codex`

Detachable Codex adapter for the portable agent runtime. This package depends
inward on `@marshal/agent-runtime-host` and owns all Codex-specific behavior:

- `createCodexRuntime()` composition and Codex permission defaults;
- MCP tools/resources and stdio transport;
- session, turn, and subagent hook event translation;
- the `agent-runtime-codex` and `agent-runtime-codex-hook` executables;
- Codex subagent and custom-UI capability attachment.

The generic host has no dependency back to this adapter.

Requires Node 24.14 or newer from an official distribution, or a compatible
build whose built-in `node:sqlite` enables FTS5.

## Installable Codex plugin

Install this package globally, then generate an installation-local plugin into
any plugin source directory:

```powershell
npm install --global @marshal/agent-runtime-codex
agent-runtime-codex-install-plugin --destination C:\path\to\plugins\marshal-runtime
```

To install a detachable composition, pin its absolute ESM entrypoint without
changing the lightweight hook composition:

```powershell
agent-runtime-codex-install-plugin `
  --destination C:\path\to\plugins\marshal-runtime `
  --kernel-module C:\path\to\composition\dist\index.js `
  --adaptive-agentic
```

The generator pins the MCP and hook commands to the installed package's Node
entrypoints, so desktop and noninteractive hosts do not depend on shell `PATH`
resolution. Regenerate the plugin whenever the adapter installation changes.
Its `.mcp.json` uses Codex's canonical `{ "mcpServers": { ... } }` companion
shape, which is accepted by the current Codex plugin loader and plugin-creator
validator. The evaluation reader continues to accept older direct-map and
`mcp_servers` fixtures for backwards-compatible evidence replay.
The MCP CLI uses its packaged `createCodexRuntime` binding by default, while
`--kernel-module` remains available for custom composition.
The generated plugin is brokered/default-deny. Use `--bounded-agentic` for a
documented environment that preauthorizes bounded native-agent spawn, steering,
and cancellation without enabling trusted Node or wildcard imports. Use
`--trusted-local` only when the installed plugin should deliberately enable
trusted Node execution. React UI package authority is never wildcarded: in this
profile Codex derives concrete package names from the workspace
`package.json` dependencies and dev/optional/peer dependencies. Additional
packages must be declared by the project or named explicitly through
`MARSHAL_RUNTIME_ALLOWED_UI_PACKAGES`.

The plugin asks Codex to approve its MCP transport calls automatically so it
works in fresh and noninteractive tasks. That is not capability authority:
Marshal's broker still enforces permission profiles, scopes, declared bounds,
cancellation, and receipts for every invocation. Users can override this
plugin-scoped MCP approval policy in Codex configuration.

## MCP surface

- `runtime_search` discovers compact capability descriptors by default. Resolve
  a selected result with `{ "name": "capability.name" }` to obtain its full
  input/output schemas. Broad callers can request `detail: "full"` explicitly
  for compatibility.
- `runtime_exec` invokes an `operation`, an `inline_module`, or a `module` from
  inline source, a workspace file, or a scoped artifact.
- `runtime_session_start`, `runtime_observe_turn`, and `runtime_session_end`
  expose lifecycle integration when direct hooks are unavailable. They accept a
  protocol version and stable event ID; omitted event IDs are derived from the
  request so host-side durable replay protection works across MCP restarts.
- `runtime_render_ui({ artifactId, revision, documentDigest })` displays one immutable declarative UI revision only.
- `runtime_render_component({ renderId })` is registered at task start and
  displays compiled React immediately. Reusing the same render ID performs no
  source write, compilation, render creation, dynamic-tool refresh, or browser
  fallback. The mounted MCP App retrieves its compiled payload and persists
  sandboxed `localStorage` through app-only tools that are hidden from the model.
  Cached history results can restore the payload by `structuredContent.render.id`
  even when Codex does not replay the original tool-input notification. Compiled
  components, renders, and UI state use durable project scope, so navigation and
  application restarts do not depend on the old MCP process or task session.
  Dynamically registered per-render tools remain a compatibility path.
  Codex keeps executable UI state below `~/.marshal/codex/ui-state` and seals
  component/render records with a harness-held HMAC key below
  `~/.marshal/codex/keys` (both paths have absolute-path environment overrides).
  Unsigned workspace-era records fail closed and must be recompiled.

A lifecycle session maps to the Codex task/thread, not an assistant turn. Start
it once and reuse it across follow-ups; an ordinary final response must not end
the session or invalidate session-scoped UI, artifacts, and provider state.
When the task actually ends—or the MCP connection is disposed—the adapter
invalidates its bounded tool/resource context cache so a later task cannot
inherit the ended task's session, thread, agent, or receipt correlations.

## Run

```powershell
npm --prefix packages/agent-runtime-codex run verify
node packages/agent-runtime-codex/dist/cli.js `
  --kernel-module ./packages/agent-runtime-codex/dist/index.js `
  --workspace .
```

The binding module may instead be any package exporting `createAgentRuntime`,
`createCodexRuntime`, a default factory, or `runtimeBindings`. This keeps the MCP
transport usable with independently versioned runtime compositions.

The standalone MCP process writes a metadata-only lifecycle journal below
`~/.marshal/codex/diagnostics` (override with the absolute
`MARSHAL_RUNTIME_DIAGNOSTIC_ROOT`). Each process gets its own bounded journal;
only the newest 20 journals are retained and each is capped at 256 KiB. Entries
cover startup, readiness, requested shutdown, shutdown failure, fatal exception,
top-level startup failure, and exit. They deliberately omit argv, cwd,
environment variables, workspace paths, tool inputs, error messages, and stacks;
errors are represented by byte count, a SHA-256 fingerprint, and a small
allowlist of operating-system error codes.

## Hooks

Each configured Codex hook pipes one JSON object to
`packages/agent-runtime-codex/dist/hookCli.js`. Session and prompt hooks emit
`additionalContext`; observation and termination hooks emit `{}`.
Hook payloads are translated to deterministic event IDs. Re-delivery of the same
hook therefore reaches the harness-neutral lifecycle gate as the same event.
The hook executable uses `createCodexLifecycleRuntime`, a separate composition
containing only stable identity and scoped lifecycle journals.
It does not construct the MCP runtime, code intelligence, TypeScript, UI, effects, jobs,
scheduling, artifacts, or native-delegation providers.

Main-session and subagent start hooks inject only the portable Marshal capability
briefing and scoped runtime identity; they do not retrieve or inject semantic
memory. The portable host owns the briefing; this adapter supplies only the
Codex-visible `runtime_search` and `runtime_exec` entry-point names.

Hooks are fast durable producers, not model workers. Prompt, tool, assistant,
compaction, and child-session events append to an adapter-owned immutable,
bounded transcript spool. Compaction opens a numbered segment in the existing
session epoch, and parent transcripts receive only bounded child
start/completion references, never child transcript bytes or sealed paths.
Session end queues one idempotent sealed review; startup recovers abandoned
epochs as explicitly incomplete reviews. Private lifecycle results live outside
the workspace at
`~/.marshal/codex/protected-lifecycle-results`; override that root only with the
absolute `protectedLifecycleResultRoot` option or
`MARSHAL_RUNTIME_PROTECTED_LIFECYCLE_ROOT`.

The disposable Quillstone index uses the same profile/project/workspace routing
dimensions under a separate root. Configure it with the absolute `knowledgeDataRoot` option or
`MARSHAL_RUNTIME_KNOWLEDGE_DATA_ROOT`; on Windows the default base is
`%USERPROFILE%\.q`. Keep this root external to the repository. Windows
incremental publication clones the active native generation with ReFS block
cloning (copy-on-write). A first publication or full rebuild can therefore work
on NTFS while a later incremental memory mutation degrades when the generation
clone cannot prove shared ReFS extents. Canonical Markdown is already durable at
that point, so this is a delayed
derived-index publication, not memory loss; rebuilding reconstructs Quillstone
from Markdown.

Live Codex federation is opt-in and uses only explicit trusted route
configuration. `quillstoneFederation.localRoute` names the existing Codex
workspace index, while every entry in `trustedRoutes` supplies its own absolute
project, projection, and data roots. Runtime never scans registries, parent
directories, or foreign workspaces to discover routes. Federated search is
bounded by `maxConcurrency`, RRF-merges the bridge results, deduplicates
canonical memory identity, and returns route-qualified provenance and generation
vectors. Context, impact, change detection, and mutation resolve one route from
the `[route]value` returned by search, or use the configured local route for an
unqualified value; they never query all shards and post-filter the result.

```ts
const runtime = await createCodexRuntime({
  workspacePath: 'C:\\work\\current',
  quillstoneFederation: {
    localRoute: 'current',
    maxConcurrency: 4,
    trustedRoutes: [{
      route: 'shared-sdk',
      projectRoot: 'C:\\work\\shared-sdk',
      projectionRoot: 'C:\\marshal-private\\shared-sdk\\projection',
      dataRoot: 'C:\\marshal-private\\shared-sdk\\quillstone',
      projectId: 'shared-sdk',
    }],
  },
});
```

When a short external ReFS volume is available, prefer a root such as `Q:\.q`:

```powershell
$env:MARSHAL_RUNTIME_KNOWLEDGE_DATA_ROOT = 'Q:\.q'
```

Success means a provider mutation reports `projected`, publishes a new
generation without a recovery rebuild, and that generation immediately exposes
the new state and relationships through provider queries.

An opt-in, non-mutating two-round saved-auth protocol probe is available after a
build:

```powershell
$env:MARSHAL_RUN_LIVE_LUNA_PROBE = '1'
pnpm probe:warm-luna
```

It exposes no dynamic tools and performs no external provider mutations.

## Programmatic composition

```ts
import { createCodexRuntime } from '@marshal/agent-runtime-codex';

const runtime = await createCodexRuntime({
  workspacePath: process.cwd(),
  effectHandler: myCodexNativeEffectHandler,
  jobHandlers: myCodexJobHandlers,
});
```

Native effect and job handlers are injected outward through generic host ports;
they are not implemented inside the portable host. Supplying a handler does not
grant mutation authority: Codex composition must explicitly add the matching
`runtime.effects.execute` or `runtime.jobs.*` mutation permissions.
