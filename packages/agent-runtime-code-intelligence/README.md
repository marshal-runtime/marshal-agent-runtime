# `@marshal/agent-runtime-code-intelligence`

The default knowledge service for Marshal Runtime. It keeps the workspace identity and storage paths and stores no index; knowledge tools answer "Brain not configured" until a Brain extension supplies them.

```sh
pnpm add @marshal/agent-runtime-code-intelligence
```

The package exports the generic knowledge contracts, the "Brain not configured" index and provider, and the Runtime
service bundle. `@marshal/runtime/intelligence` reexports the same public surface.

## Runtime service

`RUNTIME_CODE_INTELLIGENCE_SERVICE` is the composition descriptor for
`RuntimeCodeIntelligenceService`; use its `.token` with a
`RuntimeServiceContainer`. The service provides bounded:

- `search`, `context`, `impact`, and `detectChanges`
- `status`
- `upsertDocument`, `removeDocument`, and `mutateDocuments`
- `forContext(context)` for host-authoritative workspace binding
- `paths()` and `workspaceIndex()` for host integration
- `requestIndex()` for a bounded, explicitly owned index lease

The descriptor participates in the Runtime composition registry. Capability
providers resolve `RUNTIME_CODE_INTELLIGENCE_SERVICE.token` from the shared
container at call time, so a `RuntimeServiceContainer.replace()` override is
visible until its handle is disposed.

Use `service.forContext(context)` for workspace reads and document operations.
The invocation context contains the workspace path and stable IDs resolved by the
trusted host for that call; caller-provided paths are not an authority source. The
service keeps at most 16 host-resolved workspace routes.

`requestIndex()` lets an optional memory or other trusted extension provide its own
absolute project, projection, and data roots and own the returned lease lifetime.
The lease is memory-only. It does not make memory mandatory, silently discover
storage roots, or authorize workspace maintenance.

## Default Quillstone configuration

Ordinary `createAgentRuntime()` enables the service. Its `codeIntelligence` option
and the lower-level `createRuntimeCodeIntelligenceBundle()` accept explicit roots
and embedding configuration:

```ts
codeIntelligence: {
  workspaceDataRoot,
  runtimeDataRoot,
  embeddingsEnabled: false,
}
```

Omitting embedding options uses `MARSHAL_RUNTIME_EMBEDDINGS_ENABLED` and the
Quillstone bridge's default local embedding provider. Set
`embeddingsEnabled: false` or `embeddingProvider: null` to keep lexical/graph
search without vectors. A custom provider is injectable; do not set both options.
Set `codeIntelligence: false` on the host to disable the default service entirely.

The workspace data root defaults to the protected profile state tree at
`<protected-root>/marshal-memory/<profile>/code-intelligence/repositories/<repositoryCommonId>`.
`repositoryCommonId` is derived from the canonical Git common directory, or from
a hashed canonical directory identity outside Git. Parallel worktrees therefore
share the coordinated base store while retaining distinct logical routes and
overlay manifests. Project/workspace memory authority defaults to
`<protected-root>/marshal-memory/<profile>/project-projections/<projectIdDigest>`;
Brain's scope directories remain below that stable project root, so linked
worktrees share authoritative Markdown while distinct projects do not.
Runtime-owned indexes remain below the Runtime state root, and profile-memory
Markdown and Quillstone storage remain under separate profile-owned roots
outside repository-common storage. All explicit roots must be absolute and are
preserved unchanged for contextual worktree routes.

Existing derived indexes under `<workspace>/.marshal/quillstone` are not moved
or converted automatically. With default configuration the protected shared
route starts uninitialized and is rebuilt through the existing approved
`knowledge.workspace.ensure` flow. Supplying the old location explicitly as
`workspaceDataRoot` retains the previous physical route.

Existing project-memory authority directly below the former unkeyed
`<profile-root>/project-projections` root is also not moved automatically.
During migration, keep that directory as an explicit `projectProjectionRoot`
or re-project the authoritative Markdown into the new project-keyed root before
removing the override.

## Capabilities and lifecycle

Read and maintenance operations are separate:

- `code.index.status`, `code.index.initialize`, `code.index.refresh`,
  `code.index.repair`, `code.index.rebuild`, and `code.index.remove`
- `knowledge.workspace.status`, `knowledge.workspace.ensure`,
  `knowledge.workspace.refresh`, and `knowledge.workspace.remove`

Constructing the service does not create a missing workspace index. Workspace
creation is requested with
`knowledge.workspace.ensure({ mode: "create-if-missing" })` and remains behind the
trusted host's explicit local approval and high-risk index permission flow. With
the normal host job manager, an approved request returns accepted/running while
initialization continues in the background; the agent can continue other work and
must retry its intelligence operation after the job finishes. There is no
automatic operation retry or remote-cluster fallback.

Workspace status includes bounded repository-common, worktree, Git-common,
base-commit, overlay-digest, and base/overlay/composed generation diagnostics
when the selected route is a worktree composition.

Initialization is per repository: once any checkout of a repository is
initialized, every Git worktree of it opens the shared base plus its own overlay
without a separate approval. `knowledge.search` answers for the session's
workspace only: its code route plus that workspace's memory routes. The private
Runtime index and extension routes are never searched; they stay registered so
their nodes still resolve for context and impact, and Runtime capabilities are
found through runtime catalog search. When the workspace's own code route is
uninitialized, rebuilding, or unavailable, a code search fails with
`knowledge_workspace_index_unavailable` and names the next step instead of
returning other routes' hits; memory-only searches (`kinds: ["memory"]`) still run.

The selected default service initializes its private Runtime index in the
background and projects bounded package manifests, Runtime extension descriptors,
and declared JavaScript/CommonJS entrypoints. After descriptor preparation, startup
and reselection always rebuild this private index so cancelled initialization
cannot leave a stale generation. Approved workspace indexes and extension-owned
leases retain their normal reuse behavior. When the extension lifecycle service is
present, it indexes only enabled package roots and requests only enabled entries
from the live extension catalog. Install/enable adds an extension route without a
restart; disable/remove retires it from federation and catalog hits. When the
portable extension status service is present, Quillstone subscribes to its
revision stream instead of decorating lifecycle methods, so any host UI using
the shared contract receives the same committed visibility changes.

An optional Brain extension from its separate repository may request its own
bounded index lease and contribute lifecycle callbacks or durable job handlers
through the host extension manager. It is not installed automatically and does
not require the legacy provider aggregate.

## Runtime search development corpus

Run `pnpm --filter @marshal/agent-runtime-code-intelligence benchmark:runtime-search`
to compare the kernel's in-memory lexical search with Quillstone BM25 over the
same captured Runtime builtins inventory. Add `-- --hybrid` to include the
embedding-backed hybrid mode. The benchmark reports judged capability and
catalog quality, cold and warm latency separately, negative-query hits, and
live publication/retirement checks for extension-owned capabilities and catalog
entries. It is a development corpus, not a release-quality human evaluation.
