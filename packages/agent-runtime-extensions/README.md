# `@marshal/agent-runtime-extensions`

Portable live extension installation for an already-running `RuntimeKernel`.
Hosts provide materialized local package roots and an allow-listed loader
boundary; this package performs no package-manager or network resolution.

Each package contains `runtime-extension.json`, matching `package.json`
identity/version/entrypoint metadata, and one bundled CommonJS entrypoint. The
host supplies the expected domain-separated SHA-256 tree digest. Loading rejects
unbounded roots, traversal, links, mutable reads, invalid manifests, unsupported
imports, and integrity mismatches before activation.

Source repositories may additionally declare a trusted preparation script:

```json
{
  "installation": {
    "script": "marshal:install",
    "packageManager": "pnpm"
  }
}
```

The portable extension manager never runs this script. A Node host may run it
only for an explicit, unpinned local materialization, then calculate integrity
over the resulting package. The script is trusted repository code and owns
dependency installation, code generation, native compilation, and bundling.
Pinned packages and manifests without `installation` retain the existing
prebuilt-package behavior.

Hosts may expose `RUNTIME_EXTENSION_STATUS_SERVICE` as the portable UI-facing
administration contract. Its immutable, monotonically revisioned snapshots
report exact package roots, detected/installing/installed states, typed
diagnostics, resolved package-manager commands, and configuration
schema/default/current values. The service owns no package-manager behavior;
Node hosts implement preparation and publish status revisions through the
portable subscription contract.

`RuntimeExtensionManager` transactionally owns capability providers, catalog
providers, resources, UI applications, UI placement registrations, and activation
cleanup. Install, update, disable, enable, and removal leave the kernel itself
alive. Failed activation or registration cleans up the staged version and
preserves the previous active version; successful unload revokes only
registrations owned by that activation.

```ts
import {
  LocalRuntimeExtensionPackageLoader,
  RuntimeExtensionManager,
} from '@marshal/agent-runtime-extensions';

const extensions = new RuntimeExtensionManager({
  kernel,
  activationContext,
  uiPlacementDefinitions: [{
    placementId: 'marshal.shell.sidebar',
    metadata: {
      title: 'Sidebar',
      hasHostContent: false,
      supportedActions: ['replace', 'augment', 'fallback'],
    },
  }],
  loader: new LocalRuntimeExtensionPackageLoader({
    allowedRoots: [hostMaterializedPackagesRoot],
    modules: {
      // Exact trusted APIs may be injected by the host. Nothing resolves implicitly.
      '@example/runtime-api': runtimeApi,
    },
  }),
});

await extensions.install({
  packageRoot,
  integrity: hostPinnedIntegrity,
});

const sidebar = extensions.uiPlacements.resolve('marshal.shell.sidebar');
```

An activation references an existing UI application by ID:

```ts
return {
  uiApplications: [{
    id: 'dashboard',
    title: 'Dashboard',
    description: 'Extension dashboard.',
    renderId: 'example-dashboard',
    resource,
    application,
  }],
  uiPlacements: [{
    placementId: 'marshal.shell.sidebar',
    action: 'fallback',
    applicationId: 'dashboard',
  }],
};
```

Placement collisions fail with
`RuntimeExtensionError.code === "UI_PLACEMENT_REGISTRATION_FAILED"` and preserve
the previously active registrations. Disable, removal, failed install, and
failed update never leave stale placement ownership.

Extension code is verified and import-restricted but executes in the host Node
process. It is trusted code, not an isolation boundary; untrusted packages still
require an external process/container/VM policy.

The underlying `RuntimeExtensionUiPlacementRegistry` can also resolve standalone
registration sets. Placements use stable IDs and explicit parent IDs, advertise
supported replace/augment/fallback actions, and may opt in to full subtree
replacement. A placement resolves one host, replacement, or fallback base and
composes every active augmentation around that base. Resolution is deterministic
and returns portable red-display diagnostics for exact and ancestor/descendant
replacement collisions; placement registration does not grant agent
capabilities.
