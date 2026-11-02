# `@marshal/runtime`

The public Marshal runtime surface: capability discovery and execution, live verified
extension installation, explicit provider-source composition, TypeScript execution,
portable React and declarative UI, permissions, receipts, jobs, effects, scheduling,
and delegation.

The package is a public facade over the focused portable implementation packages.

## Harness adapters

`@marshal/runtime/mcp` exposes `createRuntimeToolAdapter()` and
`createRuntimeMcpServer()`. Supply the composed host's kernel and a trusted
session context; optional resource and lifecycle ports map the harness's native
surfaces. Runtime owns canonical schemas, dispatch, cancellation and result
envelopes. The two reserved tools cannot be shadowed by resource tools. Model
arguments cannot supply identity or workspace authority. Native hooks call the
adapter's lifecycle port; those callbacks are not advertised as model tools.

The `marshal-runtime-mcp` executable provides a neutral stdio composition without
Codex dependencies. Its launching host supplies `MARSHAL_RUNTIME_MCP_CONFIG`:

```json
{
  "workspacePath": "/srv/workspaces/example",
  "privateRoot": "/var/lib/my-agent/marshal",
  "principalId": "stable-owner-id",
  "sessionId": "stable-task-id",
  "harnessId": "my-harness",
  "permissionPatterns": ["runtime.inline_module.execute", "runtime.module.execute"]
}
```

The executable enables brokered TypeScript and artifacts, with default Quillstone
intelligence (`codeIntelligence: false` opts out). Additional permissions default
to none. It disables extension discovery, effects, scheduling, and custom UI;
hosts selecting those features compose `createAgentRuntime()` explicitly and
pass its ports to the same adapter. State is partitioned by harness and owner.
Start a separate process for each trusted session; a model request cannot switch
the process's session. Acme's gateway-owned adapter manages these connections
through ADK, with tenant isolation and durable run-fence checks.

Use `@marshal/runtime/host` for explicit host composition and
`@marshal/runtime/host/lifecycle` for lifecycle infrastructure. Use
`@marshal/runtime/extensions` for the local package loader, extension contracts,
TypeScript authoring exports, and live lifecycle manager.

Authoring and extension execution are cooperative defense-in-depth features, not a
security sandbox. Host permissions, receipts, and lifecycle controls remain
authoritative.

## Install and start

```sh
pnpm add @marshal/runtime
```

Compose the host explicitly. `protectedLifecycleResultRoot` must be an absolute
harness-private directory outside the workspace.

```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentRuntime } from "@marshal/runtime/host";
import { createRuntimeServiceContainer } from "@marshal/runtime/services";

const workspacePath = resolve(".");
const privateRoot = await mkdtemp(join(tmpdir(), "marshal-runtime-"));

const serviceContainer = createRuntimeServiceContainer();
const runtime = await createAgentRuntime({
  workspacePath,
  protectedLifecycleResultRoot: privateRoot,
  serviceContainer,
});

try {
  // Use runtime.kernel, runtime.lifecycle, runtime.resources, and serviceContainer.
} finally {
  await runtime.dispose();
}
```

Ordinary `createAgentRuntime()` registers the typed Quillstone service and its
permissioned `code.index.*` and `knowledge.workspace.*` capabilities. Set
`codeIntelligence: false` only when the host intentionally opts out. The separate
`createRuntimeBuiltinsSource()` factory adds artifacts, TypeScript, effects, and
other portable capabilities; it is not required to obtain code intelligence.

Configure Quillstone through the host's `codeIntelligence` option:

```ts
codeIntelligence: {
  workspaceDataRoot,
  runtimeDataRoot,
  embeddingsEnabled: false,
}
```

Omitting both embedding options uses `MARSHAL_RUNTIME_EMBEDDINGS_ENABLED` and the
bridge-owned local provider. `embeddingsEnabled: false` or
`embeddingProvider: null` disables vectors while retaining lexical and graph
search. A custom `embeddingProvider` is injectable; the two options are mutually
exclusive.

