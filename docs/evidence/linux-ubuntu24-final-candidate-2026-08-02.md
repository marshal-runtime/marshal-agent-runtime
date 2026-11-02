# Ubuntu 24 committed-source final-candidate proof

Date: 2026-08-02  
Class: deterministic cross-host packaging proof

## Scope

This proof used fresh `git archive` exports of the three committed release
repositories, with no `.git`, index metadata, `node_modules`, or `dist`
directories inherited from a development tree:

| Repository | Commit |
| --- | --- |
| `agent-runtime` | `b3692265391e1dbb4cb8a0379fdf5c62cca835fd` |
| `gitnexus-memory` | `2ec3e727c2edd6a44d44540b989bad2e75130df3` |
| `marshal-codex-gitnexus` | `6d38aba342cedace866f933dae8972bc17bde9ca` |

The archives ran in `ubuntu:24.04` on x64 with Ubuntu `24.04.4 LTS`, glibc
`2.39`, Node `v24.14.0`, and pnpm `10.32.1`. The package store and metadata
cache were mounted only after the clean-source attestation.

## Observed result

- All 20 public runtime workspace packages built from the committed archive.
- The PolyForm GitNexus memory wrapper and its retained fork both installed
  from the frozen lockfile and built.
- The detachable Codex/GitNexus leaf passed typecheck, 8/8 tests, build, and
  its real packed-consumer kernel smoke.
- Candidate generation retained 21 `file:` references and 21 matching package
  archives; its real composed kernel constructed and disposed successfully.
- A second container with `--network none` ran
  `pnpm install --offline --frozen-lockfile`: 613/613 packages were reused,
  zero were downloaded, the 21-archive verifier passed again, and the composed
  kernel constructed and disposed from the offline installation.

Retained Linux candidate hashes:

| File | SHA-256 |
| --- | --- |
| `package.json` | `EC29EE4E6CC3A264A97258014A34AD6EEC24C8A54A8C81BBB9297641E19E8757` |
| `pnpm-lock.yaml` | `3D0137F222A7C8248CFA99D29C3092E4C500F168A91835D7648D37C38AB83DD3` |

The Linux lock hash differs from the retained Windows candidate lock because
pnpm records platform-specific optional dependency resolution; both candidates
retain the same Marshal archive closure and package manifest hash.

## Environment incident and evidence boundary

The first candidate reinstall in this proof root was interrupted when WSL disk
growth exhausted the Windows host volume. That partial candidate was rejected:
its root was removed, regenerated from the already-passed committed Linux
builds, verified, and then reinstalled in the separate network-disabled
container described above. No interrupted artifact is counted as a pass.

The 370-line local transcript is retained outside the publication tree at a
machine-local evidence path. Its SHA-256 is
`1D2920A59D09C0F4067938C3E41393D3081B50252FD75C28E252AE68DAE4EF56`.
This proof establishes Ubuntu 24 x64 packaging and offline closure for these
exact commits. It does not establish ARM64, Linux desktop pixels, registry
publication, or the full supported OS/Node matrix.
