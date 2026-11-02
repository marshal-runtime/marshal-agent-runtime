# Marshal Agent Runtime

A portable programmable capability and application plane for agent harnesses.

The runtime owns capability discovery, execution, scopes, permissions, receipts,
editable TypeScript, portable custom UI, verified extensions, and the default
typed knowledge service that reads a Brain. Memory, attachments, and harness
integrations remain explicitly composed. Codex is an adapter, not a dependency
of the portable runtime.

## What Marshal adds

Marshal turns a conventional tool-calling agent into a programmable runtime without
introducing a workflow DSL or coupling the core to one product:

- **Editable TypeScript execution** for disposable computations, reusable workspace
  modules, and multi-capability composition through one permissioned broker.
- **Typed knowledge tools** (search, context, impact, status) that read a Brain
  and answer "Brain not configured" when the workspace has no Brain route.
- **Persistent React applications** delivered through MCP Apps, with structured
  fallbacks, declared runtime-backed actions, inline/fullscreen/PiP negotiation, and
  adapter-selectable UI authoring profiles.
- **Live editable interfaces** whose stable chat card follows successful TSX, CSS,
  import, configuration, and package revisions while retaining immutable compiled
  history and the last known-good revision on compile failure.
- **Dynamic native-agent orchestration** from ordinary TypeScript: sequential,
  parallel, conditional, iterative, and bounded recursive delegation with durable
  handles, cancellation, idempotency, and complete receipt trees.
- **Live verified extensions** for explicitly installing, updating, disabling, and
  removing capabilities, resources, catalogs, and applications without restarting
  the kernel.
- **Composable providers** for artifacts, attachments, memory, code intelligence,
  effects, jobs, scheduling, and future capabilities without changing the execution
  or UI architecture.

The installed adapter projects selected package declarations into MCP metadata,
skills, lifecycle briefings, hooks, UI resources, and native callbacks. Runtime
search preserves live capability results and additively discovers package skills,
resources, selected host tools, and existing UI applications.

## Package ownership

`@marshal/runtime` is the public portable facade. `createAgentRuntime()` uses
`@marshal/agent-runtime-code-intelligence` for the default knowledge service and workspace paths; it stores no index.
Optional memory and attachment implementations are composed separately; they are
not copied into the Runtime core or activated merely because they are installed.

The `@marshal/runtime` facade release closure contains the current Marshal and Quillstone
packages. Default installed-host intelligence seeds the 24-package production
dependency closure that owns the implementation; the facade and its conformance
package remain in the release closure without becoming separate default
implementation descriptors. Optional Brain, memory-provider, and
provider-aggregate packages are excluded. Brain is delivered as one optional
extension from its separate repository; Runtime does not install or activate it
automatically, and new hosts should not manually reconstruct its legacy built-in
composition.

Codex packages remain in this checkout for the frozen compatibility path. Portable
packages do not depend on Codex, and new integrations should use the Runtime host,
typed services, and extension contracts directly.

## Package boundaries

The public facade and focused packages keep ownership explicit:

- `@marshal/runtime`: kernel, host composition, typed services, TypeScript,
  portable React/declarative UI, permissions, receipts, jobs, effects, scheduling,
  delegation, verified extensions, and host-neutral capability contracts.
- `@marshal/agent-runtime-code-intelligence`: the default knowledge service: workspace identity and storage paths, and
  knowledge tools that answer "Brain not configured" until a Brain extension supplies them.

Focused implementation packages include:

- `agent-runtime-core`: protocol, discovery, execution, permissions, receipts, and lifecycle ports.
- `agent-runtime-composer`: dependency-minimal kernel/lifecycle/resource bindings.
- `agent-runtime-delegation`: bounded harness-neutral agent delegation, cancellation, and receipt trees.
- `agent-runtime-dsh`: detachable compatibility for the pinned, unchanged DSH/Cordis bridge.
- `agent-runtime-effects`: portable native-effect dispatch and durable background jobs.
- `agent-runtime-extensions`: verified local extension loading, live activation,
  owned cleanup, resources, and UI application registration.
