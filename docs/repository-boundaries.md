# Repository boundaries

This repository deliberately excludes the Marshal Electron application, server routes, product pages, and workflow implementation.

It includes:

- Runtime protocol, kernel, execution engine, and host composition.
- Portable provider implementations and their capability dependencies.
- Portable UI compilation/resource support.
- Shared adapter conformance tests.
- Reference harness adapters in separate packages.
- Public runtime and adapter packages are independently installable; detachable
  domain extensions are published outside this repository.

Adapters are detachable packages. Removing `agent-runtime-codex` and `agent-runtime-codex-capabilities` must leave every portable package buildable and testable. Adding another harness must not require changes to core contracts unless the new behavior is genuinely portable.

One runtime monorepo is preferred initially because protocol and conformance changes are atomic. Adapters can move to separate repositories later without reversing dependency direction.

## Enforced classification

Every directory under `packages/` must be listed exactly once in
`runtime-boundaries.json` as either portable or adapter-owned. Portable packages
cannot depend on or import adapter packages, Codex, Electron, or Electron-scoped
packages. Relative imports cannot cross into an adapter directory either.

The focused packages remain migration internals. The public dependency direction is:

```text
@marshal/codex       -> @marshal/runtime
```

The generic host is empty-capable. Domain providers and portable built-ins are
selected explicitly with `RuntimeHostProviderSource`. Historical aggregate
behavior requires `createLegacyRuntimeProviderSource` plus an explicit runtime
built-ins source.

## Repository and release checks

`pnpm verify:structure` rejects WBG application roots, Electron dependencies,
source outside the package/script boundaries, unclassified packages, and
inconsistent release manifests. All packages publish their compiled `dist`
output, public source where declared, README, and license text with public
scoped-package access.

`pnpm pack:check` runs `pnpm pack --dry-run` for every workspace package. This
checks the exact publish file set and workspace-protocol dependency rewriting
without producing tarballs. It also rejects compiled or source test suites,
test fixtures, repository internals, and missing license files. The structural
manifest gate rejects package license text that differs from the repository's
canonical license. CI runs the
complete `pnpm verify` matrix on the
minimum supported Node release and the next active major across Windows, macOS,
and Linux.
