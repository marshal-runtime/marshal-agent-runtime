# Fresh-session implicit TypeScript routing smoke

Status: local validation evidence, not a release evaluation or matched baseline.

## Environment

- Date: 2026-08-01
- Codex CLI: repository-pinned executable, version 0.144.6
- Installed plugin: `marshal-runtime@0.1.0+codex.20260801113056`
- Runtime package: detached global deployment at
  `%USERPROFILE%\.marshal\codex-runtime-0.1.0-20260801c`
- Workspace: unrelated, non-git directory
  `%USERPROFILE%\.marshal\fresh-session-smoke-2`
- Fresh Codex task alias: `typescript-positive-task`

## Prompt

The prompt did not name Marshal, TypeScript, MCP, plugins, or subagents:

> Create a reusable module that normalizes a small list of incident records,
> run it on a sample, and preserve the editable source so it can be reused
> later. Do not ask me to choose an implementation strategy. Report the saved
> source and the verified result.

Prompt SHA-256:
`A5CC4A2952EC0BC7E6243467890B5D6A047D0F88F85CE724E72BBACAFD79095D`

## Observed result

1. Codex selected the installed Marshal skill autonomously because the task
   requested reusable editable source and a verified result.
2. It wrote `incident-normalizer.ts` in the unrelated workspace.
3. Its first Marshal execution call was the correct modern shape:

   ```json
   {
     "targetType": "module",
     "module": {
       "kind": "workspace_file",
       "path": "incident-normalizer.ts"
     },
     "input": ["three incident fixtures"]
   }
   ```

4. The execution succeeded with no diagnostics. Runtime duration was 338 ms,
   including 156 ms compilation and 166 ms execution.
5. The model did not call lifecycle tools; the Codex plugin hid those tools
   because native hooks own lifecycle events.
6. The source remained editable and was reported to the user with the verified
   normalized result.

Source SHA-256:
`FBC289D89B60EDDB2CFCFA8C118DCB10BA379E9699C6E711085BB2C0FEFF525A`

Local trace (public path alias):
`%USERPROFILE%\.codex\sessions\2026\08\01\typescript-positive-task.jsonl`

Trace SHA-256:
`C222823859DC5138BA9761F0C4A93BC6EFCB93FA09ED4972DEA4E45A22949C7A`

The trace is intentionally not copied into the repository until it is redacted
and reviewed. This smoke proves the specific fresh-session selection and first
execution-call behavior. It does not substitute for randomized paired runs,
negative controls, cost capture, or the design-studio capstone.

## Matched negative routing smoke

A second fresh task in another unrelated directory used the prompt:

> What is 17% of 80? Give only the answer.

Prompt SHA-256:
`BD5763475723769CFBE8CF076D3D634D09A7395AAD827141D543A51150950FDA`

Codex returned `13.6` directly with seven output tokens. It did not load the
Marshal skill, call a Marshal tool, write a file, or run a command. This is one
observed negative control, not a statistical regression result.

- Fresh Codex task alias: `typescript-negative-task`
- Local trace:
  `%USERPROFILE%\.codex\sessions\2026\08\01\typescript-negative-task.jsonl`
- Trace SHA-256:
  `69BC30FA5E30D0B9540729A4B6787D07BD27FED15FD72BA3C0B97F428CC4A98B`
