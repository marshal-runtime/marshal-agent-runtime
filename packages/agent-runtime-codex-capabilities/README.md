# `@marshal/agent-runtime-codex-capabilities`

Portable `@marshal/agent-runtime-core`-compatible providers for two Codex-specific surfaces:

- visible Codex child-agent threads, including isolated Git worktrees;
- persisted declarative UI artifacts with an MCP Apps resource adapter.

There are no workflow, stage, or lambda concepts in this package.

## Composition

```ts
import { RuntimeKernel } from '@marshal/agent-runtime-core';
import { createCodexCapabilityProviders } from '@marshal/agent-runtime-codex-capabilities';

const kernel = new RuntimeKernel();
const codex = createCodexCapabilityProviders({
  workspacePath: 'C:/work/project',
  stateRoot: 'C:/work/project/.agent-runtime',
  // Optional, explicit trusted base outside the checkout:
  worktreeRoot: 'C:/work/.agent-worktrees/project',
  allowedUiOperations: ['memory.search', 'code.search'],
  operationInvoker: {
    invoke: (target, input, context) =>
      kernel.runtimeExec({ protocolVersion: '1.0.0', target, input }, context),
  },
});

for (const provider of codex.providers) kernel.register(provider);
```

Stable factory result:

```ts
{
  providers: CapabilityProvider[];
  subagents: CodexSubagentProvider;
  ui: DeclarativeUiMcpAppsResourceAdapter;
  mcpAppsResources: DeclarativeUiMcpAppsResourceAdapter;
  uiProvider: DeclarativeUiProvider;
  uiStore: DeclarativeUiStore;
  dispose(): Promise<void>;
}
```

The factory uses the installed `@openai/codex` app-server by default. A harness can inject its own `SubagentBackend` to share an existing connection, enforce host permissions, or supply native visible-thread APIs.

The factory can also own an installed GitHub Copilot CLI backend:

```ts
createCodexCapabilityProviders({
  workspacePath,
  stateRoot,
  subagentDefaultBackend: 'copilot',
  copilotCli: {
    model: 'gpt-5.6-luna',
    reasoningEffort: 'medium',
    yolo: true, // trusted host policy only
  },
});
```

`runtime.delegation.spawn` accepts optional `backend: 'codex' | 'copilot'`;
omitting it uses `subagentDefaultBackend`, whose compatibility default is
`codex`. Copilot reuses the installed CLI login, creates the first turn with a
runtime-owned session UUID, and resumes later turns by that UUID. It executes
the installed native binary without a command shell and redacts credential-like
URLs and values from bounded process errors.

## Subagent operations

- `codex.subagents.spawn`
- `codex.subagents.run`
- `codex.subagents.list`
- `codex.subagents.send` — steer an active turn
- `codex.subagents.follow_up` — start and await a new turn
- `codex.subagents.wait`
- `codex.subagents.inspect`

The default bundle now exposes the harness-neutral `runtime.delegation.*`
provider instead of these raw thread operations. It maps portable handles to
Codex thread IDs in the factory-configured repository and persists only current
executable delegation state below the configured runtime state root. Git
worktree and branch selection remain host-owned raw Codex options rather than
portable delegation fields. The portable layer adds no execution policy or
limits. Raw
`codex.subagents.*` registration is available only through the explicit
`delegation.exposeRawCodexSubagents` compatibility option.

Every returned thread `cwd` is checked against configured workspace/worktree roots. The default backend uses current Codex app-server methods: `thread/start`, `thread/list`, `thread/read`, `turn/start`, and `turn/steer`. App-server approval requests are declined by this backend; a host that owns approval brokerage should inject its own backend.

## Codex/OpenAI UI authoring profile

The adapter registers `openai-apps-sdk-ui@1.0.0` as its preferred authoring
profile. It truthfully advertises the pinned `@openai/apps-sdk-ui` package,
OpenAI/MCP Apps design tokens, inline/card/carousel/fullscreen/PiP guidance, and
feature-detected OpenAI extensions, plus explicit accessibility and responsive
layout requirements. The adapter resolves only the advertised package; the
portable compiler verifies its exact identity/version and each declared
transitive dependency edge before reading module bytes, while remaining unaware of
Codex or OpenAI packages. `reactUi.includeCodexAuthoringProfile: false` detaches
this edge for standards-only or alternate-harness conformance tests. Fully
custom React/CSS remains valid under the always-present `marshal-standards`
profile.

