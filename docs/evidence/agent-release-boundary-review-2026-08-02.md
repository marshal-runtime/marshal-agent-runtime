# Automated agent release-boundary review

Date: 2026-08-02

Reviewer: Codex subagent operating in the local development workspace

Status: **two release blockers remain; two findings remediated during review**

This is an independent agent pass over the candidate, not a human review,
third-party certification, penetration test, accessibility review, or legal
opinion. It must not be used to check off the independent-review publication
gate by itself.

## Scope and checks

The pass inspected the MIT runtime, PolyForm GitNexus-memory repository, and
PolyForm Codex/GitNexus composition leaf. It reviewed ownership/scoping,
external private paths, graph-candidate reauthorization, persisted UI-record
authenticity, declared UI action/tool authority, installed-plugin launch pins,
package dry runs, local secret/path leakage, evidence wording, and repository
revision state.

Observed package checks:

- the MIT workspace `pack:check` validated 20 dry-run tarballs;
- dry-run tarballs for `@marshal/gitnexus-memory`, `@marshal/gitnexus`, and
  `@marshal/codex-gitnexus` contained their declared release files and no
  databases, environment files, tests, node_modules trees, or canary data;
- the installed plugin pins absolute server, hook, and kernel-module paths;
- the installed Codex CLI, plugin projection, and composition-leaf executable
  hashes matched the currently built source outputs at review time;
- source and built-output scans found no credential value in the release
  packages. Credential-looking test hits were fixture environment/header names,
  not committed credentials.

## Findings

### High — no immutable three-repository release candidate

The candidate cannot yet be reproduced from Git revisions. The MIT repository
has 279 changed/untracked paths relative to
`3fd4f43083c148cec06b0b285c13123ed2042b04`; the GitNexus-memory and
Codex/GitNexus leaf repositories each have zero tracked files and no commit;
none of the three repositories has a configured remote in the reviewed clone.
The benchmark code-tree digest usefully attests local bytes, but it is not a
checkoutable source revision.

Affected boundaries:

- `%MARSHAL_RUNTIME_REPO%\.git\HEAD`
- `%MARSHAL_GRAPH_REPO%\.git\HEAD`
- `%MARSHAL_CODEX_GRAPH_REPO%\.git\HEAD`
- [`capacity-final-2026-08-02.md`](capacity-final-2026-08-02.md)

The repository variables above are publication placeholders for the three
historical local checkout roots; no source-revision claim is changed.

Required action: form reviewed commits in all three repositories, configure the
intended remotes, record exact commit IDs and dependency/tag mapping, then rerun
the release and packed-install gates from clean checkouts.

### Remediated during review — public evidence contained operator paths and task identifiers

Historical evidence documents contained the local account name, absolute
profile and deployment paths, temporary paths, and multiple Codex
rollout/session IDs. This was not a package-tarball leak, but it was a privacy
and publication-hygiene blocker.

Affected and remediated files included:

- [`automatic-memory-2026-08-01.md`](automatic-memory-2026-08-01.md)
- [`fresh-session-routing-2026-08-01.md`](fresh-session-routing-2026-08-01.md)
- [`design-studio-prototype-2026-08-01.md`](design-studio-prototype-2026-08-01.md)
- [`design-studio-capstone-attempt-6-2026-08-01.md`](design-studio-capstone-attempt-6-2026-08-01.md)
- [`fresh-installed-routing-attempt-2026-08-02.md`](fresh-installed-routing-attempt-2026-08-02.md)
- [`native-delegation-final-candidate-2026-08-02.md`](native-delegation-final-candidate-2026-08-02.md)
- [`README.md`](README.md)

The same pattern occurred in several earlier candidate/delegation evidence
records. It was remediated by replacing account/profile/temp prefixes with
`%USERPROFILE%` and `%TEMP%`, replacing Codex task and rollout IDs with stable
evidence-local aliases, and retaining hashes, timings, attempt labels, and
generic commands. A post-change scan found no local user root, rollout ID, or
raw Codex task UUID in publishable evidence Markdown. Secured raw traces remain
outside the public tree when exact local identifiers are needed for audit.

### Medium — installed candidate metadata cannot reconstruct its dependency set

The active deployment runs from an absolute pinned directory and executable
hashes match the current built outputs. However, all 21 local package
dependencies in its `package.json` and lockfile point to a deleted temporary
pack directory; zero of those tarballs remains. The deployment is runnable in
place but its own manifest/lock cannot recreate it.

Affected local candidate files:

- `%USERPROFILE%\.marshal\codex-runtime-0.1.0-20260802a\package.json`
- `%USERPROFILE%\.marshal\codex-runtime-0.1.0-20260802a\pnpm-lock.yaml`
- `%USERPROFILE%\.codex\plugins\cache\personal\marshal-runtime\0.1.0+codex.20260802092659\.mcp.json`