A missing user-workspace index is not created at startup. The caller must request
`knowledge.workspace.ensure({ mode: "create-if-missing" })`, satisfy the trusted
host's explicit local approval flow, allow the accepted background job to finish,
and then retry the original intelligence operation. Runtime does not claim a
remote cluster or automatically retry the agent's operation.

## Workspace authority

For multi-workspace hosts, `resolveWorkspace` is a trusted per-call adapter seam.
Runtime ignores caller-supplied path authority and validates the resolver's
absolute path plus stable workspace and project IDs before constructing the
invocation scope. Code-intelligence consumers should resolve the currently
selected typed service at call time and use `service.forContext(context)` so
workspace routing and live overrides remain current.

## Typed services and live replacement

Service contracts use globally stable typed tokens. Pass one
`RuntimeServiceContainer` to the host and resolve services at call time so scoped
replacements remain live:

```ts
import { RUNTIME_CODE_INTELLIGENCE_SERVICE } from "@marshal/runtime/intelligence";

const replacement = await serviceContainer.replace(
  RUNTIME_CODE_INTELLIGENCE_SERVICE.token,
  { useValue: customCodeIntelligence },
);

try {
  // Callers resolving the token now receive customCodeIntelligence.
} finally {
  await replacement.dispose(); // Restores the previous selected service.
}
```

## Optional extensions

Ordinary `createAgentRuntime()` creates and discovers the conventional
`process.cwd()/extensions` directory by default. The Runtime source checkout
gitignores that directory; Runtime does not ignore it. Opt out explicitly when a
host must not expose extension discovery:

```ts
const runtimeWithoutExtensions = await createAgentRuntime({
  workspacePath,
  protectedLifecycleResultRoot: privateRoot,
  extensions: false,
});
```

Hosts may instead configure custom `allowedRoots` and `discoveryRoots`. Discovery
checks bounded direct-child repositories and bounded package roots declared by
their workspace configuration. A package is eligible only when its built CommonJS
entrypoint and matching `package.json` and `runtime-extension.json` are valid.
Discovery creates a candidate; it does not execute, install, or enable it. The host
must explicitly install through `RUNTIME_EXTENSION_CATALOG_SERVICE` and enable
through `RUNTIME_EXTENSION_LIFECYCLE_SERVICE`; persisted installed records restore
by default unless `restore: false` is selected.

Verified extension code executes in the trusted Node.js host process. Integrity
and path checks are not a security sandbox, and the entrypoint can import only the
exact fixed in-memory module map configured on the loader, not arbitrary
dependencies. Installed extensions may contribute optional lifecycle callbacks and
durable job handlers; the host manager owns their registration and cleanup. A
separately installed Brain extension can use those surfaces, but it is not a
default Runtime dependency.

The MCP CLI accepts a host-owned `extensions` array of `{ packageRoot, configuration? }`
with absolute installed package roots. It materializes and verifies each package,
activates it through the normal extension lifecycle, and fails startup if an extension
is not enabled and healthy. Stored packages outside that explicit list are not restored.
The MCP resource plane exposes readable extension resources; native navigation is not
required. Extensions with native placements must offer a headless configuration.

A trusted absolute `bootstrapModule` may export `bootstrap({ config, delegation,
request })`, returning injected loader `modules`, host `providerSources`, and optional
`dispose`. `request(operation, input)` makes a structured MCP sampling callback marked
`marshal.host-operation`; the launching host must validate operations and owning scope.
`hostOptions` is opaque host configuration. Agents cannot alter these fields through
`runtime_exec`. This lets gateways add native delegation and browser transports without
adding harness or extension identities to the portable Runtime.

`runtime_search({ catalogId: "runtime.agent-guidance" })` returns optional agent
instructions describing the running Runtime and successfully installed extension
guidance. Adapters decide whether to inject this into their native model prompt.
