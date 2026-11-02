# Linux/WSL2 detached-package evidence — 2026-08-01

This is an offline, model-free cross-host proof for a Linux-local Marshal
deployment. It did not use the Windows global npm installation, Windows
`node_modules`, or a Windows-built deployment.

## Environment

- WSL `2.4.11.0`, kernel `5.15.167.4-1`, WSL2 Ubuntu `22.04.2 LTS`
- glibc `2.35`
- WSL's system Node was `12.22.9` and was intentionally not used
- Node `24.14.0` was extracted under
  `/root/.cache/marshal-linux-proof-20260801-dd107`; no apt, sudo, or global npm
  mutation was performed
- pnpm `10.32.1` through the downloaded Node distribution's Corepack `0.34.6`

The Node archive came from the official Node distribution and matched
`SHASUMS256.txt`:

```text
node-v24.14.0-linux-x64.tar.xz: OK
41cd79bb7877c81605a9e68ec4c91547774f46a40c67a17e34d7179ef11729df
```

## Source and candidate identity

The workspace was copied from the mounted checkout into the Linux filesystem,
excluding `.git`, `node_modules`, `dist`, and `.marshal`. Normalized tar hashes
of the source and its Linux copy matched immediately before installation:

```text
e73df5a430ced9b21ed6cebd7d870c2f083329786352c157b73ccd06bdf45252
```

The Linux-local deployment was produced with:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm --filter @marshal/agent-runtime-codex \
  deploy /root/.cache/marshal-linux-proof-20260801-dd107/candidate \
  --prod --legacy
```

The normalized candidate tree hash was:

```text
9ba73fd01347cef4a2103800ad1c6c491d9acc53363accf0765ff2de29f5e47f
```

Selected file hashes:

```text
77140ff20b23e8b95bc602d1cb078340bb2f149d75aabe0d231b36128f923a94  package.json
1ac13fb7ad5eab6a7764b96682f939f929ebe74f94366bff833ba96def227ec6  dist/cli.js
134063e133f0b4244fa3b251acf973d4fe4b4aeeacbdc135211bf480f59f1477  node_modules/@openai/codex/bin/codex.js
```

No inspected JavaScript, declaration, JSON, Markdown, or source-map file
contained either the Linux source path or the Windows checkout path. All 33
candidate symlinks were relative package-bin links; none were absolute or
broken. `codex --version` resolved from the candidate itself as `0.144.6`.

## Results

The exact candidate passed the generic MCP stdio smoke:

```bash
node scripts/smoke-detached-mcp.mjs \
  --deployment /root/.cache/marshal-linux-proof-20260801-dd107/candidate
```

Verified observations:

- capability discovery and brokered inline TypeScript execution
- same-process and cross-process lifecycle replay
- durable memory recall after restart
- execution receipt journal recovery
- standards-only, versioned MCP Apps resource metadata
- complete fallback plus inline/fullscreen/PiP application declaration
- cached render recovery after restart
- cross-workspace render isolation
- native delegation dependency resolution from the installed capabilities
  package (`@openai/codex` `0.144.6`, CLI entrypoint present)

Linux-local package tests also passed:

```text
@marshal/agent-runtime-host:        18/18
@marshal/agent-runtime-conformance:  5/5
@marshal/agent-runtime-codex:       36/36
dry-run package tarballs:           20/20
```

The detached plugin generator also ran from the candidate and produced a
relocatable bundle whose MCP command is `agent-runtime-codex` and whose
lifecycle tools are hidden because hooks own them.

## Bug found and fixed

`pnpm deploy` left a harmless `.bin` staging directory at
`packages/candidate`. `scripts/check-packs.mjs` assumed every directory below
`packages/` contained `package.json`, so `pack:check` crashed with `ENOENT`.
Package discovery now includes only manifest-bearing directories. The fixed
check passed for all 20 packages on both WSL2/Linux and Windows.

## Honest limitations

- WSL2 is a real Linux userspace and kernel boundary, but this is not evidence
  for a bare-metal distribution, macOS, ARM64, or a Linux CI image.
- This proves local stdio MCP and standards-only protocol behavior, not remote
  HTTP transport, public authentication, or marketplace publication.
- It does not prove pixels in a Linux host, fullscreen/PiP presentation,
  application action clicks, approval UI, or a paid native subagent run.
- pnpm reported ignored optional build scripts for ONNX Runtime, Sharp, Scarf,
  and protobuf packages. The tested runtime paths passed; untested optional
  native/embedding paths remain separate gates.
- The deployed tree occupied about `1.5 GB`: approximately `336 MB` was the
  Codex Linux package, `259 MB` ONNX Runtime, and `146 MB` GitNexus. Release
  size optimization remains worthwhile even though functionality passed.
- The WSL distribution's configured user is root. The proof made no system
  changes, but a non-root Linux CI run is still required before claiming a
  least-privilege installation path.
