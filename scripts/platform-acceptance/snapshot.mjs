import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isoNow, sha256File } from "./lib.mjs";

const execFileAsync = promisify(execFile);

async function git(worktree, args, encoding = "utf8") {
  const result = await execFileAsync("git", ["-C", worktree, ...args], {
    encoding,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  return result.stdout;
}

function splitZero(value) {
  return value.split("\0").filter(Boolean);
}

function excluded(relativePath) {
  const parts = relativePath.split(/[\\/]/);
  return parts.includes(".git") || parts.includes("node_modules");
}

async function describeFile(root, relativePath) {
  const absolute = path.join(root, relativePath);
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink()) {
    const target = await readlink(absolute);
    return { path: relativePath, type: "link", target, size: metadata.size };
  }
  if (!metadata.isFile()) return { path: relativePath, type: "other", size: metadata.size };
  return {
    path: relativePath,
    type: "file",
    size: metadata.size,
    mode: metadata.mode,
    sha256: await sha256File(absolute),
  };
}

export async function captureGitState(worktree, label, artifactRoot, phase) {
  const stateRoot = path.join(artifactRoot, "source-state", `${label}-${phase}`);
  await mkdir(stateRoot, { recursive: true });
  const [head, branch, status, diffStat, binaryDiff, trackedRaw, untrackedRaw] = await Promise.all([
    git(worktree, ["rev-parse", "HEAD"]),
    git(worktree, ["branch", "--show-current"]),
    git(worktree, ["status", "--short", "--untracked-files=all"]),
    git(worktree, ["diff", "HEAD", "--stat", "--no-ext-diff"]),
    git(worktree, ["diff", "HEAD", "--binary", "--no-ext-diff"]),
    git(worktree, ["ls-files", "-z", "--cached"]),
    git(worktree, ["ls-files", "-z", "--others", "--exclude-standard"]),
  ]);
  const tracked = splitZero(trackedRaw).filter((item) => !excluded(item));
  const untracked = splitZero(untrackedRaw).filter((item) => !excluded(item));
  const current = [...new Set([...tracked, ...untracked])].sort();
  const files = [];
  const missingTracked = [];
  for (const relativePath of current) {
    try {
      files.push(await describeFile(worktree, relativePath));
    } catch (error) {
      if (error.code === "ENOENT" && tracked.includes(relativePath)) {
        missingTracked.push(relativePath);
        continue;
      }
      throw error;
    }
  }
  const artifacts = {
    status: path.relative(artifactRoot, path.join(stateRoot, "status.txt")),
    diffStat: path.relative(artifactRoot, path.join(stateRoot, "diff-stat.txt")),
    binaryDiff: path.relative(artifactRoot, path.join(stateRoot, "diff-binary.patch")),
    untracked: path.relative(artifactRoot, path.join(stateRoot, "untracked.json")),
  };
  await Promise.all([
    writeFile(path.join(stateRoot, "status.txt"), status, "utf8"),
    writeFile(path.join(stateRoot, "diff-stat.txt"), diffStat, "utf8"),
    writeFile(path.join(stateRoot, "diff-binary.patch"), binaryDiff, "utf8"),
    writeFile(path.join(stateRoot, "untracked.json"), `${JSON.stringify(
      files.filter((item) => untracked.includes(item.path)),
      null,
      2,
    )}\n`, "utf8"),
  ]);
  return {
    label,
    phase,
    capturedAt: isoNow(),
    worktree,
    head: head.trim(),
    branch: branch.trim(),
    status,
    diffStat,
    artifacts,
    trackedCount: tracked.length,
    untrackedCount: untracked.length,
    missingTracked,
    files,
    manifestSha256: createHash("sha256")
      .update(JSON.stringify(files.map(({ path: filePath, type, size, sha256, target }) => ({
        path: filePath,
        type,
        size,
        sha256,
        target,
      }))))
      .digest("hex"),
  };
}

export async function materializeSnapshot(sourceRoot, snapshotRoot, sourceState) {
  await rm(snapshotRoot, { recursive: true, force: true });
  await mkdir(snapshotRoot, { recursive: true });
  for (const file of sourceState.files) {
    const source = path.join(sourceRoot, file.path);
    const destination = path.join(snapshotRoot, file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    if (file.type === "link") {
      await symlink(file.target, destination);
      continue;
    }
    if (file.type !== "file") continue;
    await copyFile(source, destination);
    if (process.platform !== "win32") await chmod(destination, file.mode & 0o777);
  }
  const verified = [];
  for (const expected of sourceState.files) {
    const destination = path.join(snapshotRoot, expected.path);
    const actual = await describeFile(snapshotRoot, expected.path);
    const matches = expected.type === actual.type
      && expected.size === actual.size
      && expected.sha256 === actual.sha256
      && expected.target === actual.target;
    verified.push({ path: expected.path, matches, expected, actual });
    if (!matches) throw new Error(`Snapshot verification failed for ${expected.path}`);
  }
  return {
    sourceRoot,
    snapshotRoot,
    createdAt: isoNow(),
    fileCount: verified.length,
    missingTracked: sourceState.missingTracked,
    verified: verified.every((item) => item.matches),
    files: verified.map((item) => item.actual),
    manifestSha256: createHash("sha256")
      .update(JSON.stringify(verified.map((item) => item.actual)))
      .digest("hex"),
  };
}

export async function hashTextFile(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}
