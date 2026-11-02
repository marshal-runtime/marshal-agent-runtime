# Runtime platform acceptance harness

Run the process/static campaign from the authoritative runtime worktree:

```powershell
pnpm acceptance:platform
```

Optional arguments are `--run-root`, `--host-worktree`, `--contract`,
`--session-id`, and `--pnpm-seed-store`. The default output is
`Q:\TestResults\marshal-runtime-live\<timestamp-commit-run-id>`.

The orchestrator captures both authoritative worktrees, creates and verifies a
tracked-plus-untracked platform snapshot under the run root, and performs all
install, build, test, pack, fixture, and process work only in that snapshot or
the run root. The host worktree is read-only. Package-manager cache/store paths
are also run-local. Package-manager subprocesses discard inherited npm/pnpm
configuration and credential variables, use run-local user/global npmrc files,
and retain `https://registry.npmjs.org/` only as recorded configuration; install
and deploy commands always use `--offline`.

The harness deterministically copies the selected pnpm v10 `index` and `files`
trees into the bounded run-local store. `--pnpm-seed-store` selects a known
complete store; otherwise the configured pnpm store is used. Every copied file
is SHA-256 compared, content-addressed files are checked against their SHA-512
store identity, source and target file identities must differ, and aggregate
source/target manifests, real paths, counts, and byte totals are recorded.
There is no registry fallback when the selected store is incomplete.

Inherited lifecycle/PATH entries pointing into either authoritative worktree
are removed before snapshot commands execute. The installed pnpm topology is
then checked for authoritative-worktree links and run-local store/virtual-store
paths. Story campaign modules are loaded from the verified external snapshot,
and a separate Node process imports the built snapshot and isolated-consumer
entrypoints, recording their resolved/real paths and hashes. Campaigns do not
start unless those entrypoints resolve to built `dist` files outside both
authoritative worktrees.

Common evidence includes environment/source manifests, command transcripts,
process and filesystem inventories, package archives, an isolated deployed
consumer, per-story JSON, story/bug ledgers, and final hashes.
Production failures are appended immediately to `bug-ledger.jsonl`; the final
`bug-ledger.json` and `summary.json` provide stable counts. Every passing story
links its process identity, filesystem roots/inventories, transcripts, fresh
package build hashes, and the final hash manifest.

`MRT-KRN-*`, `MRT-PUI-*`, and `MRT-LEG-002` may pass from required
`NODE-INTEGRATION`/`STATIC` evidence. Runtime support for `MRT-TS-*`,
`MRT-EXT-*`, and `MRT-LEG-001` records `runtimeSideStatus`, but their contract
status remains `NOT RUN` until required `LIVE-ELECTRON` evidence exists. A
runtime-side functional failure makes the contract status `FAIL`.
