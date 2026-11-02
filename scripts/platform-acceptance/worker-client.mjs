import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendJsonl, errorRecord, isoNow } from "./lib.mjs";

export async function launchWorker(run, workerPath, consumerRoot, label) {
  const child = fork(workerPath, ["--consumer-root", consumerRoot], {
    cwd: consumerRoot,
    windowsHide: true,
    serialization: "json",
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  run.workerChildren ??= new Set();
  run.workerChildren.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await appendJsonl(run.processTranscriptPath, {
    type: "worker.spawn",
    at: isoNow(),
    label,
    pid: child.pid,
    argv: [workerPath, "--consumer-root", consumerRoot],
    cwd: consumerRoot,
  });
  const pending = new Map();
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  child.on("message", (message) => {
    if (message?.type === "ready") {
      readyResolve(message);
      return;
    }
    const waiter = pending.get(message?.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.ok) waiter.resolve(message.value);
    else waiter.reject(Object.assign(new Error(message.error?.message ?? "Worker operation failed"), message.error));
  });
  child.on("error", (error) => {
    readyReject(error);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  child.on("exit", (code, signal) => {
    run.workerChildren.delete(child);
    const error = new Error(`Worker ${label} exited ${code ?? signal ?? "unknown"}: ${stderr || stdout}`);
    readyReject(error);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    void appendJsonl(run.processTranscriptPath, {
      type: "worker.exit",
      at: isoNow(),
      label,
      pid: child.pid,
      exitCode: code,
      signal,
      stdout,
      stderr,
    });
  });
  await ready;
  return {
    child,
    label,
    pid: child.pid,
    request(operation, args) {
      if (!child.connected) return Promise.reject(new Error(`Worker ${label} is not connected.`));
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.send({ id, operation, args }, (error) => {
          if (!error) return;
          pending.delete(id);
          reject(error);
        });
      });
    },
    async terminate() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.pid) {
            try {
              process.kill(child.pid, "SIGKILL");
            } catch (error) {
              if (error.code !== "ESRCH") {
                void appendJsonl(run.processTranscriptPath, {
                  type: "worker.kill-error",
                  at: isoNow(),
                  label,
                  pid: child.pid,
                  error: errorRecord(error),
                });
              }
            }
          }
          resolve();
        }, 2_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

export async function terminateTrackedWorkers(run) {
  const children = [...(run.workerChildren ?? [])];
  await Promise.all(children.map(async (child) => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.pid) {
          try {
            process.kill(child.pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") {
              void appendJsonl(run.processTranscriptPath, {
                type: "worker.final-kill-error",
                at: isoNow(),
                pid: child.pid,
                error: errorRecord(error),
              });
            }
          }
        }
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }));
}
