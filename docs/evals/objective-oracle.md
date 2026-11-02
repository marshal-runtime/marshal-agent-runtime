# Deterministic objective oracle

`scripts/evals/objective-oracle.mjs` contains an exhaustive rule for all 55
non-human assertions in frozen corpus `v1`. Corpus validation fails if an
assertion lacks a rule or a stale rule references a removed assertion.

Rules inspect only captured phase output, trace events, observed tools,
receipts, and bounded generated artifacts. Exact fixture values are used for
event/deployment enrichment, release metrics, citations, memory facts,
permission denial, and code-path questions. Missing evidence returns a boolean
failure; the oracle never asks a model, infers a fractional score, or fills a
gap from prose.

Assertions that require actual renderer interaction or native host state use a
strict host-fact boundary. A host fact passes only when `actual` is exactly
`true` and it contains at least one typed reference to captured evidence:

```json
{
  "state-restored": {
    "actual": true,
    "evidence": [
      { "kind": "screenshot", "ref": "restore-after-restart.png", "sha256": "<captured-file-sha256>" },
      { "kind": "trace-event", "ref": "state-read-receipt-17", "sha256": "<canonical-event-sha256>" }
    ]
  }
}
```

Every kind, reference, and SHA-256 tuple must also occur in the adapter's
captured-evidence inventory; an arbitrary label or digest mismatch scores zero.
The desktop-host adapter remains responsible
for producing and preserving those referenced screenshots, state probes,
action receipts, and mode events.
The adapter and oracle are both hash-pinned, and UI evidence must be redacted
and blind-safe. A label without evidence references scores zero.

The command driver executes the oracle inside the same descendant-confinement
profile as Codex. Its code SHA-256 is part of the run configuration and its
combined attestation is recorded in every live evidence record.
