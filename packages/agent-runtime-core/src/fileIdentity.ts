/**
 * The stat fields used to attest that a pathname still identifies an opened
 * regular file. The shape is deliberately structural so both `Stats` and
 * `BigIntStats`-free test fixtures can use the portable predicate.
 */
export interface StableFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
  readonly size: number;
  readonly mode: number;
}

/** Metadata required to prove that one opened file did not drift while read. */
export interface StableFileSnapshot extends StableFileIdentity {
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

/**
 * Compare pathname and descriptor stats without weakening no-follow checks.
 *
 * Node 22 on Windows can report `dev === 0` for exactly one side of an
 * `lstat`/`FileHandle.stat` comparison. In that case only, require the inode
 * plus every stable snapshot field proven consistent across those APIs.
 * Mutable timestamps remain the caller's responsibility when it performs a
 * before/after content snapshot check.
 */
export function sameStableFileIdentity(
  left: StableFileIdentity,
  right: StableFileIdentity,
  platform = process.platform,
): boolean {
  if (
    !Number.isInteger(left.ino) || left.ino <= 0 ||
    !Number.isInteger(right.ino) || right.ino <= 0
  ) return false;
  if (left.dev === right.dev && left.ino === right.ino) return true;
  return platform === 'win32'
    && (left.dev === 0) !== (right.dev === 0)
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs
    && left.size === right.size
    && left.mode === right.mode;
}

/** Compare identity plus the mutable fields captured around one descriptor read. */
export function sameStableFileSnapshot(
  left: StableFileSnapshot,
  right: StableFileSnapshot,
  platform = process.platform,
): boolean {
  return sameStableFileIdentity(left, right, platform)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}