Required action: retain a content-addressed release bundle or registry-backed
lock whose package locators and integrities remain resolvable, and have the
plugin record that bundle/revision identity in addition to absolute runtime
launch paths.

### Remediated during review — readiness prose described superseded plugin state as current

The readiness audit and evidence index said candidate `r`/`q` plugin bytes were
the installed active candidate. The reviewed active cache is instead
`0.1.0+codex.20260802092659` launching deployment `20260802a`. The older rows
remain valid as historical observations.

Affected files:

- [`publication-readiness-audit.md`](../publication-readiness-audit.md)
- [`README.md`](README.md)

The candidate rows and their own evidence pages are now explicitly historical,
and the evidence index/readiness audit name deployment `20260802a` and cache
version `0.1.0+codex.20260802092659` as the active local review state. The
remaining immutable-revision finding prevents this from being represented as a
published or checkoutable release.

## Authority observations without a blocking finding

- Memory ownership is derived from principal plus the appropriate opaque
  workspace/project/session/agent identity. Projection roots and graph
  databases are required outside the workspace and reject symlink/junction
  traversal.
- The GitNexus tool plane exposes candidates without memory content; the Brain
  resolves every candidate ID through scoped SQLite before returning bytes.
- Persisted executable React component/render records support harness-held HMAC
  authenticity. The Codex adapter supplies an external file-backed authority
  and rejects unsigned legacy executable records by default.
- UI actions and tools resolve by server-loaded immutable render manifests,
  validate schemas, and execute through the runtime operation boundary. UI
  action approval objects are still verified by the permission broker; the
  browser cannot self-approve by supplying arbitrary JSON.
- UI action results and leases are principal/scope partitioned; successful
  idempotent completions are replayable and changed-request key reuse is
  rejected.

These observations reduce specific risks but do not certify the implementation
or remove the publication checklist's human security, privacy, accessibility,
and reproducibility review requirements.

## Benchmark evidence maintenance performed during this pass

The post-full-gate exact raw rerun is indexed without replacing either prior
record:

- `capacity-final-post-gate-2026-08-02.json`
- SHA-256
  `D2FCB77AE3AFA12ADFB09F884741AE605BD56FEDA638EED297B44BEA4479D9F9`
- result: 10 passed, 0 failed, 0 blocked

The earlier passing raw report and failed ownership-fixture attempt remain
preserved with their original hashes and labels.

The final capture-preparation bundle was also observed outside the repository
at `%CAPTURE_ROOT%`: seven frozen demo inputs and capture
plan SHA-256
`E636CC8C9A1939C11FF6909DD10B7B264858DABC921DA5B8459E950C13D6A19F`.
`%CAPTURE_ROOT%` is the publication placeholder for that historical
machine-local capture directory.
Its metadata explicitly states that it contains no live evidence or media, so
this review treats it only as capture preparation, not demo proof.

## Post-review candidate remediation

The historical `20260802a` findings above remain unchanged. They were remediated
by local deployment `20260802b`, built from committed runtime `f76ab88`,
GitNexus memory `2ec3e72`, and Codex composition `6d38aba`.

- Candidate verification reported 21 retained `file:` dependency references
  and 21 matching archives.
- `pnpm install --offline --frozen-lockfile` completed with 612 reused packages
  and zero downloads.
- A detached MCP smoke launched the composed GitNexus kernel from an unrelated
  workspace and discovered all required runtime, UI, action, and lifecycle
  tools.
- Personal plugin `0.1.0+codex.20260802113622` pins only the `20260802b`
  candidate; no development-repository or earlier-candidate path remains.

Retained local hashes:

| File | SHA-256 |
| --- | --- |
| Candidate `package.json` | `EC29EE4E6CC3A264A97258014A34AD6EEC24C8A54A8C81BBB9297641E19E8757` |
| Candidate `pnpm-lock.yaml` | `AEA3A733CC85C6968828BEC7383CB5416FD9205AC3241E60BBE0AA32EF27B59D` |
| Installed plugin `.mcp.json` | `4CCDB5A4A3C438BE5F81B33B40A0C1E444FB0AFF2929A11A6C3CA5811E6A1EB1` |
| Installed plugin `plugin.json` | `53770D0E66A6BE5477AC61D463102950411841BF3E6DE4F039EB8C7331933145` |

The Codex host has not yet restarted into these plugin bytes. The later
[Ubuntu 24 committed-source proof](linux-ubuntu24-final-candidate-2026-08-02.md)
closed the local x64 Linux rerun with exact archives, frozen builds, a
network-disabled offline reinstall, and a real composed-kernel smoke. The
remaining cross-host gate is the declared published-artifact OS/Node matrix;
post-restart Codex behavior is still unproven.
