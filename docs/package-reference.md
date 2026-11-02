# Versioned package reference

This table is the documentation/version audit for current workspace packages.
`pnpm docs:validate` compares it with every `packages/*/package.json`, checks
the exact package README heading, and validates documentation links. A version
or description change must update this table in the same change. Inclusion does
not imply registry publication or fresh-install certification.

The boundary column comes from [`runtime-boundaries.json`](../runtime-boundaries.json).
“Portable” describes dependency direction, not a promise that every package is
useful without a host composition.

The table includes workspace compatibility packages as well as the default
Runtime closure. The `@quillstone/*` packages are developed in
`marshal-runtime/quillstone` and consumed here as released tarballs pinned by
`quillstone.lock.json` and committed under `vendor/quillstone/`, so they are not rows of this table. Ordinary
`@marshal/runtime` composition uses 26 internal Marshal and Quillstone packages and avoids the legacy provider aggregate;
Brain/memory is one separately installed optional extension, while the retained
Brain, provider-aggregate, and Codex packages support frozen compatibility
paths. The five repositories conventionally present under `extensions/` are
discovery candidates only, not installed or enabled packages.

<!-- package-table:start -->
| Package | Version | Boundary | Purpose | Package documentation |
| --- | --- | --- | --- | --- |
| `@marshal/agent-runtime-code-intelligence` | `0.1.0` | portable | Default code-intelligence services for the Marshal agent runtime | [README](../packages/agent-runtime-code-intelligence/README.md) |
| `@marshal/agent-runtime-codex` | `0.1.0` | adapter | Codex MCP adapter for the portable Marshal agent runtime | [README](../packages/agent-runtime-codex/README.md) |
| `@marshal/agent-runtime-codex-capabilities` | `0.1.0` | adapter | Portable Codex subagent and declarative custom-UI capability providers | [README](../packages/agent-runtime-codex-capabilities/README.md) |
| `@marshal/agent-runtime-composer` | `0.1.0` | portable | Harness-neutral binding composer for the Marshal agent runtime kernel | [README](../packages/agent-runtime-composer/README.md) |
| `@marshal/agent-runtime-conformance` | `0.1.0` | portable | Harness-neutral conformance assertions for Marshal runtime adapters | [README](../packages/agent-runtime-conformance/README.md) |
| `@marshal/agent-runtime-core` | `0.1.0` | portable | Portable capability discovery and execution kernel for agent harnesses | [README](../packages/agent-runtime-core/README.md) |
| `@marshal/agent-runtime-delegation` | `0.1.0` | portable | Portable transport for spawning, waiting for, and cancelling delegated agents | [README](../packages/agent-runtime-delegation/README.md) |
| `@marshal/agent-runtime-dsh` | `0.1.0` | adapter | Portable DSH/Cordis compatibility adapter for Marshal Runtime extensions | [README](../packages/agent-runtime-dsh/README.md) |
| `@marshal/agent-runtime-effects` | `0.1.0` | portable | Portable native effects, durable background jobs, and harness-owned scheduling | [README](../packages/agent-runtime-effects/README.md) |
| `@marshal/agent-runtime-extensions` | `0.1.0` | portable | Portable live extension package loading and lifecycle management for Marshal runtimes | [README](../packages/agent-runtime-extensions/README.md) |
| `@marshal/agent-runtime-host` | `0.1.0` | portable | Infrastructure-only local host for explicit Marshal runtime composition | [README](../packages/agent-runtime-host/README.md) |
| `@marshal/agent-runtime-manifest` | `0.1.0` | portable | Versioned harness-neutral capability and routing manifest for Marshal runtime adapters | [README](../packages/agent-runtime-manifest/README.md) |
| `@marshal/agent-runtime-permissions` | `0.1.0` | portable | Default-deny scoped permission broker for the Marshal agent runtime | [README](../packages/agent-runtime-permissions/README.md) |
| `@marshal/agent-runtime-provider-artifacts` | `0.1.0` | portable | Scoped durable artifact provider for the Marshal agent runtime | [README](../packages/agent-runtime-provider-artifacts/README.md) |
| `@marshal/agent-runtime-provider-kit` | `0.1.0` | portable | Shared provider helpers and durable lifecycle receipts for Marshal agent runtime providers | [README](../packages/agent-runtime-provider-kit/README.md) |
| `@marshal/agent-runtime-typescript` | `0.1.0` | portable | Portable direct TypeScript execution and TypeScript-authored extension materialization for capability-brokered agent runtimes | [README](../packages/agent-runtime-typescript/README.md) |
| `@marshal/agent-runtime-ui` | `0.1.0` | portable | Portable, permissioned React UI compilation and MCP Apps resources for agent runtimes | [README](../packages/agent-runtime-ui/README.md) |
| `@marshal/codex` | `0.1.0` | adapter | Marshal Codex adapter, host integrations, plugin projection, and default composition | [README](../packages/codex/README.md) |
| `@marshal/runtime` | `0.1.0` | portable | Extensible agent runtime, TypeScript execution, portable UI, permissions, jobs, and composition | [README](../packages/runtime/README.md) |
<!-- package-table:end -->

The package version is not the same as the runtime protocol, capability
manifest, renderer resource, application manifest, plugin cachebuster, or eval
corpus version. Release evidence must record each applicable version explicitly.
