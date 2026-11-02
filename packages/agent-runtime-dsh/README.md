# `@marshal/agent-runtime-dsh`

Portable compatibility for the pinned `dsh-plugin-bridge` v0.3.0 release
(`6280fa5168e12a9fdff0f3f7479e4fb89eba0caf`). The adapter loads the unchanged
`lib/index.js` default `apply(ctx, config)` entrypoint and supplies bounded,
deterministic Cordis `commands` and `apiProxy` services. Activation and cleanup
are ordinary Runtime extension ownership; UI projections contain only portable
resource and application contracts.

Package discovery is advisory and offline: `createDshCatalogSource` returns a
host-materialized package root and pinned integrity request with origin `dsh`.
