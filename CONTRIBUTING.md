# Contributing

Keep changes inside the smallest package boundary that owns the behavior. Portable packages may expose new ports or effects, but may not import a harness SDK. Add or update conformance coverage whenever an adapter-facing contract changes.

Before submitting a change:

```sh
corepack pnpm install
corepack pnpm verify:structure
corepack pnpm verify
```

The structural check is dependency-free and should be run before installation
when importing or extracting packages. It catches accidental application source,
Electron coupling, missing package classification, and invalid publish metadata.
`pnpm verify` includes dry-run packing; it does not publish or create tarballs.
The workspace requires the exact pnpm version declared in `packageManager` for
build, test, and pack commands so a different global pnpm cannot change results.

For a new adapter, document its identity mapping, lifecycle support, native effects, UI behavior, approval behavior, and unsupported fallbacks.
