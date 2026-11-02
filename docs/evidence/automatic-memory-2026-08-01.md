# Automatic cross-task memory validation

Status: superseded historical compatibility-path evidence, not evidence for the current Memory Brain architecture and not a randomized release evaluation.

This run predates editable execution-block Brain operations. It used the now-disabled deterministic hook fallback, including synchronous recall injection. Current Marshal hooks only enqueue bounded observe/reflect evidence; the main agent or an execution block calls semantic Brain remember/recall, and a long-lived worker processes queued observations.

## Write task

Fresh Codex task alias `memory-write-task` ran in an
unrelated non-git workspace with this prompt:

> Remember that my publication accent color is ultramarine.

Prompt SHA-256:
`E743906E9B79DC4B408BEBB184821C84C67923A53C647B09E1ADFC4A98A9F817`

The compatibility `UserPromptSubmit` lifecycle hook stored an agent-scoped semantic memory
before the response. The model made no memory tool call. The stored content was
`My publication accent color is ultramarine.` with confidence `1.0` and tags
`explicit-memory` and `user-requested`.

Local trace:
`%USERPROFILE%\.codex\sessions\2026\08\01\memory-write-task.jsonl`

Trace SHA-256:
`BD291A28104FA5E6F4A5ADD86ABFADFE134086FE1B6EBC11D6FBCE783806A9E6`

## Failure found during recall validation

The first recall task proved that retrieval worked but host injection did not.
The hook found the exact agent-scoped memory in 38 ms and wrote it to the
lifecycle receipt, but the model did not receive it and performed manual memory
searches. Root cause: the Codex adapter emitted top-level `additionalContext`.
Codex's hook wire contract requires:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "..."
  }
}
```

The adapter and regression test were corrected before the passing run below.
The failed attempt remains available under task alias
`memory-failed-recall-task`, trace SHA-256
`93C95F0874B5FDCDF9D255C0D9E255E7013DC38E7D69FC9811A2633A97CCE4C8`.

## Passing fresh-task recall

After redeploying the fixed hook adapter, fresh Codex task alias
`memory-passing-recall-task` ran in a third unrelated workspace:

> What publication accent color did I choose earlier?

Prompt SHA-256:
`6B9F12FDB4C6A949397D896C13615F92C97FD8601F51D9B8DBA228B244B1D7EC`

The compatibility hook injected the exact memory before model inference. Codex replied
`You chose **ultramarine**.` using 13 output tokens. It performed zero skill
reads, commands, capability searches, or memory tool calls.

Local trace:
`%USERPROFILE%\.codex\sessions\2026\08\01\memory-passing-recall-task.jsonl`

Trace SHA-256:
`0C5AAA0F07C324B5A43D44F1AC9EA13D1814889F4381037D5AECE55A1CCC2BE2`

The unredacted traces are intentionally local until reviewed. This validation
proves one real write/recall pair on the superseded fallback and preserves the discovered failure; it does not validate the current queue/worker/semantic-Brain boundary and does not substitute for the frozen multi-case memory evaluation corpus.