The Codex adapter also exports a file-backed record-authenticator factory. The
portable store consumes only its HMAC port; Codex owns key placement and may
place React UI state in a separate `reactUiStateRoot`. This prevents copied or
fabricated workspace-state JSON from bypassing the `trusted_ui` compiler and
registered-component graph audit.

The Codex adapter maps portable spawn, continue, wait, and explicit cancel
operations directly to native threads. Wait has no delegation timeout and never
cancels a child. Sandbox, approval, tool inventory, and environment policy
remain owned by the Codex backend rather than the delegation transport.

`worktreeIsolation: true` requires an explicit `worktreeRoot` or injected provisioner. Source checkouts are resolved inside `workspacePath`; generated worktrees are resolved beneath the real path of the separately trusted worktree root. Branches use `codex/runtime-agent/` by default.

An isolated worktree is an adapter-owned lease until the native task succeeds.
The adapter releases the lease after spawn failure, run failure, or cancellation;
successful worktrees remain available for inspection and folding. Custom
`WorktreeProvisioner` implementations must implement the same idempotent
`release` contract.

## Declarative UI operations

- `ui.artifacts.create`
- `ui.artifacts.update` with optimistic `expectedRevision`
- `ui.artifacts.get`
- `ui.artifacts.list`
- `ui.artifacts.delete`
- `ui.actions.invoke`

Documents can contain only `stack`, `card`, `heading`, `text`, `badge`, `button`, `input`, `select`, `progress`, `divider`, and `table` nodes. There are no authored HTML, JavaScript, CSS, URLs, iframe, media, or raw event-handler fields.

Artifacts are isolated under a SHA-256-derived workspace/project/session/principal scope. IDs and paths are validated, writes are atomic, revisions are monotonic and immutable, and document/node/table/string limits are enforced. Resource, render, and action requests bind both the revision number and canonical document digest, so a historical message cannot resolve against a newer document.

Actions bind a declared button ID to an allow-listed runtime operation. Static inputs contain scalars only; `eventMap` can copy only validated top-level scalar event fields. Every action carries a scoped idempotency key; completed mutations replay their durable receipt instead of executing again. Confirmation-bound actions return `confirmation_required` until explicitly reinvoked with `confirmed: true` and the same operation key. Recursive `ui.actions.invoke` bindings are forbidden.

## MCP Apps adapter

`bundle.mcpAppsResources` can be consumed by the main MCP server. MCP Apps links resources from static tool metadata, so the adapter exposes one stable template URI in addition to optional per-artifact resources:

```ts
const resources = await bundle.mcpAppsResources.listResources(context);
const content = await bundle.mcpAppsResources.readResource(
  'ui://marshal-declarative/runtime-renderer',
  context,
);
const toolMeta = bundle.mcpAppsResources.toolMetadata();
```

The MCP server integration is:

1. Advertise `resources: {}`.
2. Route `resources/list` to `listResources(activeInvocationContext)`.
3. Route `resources/read` to `readResource(uri, activeInvocationContext)`.
4. Register a static `runtime_render_ui` MCP tool with `toolMeta` merged into its descriptor.
5. Its handler accepts `{artifactId, revision, documentDigest}`, invokes the exact `ui.artifacts.get` revision, and returns `{artifact}` as `structuredContent`.

The static renderer consumes `ui/notifications/tool-result`, renders nodes only through DOM APIs, and never uses authored markup. Result-level dynamic UI metadata is returned as portability information but is not required for the stable MCP Apps linkage.

Resources use the stable MCP Apps MIME type `text/html;profile=mcp-app`, nested `_meta.ui.resourceUri`, and empty `connectDomains`, `resourceDomains`, `frameDomains`, and `baseUriDomains`. The generated fixed renderer has a hash-based CSP with `connect-src 'none'`, no forms, frames, objects, fonts, or media. Authored strings are escaped and never interpreted as markup. UI actions use standard MCP Apps JSON-RPC `tools/call` over `postMessage` to invoke `runtime_exec` → `ui.actions.invoke`.

## Validation

```powershell
npm --prefix packages/agent-runtime-codex-capabilities run verify
```

Set `CODEX_REAL_BACKEND_SMOKE=1` to additionally run the installed Codex app-server list smoke test; it is skipped by default because it depends on local Codex installation/authentication state.