- `agent-runtime-permissions`: default-deny scoped permission decisions.
- `agent-runtime-typescript`: inline and file-backed TypeScript execution.
- `agent-runtime-provider-kit`: shared provider lifecycle and receipt helpers.
- `agent-runtime-provider-artifacts`: scoped durable artifacts.
- `agent-runtime-ui`: portable MCP Apps resources, React/declarative applications,
  live workspace revisions, and fallbacks.
- `agent-runtime-host`: empty-capable host plus explicit runtime-builtins and package
  discovery source factories.
- `agent-runtime-codex-capabilities`: Codex-native capability implementations.
- `agent-runtime-codex`: Codex MCP, hooks, resources, and native-effect mapping.
- `agent-runtime-conformance`: adapter contract tests.

Dependencies point inward: adapters depend on the runtime; the runtime never imports an adapter.

## Trust boundary

Brokered TypeScript is cooperative, defense-in-depth execution—not a security
boundary for malicious code. Use external OS/container/VM isolation for
untrusted source. See [the security model](docs/security-model.md).

## Install note

Use Node.js 24.14 or newer and the pinned pnpm version:

```sh
corepack pnpm install
corepack pnpm build
```

For a host composition example, including typed service
replacement, and optional extensions, see
[`@marshal/runtime`](packages/runtime/README.md).

## Harness contract

A minimal harness exposes MCP `runtime_search` and `runtime_exec`. Hooks can add
session lifecycle, while optional packages can add memory or other domain
capabilities. Native callbacks may fulfill product-owned effects such as visible
subagent creation or UI presentation. Unsupported effects remain explicit rather
than silently falling back to a different product model.

Ordinary `createAgentRuntime()` hosts create and discover the conventional
`process.cwd()/extensions` directory by default; the Runtime source checkout
gitignores that directory, but Runtime does not ignore it. Pass `extensions: false`
to opt out, or configure custom `allowedRoots` and `discoveryRoots`. Discovery
enumerates bounded direct-child repositories and bounded packages declared by each
repository's workspace configuration. A built package with matching package and
Runtime manifests becomes a candidate only; discovery does not install, enable, or
execute it. Installation verifies the package tree and loads the declared built
CommonJS entrypoint in the trusted host process. This is not a security sandbox,
and imports are limited to the exact fixed in-memory module map configured on the
loader rather than arbitrary dependency resolution.

Start with the [generic MCP quickstart](docs/generic-mcp-quickstart.md), the
[Codex installed-plugin guide](docs/codex-adapter-guide.md), or the
[adapter authoring and conformance guide](docs/adapter-authoring.md). The
[versioned package reference](docs/package-reference.md) is checked against all
publishable manifests.

## Validation and release dry runs

`pnpm verify:structure` checks explicit package classification, inward-only
portable dependencies, publishable manifests, and the absence of WBG/Electron
source. It also validates publication guides, relative links, package README
identity, and the versioned package table. `pnpm verify` additionally builds, typechecks, tests, and runs a dry-run
pack for every package. The pack check validates publish contents and workspace
dependency rewriting without creating tarballs or publishing anything.

`pnpm publication:offline` adds the shared conformance suite and a model-free
detached-package MCP smoke test. It does not replace the live-host and matched
model-evaluation gates listed in the publication checklist.

## Publication material

Editable publication examples and their offline validator live in
[`examples/publication`](examples/publication/README.md). The
[`compatibility matrix`](docs/compatibility-matrix.md),
[`limitations and threat model`](docs/limitations-and-threat-model.md),
[`publication checklist`](docs/publication-checklist.md), and
[`demo capture storyboard`](docs/demo-capture-storyboard.md) distinguish
implemented contracts and generated fixtures from uncut live evidence that is
still required before release claims are made.

The [`publication-readiness audit`](docs/publication-readiness-audit.md) maps
the current repository to every definition-of-done item. The
[`evidence index`](docs/evidence/README.md) records the exact local smokes and
benchmark snapshot that exist today, including known failures and blockers.
