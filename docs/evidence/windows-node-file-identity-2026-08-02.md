# Windows Node 22/24 file-identity diagnostic

**Observed:** 2026-08-02
**Class:** deterministic
**Environment:** Windows x64
**Runtimes:** Node.js `v22.13.0` and Node.js `v24.14.0`

## Question

Marshal compares pathname metadata from `lstat` with metadata from an opened
file descriptor before trusting bounded file reads. This diagnostic measured
whether those APIs report the same identity on the declared Node.js floor and
on the current development runtime. It also sampled legitimate concurrent
mutation and an explicit pathname replacement negative.

The diagnostic ran outside the repository in an operating-system temporary
directory. This document deliberately omits machine-specific executable and
temporary paths.

## Method and sample sizes

The same JavaScript diagnostic was run once under each runtime. Each comparison
recorded `dev`, `ino`, `size`, `mode`, `nlink`, `uid`, `gid`, `birthtimeMs`,
`ctimeMs`, and `mtimeMs` from `lstat(path)` and `fileHandle.stat()`.

| Scenario | Samples per runtime | Operation |
| --- | ---: | --- |
| Fresh, sequential | 1,000 | Create a unique regular file, open it read-only, then compare pathname and descriptor metadata |
| Fresh, loaded | 2,000 | Repeat the fresh-file comparison with 32 workers |
| Concurrent mutation | 1,000 | Compare during a write to an already-open file, then compare again after the write settles |
| Replacement negative | 250 | Keep the original descriptor open, unlink its pathname, rename a different file into that pathname, then compare |
| Symbolic-link negative | 1 attempted | Create a file symbolic link and compare its `lstat` result with an opened target descriptor |

The temporary directory created by each run was removed after its observations
were emitted.

## Stable-file observations

Across the 3,000 fresh regular files, Node.js `v22.13.0` differed in exactly one
field:

| Field | Mismatches | Path value | Descriptor value | Descriptor minus path |
| --- | ---: | ---: | ---: | ---: |
| `dev` | 3,000 / 3,000 | `0` | `3700311042` | `+3700311042` |

Every sampled `ino`, `size`, `mode`, `nlink`, `uid`, `gid`, `birthtimeMs`,
`ctimeMs`, and `mtimeMs` value matched. This remained true in all 2,000 loaded
samples at concurrency 32.

Node.js `v24.14.0` reported no pathname-versus-descriptor difference in any of
the ten fields across the same 3,000 fresh-file samples.

## Concurrent-mutation observations

Metadata was intentionally sampled while a write could be between its truncate
and publish phases. The delta below is descriptor minus pathname.

| Runtime | Field | Mismatches during write | Observed delta |
| --- | --- | ---: | ---: |
| Node `v22.13.0` | `dev` | 1,000 / 1,000 | exactly `+3700311042` |
| Node `v22.13.0` | `size` | 58 / 1,000 | exactly `-16` bytes |
| Node `v22.13.0` | `ctimeMs` | 48 / 1,000 | `+0.562744140625` to `+14.387451171875` ms |
| Node `v22.13.0` | `mtimeMs` | 48 / 1,000 | `+0.562744140625` to `+14.387451171875` ms |
| Node `v24.14.0` | `size` | 54 / 1,000 | exactly `-16` bytes |
| Node `v24.14.0` | `ctimeMs` | 36 / 1,000 | `+1.00048828125` to `+15.525146484375` ms |
| Node `v24.14.0` | `mtimeMs` | 36 / 1,000 | `+1.00048828125` to `+15.525146484375` ms |

After each mutation settled, Node 22 again differed only in `dev`; Node 24 had
no remaining field differences. The timestamp deltas therefore describe
legitimate snapshot timing under mutation, not a stable file-identity
difference.

## Replacement and symbolic-link negatives

The replacement pathname and the still-open original descriptor had different
inodes in all 250 attempts on both runtimes. There were zero same-inode
replacements. The replacement contents were three bytes longer, so descriptor
minus path size was `-3` in all 250 attempts. The unlinked original descriptor
reported `nlink=0` while the replacement pathname reported `nlink=1`.

Replacement timestamps reflected two different files and varied accordingly:

| Runtime | Field | Mismatches | Descriptor-minus-path range |
| --- | --- | ---: | ---: |
| Node `v22.13.0` | `ctimeMs` | 131 / 250 | `-55.078369140625` to `-0.50634765625` ms |
| Node `v22.13.0` | `mtimeMs` | 69 / 250 | `-43.065673828125` to `-0.50537109375` ms |
| Node `v24.14.0` | `ctimeMs` | 207 / 250 | `-14.6552734375` to `-0.627197265625` ms |
| Node `v24.14.0` | `mtimeMs` | 125 / 250 | `-9.071044921875` to `-0.50634765625` ms |

The current Windows token could not create a file symbolic link: both runtimes
returned `EPERM`. This diagnostic therefore provides no positive symbolic-link
sample. Marshal must continue to reject `lstat().isSymbolicLink()` and retain
its no-follow controls independently of any metadata predicate.

The replacement operation used unlink followed by rename; it was not an atomic
replacement of an existing open pathname. It establishes the direct
replacement negative measured here, not every adversarial replacement race.

## Supported implementation inference

These observations support the following narrow comparison design:

1. Accept the normal case only when both `dev` and `ino` match.
2. On Windows only, when exactly one `dev` is zero, allow comparison to proceed
   only when `ino`, `birthtimeMs`, `size`, and `mode` all match exactly.
3. Do not use `ctimeMs` or `mtimeMs` as identity fields. They are snapshot state
   and demonstrably diverge during legitimate writes on both runtimes.
4. For immutable inputs, separately compare size and timestamps before and
   after the descriptor read. For intentionally mutable internal records,
   retry bounded snapshot drift and fail closed if it persists.
5. Keep symbolic-link, canonical-containment, and no-follow checks independent
   and mandatory.

`nlink` is not part of the recommended identity predicate because an otherwise
valid opened descriptor changes from one link to zero when its pathname is
removed.

## Claim boundary

This is deterministic evidence for one Windows x64 environment and the exact
Node.js versions named above. It explains the observed Node 22 zero-device
asymmetry and constrains a minimal comparison predicate. It does **not** prove:

- full Marshal support on Node 22;
- correctness of any source implementation not exercised by this standalone
  diagnostic;
- symbolic-link behavior under a token permitted to create links;
- behavior on other Windows volumes, network filesystems, Windows ARM64,
  Linux, or macOS;
- resistance to every time-of-check/time-of-use attack; or
- a security certification or publication-ready compatibility claim.

Full Node-floor and release claims still require the repository suites,
detached-package smokes, and publication gates to pass after the shared helper
is integrated.
