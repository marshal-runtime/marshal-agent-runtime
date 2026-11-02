# `@marshal/agent-runtime-manifest`

Versioned, harness-neutral source of truth for Marshal capability discovery and
natural routing. Adapters project the manifest into MCP instructions, tool
metadata, skills, lifecycle briefings, native callback hints, examples, and
evaluation labels instead of maintaining independent prompts.

The package contains no harness imports. Routing classification is a
deterministic reference oracle for golden tests and evaluation labeling; model
routing remains driven by the projected descriptions and examples.
