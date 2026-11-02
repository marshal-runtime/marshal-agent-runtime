# `@marshal/agent-runtime-provider-artifacts`

Filesystem-backed artifacts with explicit principal-owner, workspace, project,
and session scopes. The principal namespace is always the outer storage
boundary, so identical workspace and logical-path values cannot cross users or
agent owners. Paths remain contained beneath a host-selected root.

Pre-1.0 stores used an unowned `workspaces/` layout. That namespace is denied
by default. A host may nominate exactly one principal kind plus
`legacyAccess.ownerPrincipalId` (kind defaults to `agent` for compatibility) and
choose `read-only` or incremental `migrate-on-read`; all other principals remain
denied. Every legacy path component is checked against the canonical storage
root, including no-prefix list operations. New writes always use the principal namespace. Migration copies with
exclusive-create semantics and then removes the legacy file, so an existing
owner-scoped file wins a collision. Operators should back up and review the
legacy root before enabling migration because the old layout has no trustworthy
owner metadata from which Marshal could infer an owner automatically.
