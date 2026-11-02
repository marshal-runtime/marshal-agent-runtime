# Codex Brain versus Codex-only recorded demo

This demo launches two genuine Codex sessions at the same time to answer the same symbol-free architecture question.

The controlled variables are identical:

- Codex CLI build: `0.149.0-alpha.4.3`
- outer model: `gpt-5.6-terra`
- reasoning effort: `low`
- workspace: `Q:\src\.marshal-worktrees\quillstone-demo-runtime-03aafbe`
- sandbox: read-only
- prompt text
- user configuration, repository instructions, authentication, and other installed plugins

The sole treatment difference is:

- `marshal-control-demo`: both Marshal runtime profiles disabled
- `marshal-brain-demo`: `marshal-runtime@marshal-demo828` enabled

The Brain profile receives the Marshal skills and MCP runtime. The control profile receives neither. Both profiles layer on top of the normal Codex configuration and do not modify its normal enabled state.

## Prepare the profiles

Copy the two profile templates beside the normal Codex configuration:

```powershell
Copy-Item .\scripts\demos\codex-brain-comparison\marshal-brain-demo.config.toml $env:USERPROFILE\.codex\marshal-brain-demo.config.toml
Copy-Item .\scripts\demos\codex-brain-comparison\marshal-control-demo.config.toml $env:USERPROFILE\.codex\marshal-control-demo.config.toml
```

## Record a question

Use Windows Snipping Tool in screen-recording mode. Choose video capture, select the full desktop, and start recording. Then launch one paired question:

```powershell
pwsh -File .\scripts\demos\codex-brain-comparison\launch-pair.ps1 -QuestionNumber 1
```

Stop and save the native recording after both panes show `FINISHED`. Repeat with question numbers 2 and 3.

One question is recorded per clip so every comparison starts from two fresh Codex sessions. Exact terminal transcripts, elapsed times, and completion records are written under `Q:\marshal-demo\codex-brain-comparison\runs\<run-id>`.

Windows denies background `gdigrab` access to this interactive desktop with error 5, so capture start and stop must remain manual. Prompt selection, treatment isolation, concurrent launch, transcripts, and timers are scripted.

## What this demo proves

This narrowly demonstrates wall-clock answer speed and visible search behavior for a real Codex agent with Marshal/Brain available versus the same Codex setup without Marshal.

It does not isolate Quillstone from SQLite inside Brain, establish broad retrieval quality, or replace the larger end-to-end memory evaluations.
