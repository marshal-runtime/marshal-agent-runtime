# Security model

The runtime is a capability broker, not a hostile-code sandbox. Permissions,
scope binding, receipts, import allowlists, child-process limits, and Node's
Permission Model are defense-in-depth controls for cooperative agent-authored
code. They do not make prompt-injected or malicious JavaScript safe.

Use an OS sandbox, container, VM, or remote execution service for untrusted
code. Supply that implementation through a harness/provider port and keep its
filesystem, network, credentials, and package cache outside the host process.

The default brokered TypeScript worker uses a separate child process with a
minimal environment, Node's Permission Model, and a context-realm bridge. JSON
input, broker responses, console output, and timer handles cross that bridge as
inert values; host-realm functions and objects are not installed directly in
the authored module's global scope. This closes ambient-process access in the
supported cooperative path, but does not upgrade Node `vm` into a hostile-code
security boundary. Trusted Node execution remains a separate high-risk grant.

Native effects and background-job mutations are denied unless an adapter
explicitly grants them. Approval objects are never trusted by themselves: a
harness-owned verifier must authenticate an approval before retrying an
operation. Effect verification is an atomic verify-and-consume operation bound
to principal, full scope, effect kind, request digest, idempotency key, effect
ID, and expiry; caller evidence fails closed when no verifier exists. Workspace,
project, session, principal, and cancellation context
are host authority and must not be accepted from untrusted model arguments.
Typed native-effect families reserve their internal effect kinds. In
particular, `runtime.effects.execute` cannot invoke `runtime.schedule.*`; callers
must use the matching `runtime.schedules.*` operation and permission. Schedule
adapters must bind every lookup and mutation to the exact principal and full
host-supplied scope instead of trusting a schedule ID as global authority.

Effect replay stores acquire a durable, renewable execution claim before a
native callback runs. Claims serialize cooperative processes sharing one state
root and retain request-digest binding during stale-owner recovery. A process
may still die after a native system commits but before Marshal records the
result, so adapters must propagate the runtime idempotency key to native
mutation APIs whenever those APIs support idempotency.

Lifecycle event claims have the same fundamental callback-to-receipt crash
window. They serialize active cooperative owners and durably replay completed
or failed records, but stale-owner takeover is at-least-once. Harness adapters
must propagate the lifecycle `eventId` to side-effecting delegates and treat it
as the native idempotency key or transaction boundary.

Delegation topology and concurrency budgets are committed through the store's
atomic root reservation, not a process-local list/check/create sequence. A
harness-neutral file store binds dead-owner recovery to the observed lock token
and repairs the index-before-record crash window while holding that transaction.
A harness adapter must also distinguish enforceable delegated authority from
instructions. The Codex adapter can project native filesystem sandbox modes,
but it fails closed for requested tool, skill, effect, or fine-grained
permission restrictions that the current app-server cannot enforce. Its
default child process environment omits ambient credentials; explicitly
supplying an environment is a host-owned trust decision.

The current Codex `thread/start` protocol also lacks a per-thread tool/plugin
allowlist, so the adapter requires the host to explicitly attest
`ambientAuthority: "trusted-host"` before any native child is launched. The
reference runtime makes that attestation only under an explicitly selected
agentic or trusted permission profile.

UI and artifact stores reject traversal and symbolic-link escapes. MCP UI
always includes structured fallback content; rendering an MCP App does not
increase the capability permissions of the underlying operation.

Durable state and authored-source roots must be hosted on local filesystems
that expose a non-zero numeric inode consistently through Node.js. Marshal
fails closed when that identity is unavailable; network, virtual, or special
filesystems require host-specific conformance before use. Stable-file reads
open one descriptor, compare its identity with the pathname, and compare size
and mutable timestamps around the read. These checks detect observed target
replacement and snapshot drift, but Node.js does not provide portable
handle-relative traversal for every operation and Windows does not expose
`O_NOFOLLOW`. An actor able to rename a parent directory can still attempt a
swap-and-restore race between pathname attestations. State roots therefore
remain host-trusted directories that must be protected by OS permissions; use
an OS sandbox or separate account when another actor can mutate their parents.

UI action claims use one bounded, principal/scope/key-specific cross-process
transaction for acquisition, renewal, stale takeover, completion, and release;
only a lease owner may publish a successful replay record. Completed records
win recovery and cause any orphan lease to be removed.

Artifact storage places the principal owner outside workspace/project/session
segments. Pre-1.0 unowned artifact directories are denied by default and may
be exposed only to one explicitly nominated migration owner. The Codex adapter
derives durable ownership from an adapter-supplied stable user/profile
identifier when available. Without one it explicitly operates as
`installation-local-single-user`; the historical constant `codex` principal is
not used. Installation-local persistence must not be treated as isolation
between people sharing an OS account or Codex home.

Memory deletion has two distinct authorities. `memory.delete` is a reversible
soft delete and reports that mode. Irreversible `memory.purge` is not included
in the host's ordinary `memory.read`/`memory.write` grants: it requires an
explicit high-risk `memory.purge` grant, rechecks owner scope (including every
recursive derived row) inside the same immediate write transaction used for
mutation, scrubs live searchable content and sensitive linkage, and writes a
bounded GDPR tombstone. Canonical cleanup ignores caller metadata identifiers,
requires exact canonical owner matches, and preserves entities/events referenced
outside the authorized purge set. Purging the live SQLite rows does not erase old WAL
pages, filesystem snapshots, receipts/logs, remote processors, or backups.
Marshal leaves checkpointing, `VACUUM`, encrypted-key rotation, and backup
expiry to the operator because automatically performing them can block active
work and still cannot guarantee physical secure erase on every storage medium.

Receipt journals are bounded and scoped to the host state root. They may contain
stable installation/profile identifiers, operation inputs in provider receipts,
artifact references, and error details, so hosts must protect them as sensitive
operational metadata and redact them before publication. Receipt persistence is
observational: a storage failure cannot turn a denied or failed operation into a
success, and duplicate `receiptId` delivery must not create duplicate records.
