import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { finished } from "node:stream/promises";

export const PRIMARY_STORIES = new Set([
  "MRT-KRN-001",
  "MRT-KRN-002",
  "MRT-KRN-003",
  "MRT-PUI-001",
  "MRT-PUI-002",
  "MRT-PUI-003",
  "MRT-PUI-004",
  "MRT-PUI-005",
  "MRT-LEG-002",
]);

export function isoNow() {
  return new Date().toISOString();
}

export function sanitizeName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-|-$/g, "");
}

export function isSameOrInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertDisjointPath(candidate, authoritativeRoots, label) {
  if (!path.isAbsolute(candidate)) throw new Error(`${label} must be absolute.`);
  for (const root of authoritativeRoots) {
    if (isSameOrInside(root, candidate) || isSameOrInside(candidate, root)) {
      throw new Error(`${label} must be outside authoritative worktree ${root}.`);
    }
  }
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.write-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

export async function appendJsonl(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

export async function recordBug(run, bug) {
  const duplicateCount = run.bugs.filter((item) =>
    item.id === bug.id || item.originalId === bug.id).length;
  const entry = {
    recordedAt: isoNow(),
    runId: path.basename(run.runRoot),
    sessionId: run.sessionId,
    continuation: "continue-independent-suites",
    ...bug,
    ...(duplicateCount > 0
      ? { id: `${bug.id}-${duplicateCount + 1}`, originalId: bug.id }
      : {}),
  };
  run.bugs.push(entry);
  if (run.bugLedgerJsonlPath) await appendJsonl(run.bugLedgerJsonlPath, entry);
  return entry;
}

export async function sha256File(file) {
  const bytes = await readFile(file);
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function errorRecord(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(typeof error.code === "string" ? { code: error.code } : {}),
      ...(error.cause === undefined ? {} : { cause: errorRecord(error.cause) }),
      stack: error.stack,
    };
  }
  return { name: "NonError", message: String(error) };
}

export async function inventoryTree(root, options = {}) {
  const entries = [];
  const hashLimit = options.hashLimit ?? Number.POSITIVE_INFINITY;
  const excluded = (options.exclude ?? []).map((item) => item.replaceAll("\\", "/").replace(/\/+$/, ""));
  const isExcluded = (relative) => {
    const normalized = relative.replaceAll("\\", "/");
    return excluded.some((item) => normalized === item || normalized.startsWith(`${item}/`));
  };
  async function visit(directory, relativeDirectory) {
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = relativeDirectory
        ? path.join(relativeDirectory, child.name)
        : child.name;
      if (isExcluded(relative)) continue;
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        entries.push({
          path: relative,
          type: "link",
          size: metadata.size,
          target: await realpath(absolute).catch(() => null),
        });
      } else if (metadata.isDirectory()) {
        entries.push({ path: relative, type: "directory", modifiedAt: metadata.mtime.toISOString() });
        await visit(absolute, relative);
      } else if (metadata.isFile()) {
        entries.push({
          path: relative,
          type: "file",
          size: metadata.size,
          modifiedAt: metadata.mtime.toISOString(),
          ...(metadata.size <= hashLimit ? { sha256: await sha256File(absolute) } : {}),
        });
      } else {
        entries.push({ path: relative, type: "other", size: metadata.size });
      }
    }
  }
  await visit(root, "");
  return { root, capturedAt: isoNow(), entries };
}

export async function processTree() {
  if (process.platform === "win32") {
    const script = [
      "Get-CimInstance Win32_Process",
      "Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine",
      "Sort-Object ProcessId",
      "ConvertTo-Json -Depth 3 -Compress",
    ].join(" | ");
    const result = await captureProcess("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
    if (result.exitCode !== 0) return { capturedAt: isoNow(), error: result.stderr };
    try {
      const parsed = JSON.parse(result.stdout || "[]");
      return { capturedAt: isoNow(), processes: Array.isArray(parsed) ? parsed : [parsed] };
    } catch (error) {
      return { capturedAt: isoNow(), error: errorRecord(error), raw: result.stdout };
    }
  }
  const result = await captureProcess("ps", ["-eo", "pid=,ppid=,comm=,args="]);
  return { capturedAt: isoNow(), exitCode: result.exitCode, raw: result.stdout, error: result.stderr };
}

export async function captureProcess(program, args, options = {}) {
  return await new Promise((resolve) => {
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      shell: options.shell ?? false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({
      exitCode: null,
      stdout,
      stderr,
      error: errorRecord(error),
    }));
    child.on("exit", (code, signal) => resolve({ exitCode: code, signal, stdout, stderr }));
  });
}

