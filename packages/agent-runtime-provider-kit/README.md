# `@marshal/agent-runtime-provider-kit`

Shared provider construction helpers and durable, collision-safe lifecycle event receipts. The lifecycle coordinator permits one active lease owner, replays completed or failed records, and reclaims an expired owner with at-least-once callback delivery. A side-effecting callback must therefore use the stable `eventId` as its own idempotency key or transaction boundary: a process can die after its side effect commits but before Marshal records completion. This package contains no concrete memory, attachment, artifact, or code-intelligence provider.
