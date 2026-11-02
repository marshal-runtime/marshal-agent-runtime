# Release engineering

Marshal's publication tooling prepares and verifies releases without deciding who owns the source repository or npm scope and without choosing versions, tags, registry access, or publication identity.

## Deterministic inventory

After a frozen install, regenerate and verify the checked-in SPDX 2.3 SBOM and license inventory:

```sh
pnpm release:inventory
pnpm release:inventory:check
```

The inventory covers every publishable workspace package and each directly declared runtime, optional, or peer dependency. Dependencies are references, not bundled Marshal content. The lockfile hash, canonical MIT license hash, exact installed direct-dependency versions, and declared license expressions make drift reviewable. The SPDX creation timestamp is a documented fixed sentinel so identical inputs produce byte-identical output.

Reviewed outputs: [SPDX 2.3 SBOM](release/sbom.spdx.json) and [license inventory](release/license-inventory.json).

## Authority boundary

`.github/release-authority.example.json` is deliberately unconfigured. An authorized maintainer must copy it to `.github/release-authority.json`, then explicitly supply:

- canonical repository, homepage, and issue URLs;
- npm registry URL, scope owner, access, and distribution tag;
- the intended version of every package;
- every observed license expression plus a human/legal review reference;
- GitHub server, repository, and protected environment identity; and
- the matching npm Trusted Publisher owner, repository, workflow, and environment.

No token, password, OTP, or secret belongs in that file; the validator rejects credential-shaped fields. After authority is supplied, package manifests must use the authorized repository URL and per-package directory, homepage, bugs URL, access, scope, and exact versions:

```sh
pnpm release:authorize
```

Until those human decisions are made, the template gate passes but release authorization intentionally fails. This is a safety property, not an incomplete default.

The current deterministic inventory includes a direct `PolyForm-Noncommercial-1.0.0` dependency reference. That is disclosure, not approval. The publication owner must decide whether the dependency and intended distribution/use are acceptable, record the review, and explicitly authorize every observed expression. Unresolved or unreviewed licenses fail closed.

## Ordered dry run

Inspect the deterministic dependency order without registry access:

```sh
pnpm release:plan
```

After the authority file and package metadata agree, run the real npm dry-run matrix:

```sh
pnpm release:publish-dry-run
```

Each package is first packed by the pinned pnpm version so `workspace:` references become publishable ranges. The resulting tarball is then passed to `npm publish --dry-run` in dependency order using the explicitly authorized registry, access, and tag. Nothing is uploaded.

## Packed-manifest integrity

`pnpm pack:check` creates each workspace tarball in an isolated temporary
directory and inspects the manifest inside the archive. The gate proves that
pnpm rewrote every `workspace:` dependency to the intended published version,
that all declared exports and command entrypoints are present, and that no
test-only, Git, or `node_modules` path entered the package. Temporary archives
are removed after validation; the command neither installs dependencies nor
contacts the registry.

This archive inspection is distinct from `pnpm release:publish-dry-run`. The
former is deterministic and authority-free; the latter additionally proves
the authorized registry, access, tag, provenance, and dependency-order policy
without uploading.

## Provenance workflow

`.github/workflows/publish.yml` is manual-only and uses npm Trusted Publishing rather than a long-lived npm token. The publish job is skipped unless repository variables explicitly enable it and bind it to the current GitHub repository and a non-empty environment. Configure the named environment with required reviewers and deployment protection rules. Configure npm's Trusted Publisher with exactly the owner, repository, `publish.yml` workflow filename, and environment recorded in the authority file.

The operator must also provide the full immutable SHA selected by the workflow-dispatch event, matching tag/access, and exact confirmation phrase. The workflow rejects a SHA other than `GITHUB_SHA`, checks it out without persisted GitHub credentials, runs the complete verification and release gates, verifies the authority against GitHub variables and dispatch inputs, requires npm 11.5 or newer, and only then publishes dependency-ordered pnpm tarballs with `npm publish --provenance` using GitHub OIDC.

The repository cannot guarantee that a GitHub environment has reviewers or that npm Trusted Publishing was configured correctly; those are external controls and remain release-owner decisions.