export async function runCommand(run, specification) {
  const index = run.commands.length + 1;
  const id = specification.id ?? `command-${index}`;
  const artifactBase = `${String(index).padStart(2, "0")}-${sanitizeName(id)}`;
  const stdoutArtifact = path.join("command-transcripts", `${artifactBase}.stdout.log`);
  const stderrArtifact = path.join("command-transcripts", `${artifactBase}.stderr.log`);
  const startedAt = isoNow();
  const start = performance.now();
  const record = {
    id,
    category: specification.category ?? "supporting",
    program: specification.program,
    argv: [...specification.args],
    cwd: specification.cwd,
    startedAt,
    stdoutArtifact,
    stderrArtifact,
  };
  const executable = process.platform === "win32" && specification.program === "pnpm"
    ? "pnpm.cmd"
    : specification.program;
  const child = spawn(executable, specification.args, {
    cwd: specification.cwd,
    env: { ...(run.commandEnvironment ?? process.env), ...specification.env },
    windowsHide: true,
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable),
    stdio: ["ignore", "pipe", "pipe"],
  });
  record.pid = child.pid ?? null;
  await appendJsonl(run.processTranscriptPath, {
    type: "command.spawn",
    at: startedAt,
    id,
    pid: child.pid ?? null,
    program: specification.program,
    argv: specification.args,
    cwd: specification.cwd,
  });
  const stdoutStream = createWriteStream(path.join(run.runRoot, stdoutArtifact), { encoding: "utf8" });
  const stderrStream = createWriteStream(path.join(run.runRoot, stderrArtifact), { encoding: "utf8" });
  child.stdout.pipe(stdoutStream);
  child.stderr.pipe(stderrStream);
  const outcome = await new Promise((resolve) => {
    child.on("error", (error) => resolve({ exitCode: null, signal: null, spawnError: errorRecord(error) }));
    child.on("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  await Promise.all([finished(stdoutStream), finished(stderrStream)]);
  record.endedAt = isoNow();
  record.durationMs = Math.round((performance.now() - start) * 1000) / 1000;
  Object.assign(record, outcome);
  run.commands.push(record);
  await appendJsonl(run.commandTranscriptPath, record);
  await appendJsonl(run.processTranscriptPath, {
    type: "command.exit",
    at: record.endedAt,
    id,
    pid: record.pid,
    exitCode: record.exitCode,
    signal: record.signal,
  });
  if (record.exitCode !== 0) {
    await recordBug(run, {
      id: `BUG-COMMAND-${String(index).padStart(3, "0")}`,
      kind: "command-failure",
      classification: specification.failureClassification ?? "production",
      status: "OPEN",
      commandId: id,
      summary: `${specification.program} ${specification.args.join(" ")} exited ${record.exitCode}`,
      artifacts: [stdoutArtifact, stderrArtifact],
    });
  }
  return record;
}

export class Story {
  constructor(run, id, evidenceClass, options = {}) {
    this.run = run;
    this.id = id;
    this.record = {
      id,
      startedAt: isoNow(),
      evidenceClass,
      mainPid: process.pid,
      childPids: [],
      packageBuildIdentity: run.packageBuildIdentity,
      evidenceRoot: run.runRoot,
      userDataDirectory: null,
      marshalAppDataRoot: null,
      filesystemRoots: [],
      exactActions: [],
      rawResults: {},
      assertions: [],
      artifacts: [],
      continuationClassification: options.continuation ?? "blocking",
      requiredLiveEvidence: options.requiredLiveEvidence ?? null,
    };
    this.environmentBlocked = false;
    this.harnessFailure = false;
  }

  action(description, details) {
    this.record.exactActions.push({ at: isoNow(), description, ...(details ? { details } : {}) });
  }

  result(name, value) {
    this.record.rawResults[name] = value;
  }

  root(value) {
    this.record.filesystemRoots.push(value);
  }

  child(pid) {
    if (Number.isInteger(pid) && !this.record.childPids.includes(pid)) this.record.childPids.push(pid);
  }

  artifact(value) {
    if (!this.record.artifacts.includes(value)) this.record.artifacts.push(value);
  }

  assert(name, condition, expected, actual, details) {
    const assertion = {
      name,
      passed: Boolean(condition),
      expected,
      actual,
      ...(details ? { details } : {}),
    };
    this.record.assertions.push(assertion);
    return assertion.passed;
  }

  block(name, details) {
    this.environmentBlocked = true;
    this.record.assertions.push({
      name,
      passed: false,
      blocked: true,
      expected: "environment capability available",
      actual: details,
    });
  }

  async finish() {
    this.record.endedAt = isoNow();
    if (this.record.filesystemRoots.length === 0) this.root(this.run.platformSnapshot);
    for (const artifact of [
      "environment.json",
      "process-transcript.jsonl",
      "command-transcript.jsonl",
      "filesystem-before.json",
      "filesystem-after.json",
      "hashes.json",
    ]) this.artifact(artifact);
    const buildHashes = Object.values(this.record.packageBuildIdentity?.hashes ?? {});
    this.record.evidence = {
      process: {
        mainPid: this.record.mainPid,
        childPids: this.record.childPids,
      },
      filesystem: {
        roots: this.record.filesystemRoots,
        beforeArtifact: "filesystem-before.json",
        afterArtifact: "filesystem-after.json",
      },
      transcripts: {
        processArtifact: "process-transcript.jsonl",
        commandArtifact: "command-transcript.jsonl",
      },
      hashes: {
        packageBuildIdentity: this.record.packageBuildIdentity,
        finalArtifact: "hashes.json",
      },
    };
    const evidenceComplete = Number.isInteger(this.record.mainPid)
      && this.record.filesystemRoots.length > 0
      && buildHashes.some((item) => typeof item.sha256 === "string")
      && this.record.artifacts.includes("process-transcript.jsonl")
      && this.record.artifacts.includes("command-transcript.jsonl")
      && this.record.artifacts.includes("hashes.json");
    const functionalFailure = this.record.assertions.some((item) => !item.passed && !item.blocked);
    if (!functionalFailure && !this.environmentBlocked && !evidenceComplete) {
      this.harnessFailure = true;
      this.assert(
        "PASS evidence includes PID, filesystem, transcript, and hash artifacts",
        false,
        "complete evidence bundle",
        this.record.evidence,
      );
    }
    const failed = this.record.assertions.some((item) => !item.passed && !item.blocked);
    const runtimeSideStatus = failed ? "FAIL" : this.environmentBlocked ? "BLOCKED" : "PASS";
    this.record.runtimeSideStatus = runtimeSideStatus;
    this.record.contractStatus = PRIMARY_STORIES.has(this.id)
      ? runtimeSideStatus
      : runtimeSideStatus === "FAIL" ? "FAIL" : "NOT RUN";
    if (!PRIMARY_STORIES.has(this.id)) {
      this.record.contractStatusReason = runtimeSideStatus === "FAIL"
        ? "Runtime-side supporting evidence failed."
        : "Required LIVE-ELECTRON evidence is absent.";
    }
    const relative = path.join("stories", `${this.id}.json`);
    this.artifact(relative);
    await writeJson(path.join(this.run.runRoot, relative), this.record);
    this.run.stories.push(this.record);
    if (runtimeSideStatus !== "PASS") {
      await recordBug(this.run, {
        id: `BUG-${this.id}`,
        kind: runtimeSideStatus === "BLOCKED" ? "environment-blocked" : "story-failure",
        classification: runtimeSideStatus === "BLOCKED"
          ? "environment"
          : this.harnessFailure ? "harness" : "production",
        status: "OPEN",
        storyId: this.id,
        summary: `${this.id} runtime-side status ${runtimeSideStatus}`,
        assertions: this.record.assertions.filter((item) => !item.passed),
        artifacts: this.record.artifacts,
      });
    }
    return this.record;
  }
}

export async function runStory(run, id, evidenceClass, options, callback) {
  const story = new Story(run, id, evidenceClass, options);
  try {
    await callback(story);
  } catch (error) {
    story.harnessFailure = true;
    story.result("unhandledError", errorRecord(error));
    story.assert("campaign completed without an unhandled harness error", false, "no error", errorRecord(error));
  }
  return await story.finish();
}

export async function blockStories(run, definitions, reason) {
  for (const [id, evidenceClass, options] of definitions) {
    await runStory(run, id, evidenceClass, options, async (story) => {
      story.action("Record the story as blocked without starting its process campaign.", reason);
      story.result("blockedReason", reason);
      story.block("required package build/deployment is available", reason);
    });
  }
}

export async function pathExists(value) {
  try {
    await stat(value);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function removeIfExists(value) {
  await rm(value, { recursive: true, force: true });
}
