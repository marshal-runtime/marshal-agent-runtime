import { fork } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { errorRecord, isoNow, runStory } from "./lib.mjs";

const DEFINITIONS = [
  ["MRT-TS-001", "NODE-INTEGRATION", { requiredLiveEvidence: "LIVE-ELECTRON" }],
  ["MRT-TS-002", "NODE-INTEGRATION", { requiredLiveEvidence: "LIVE-ELECTRON" }],
  ["MRT-TS-003", "NODE-INTEGRATION", { requiredLiveEvidence: "LIVE-ELECTRON" }],
  ["MRT-TS-004", "NODE-INTEGRATION", { requiredLiveEvidence: "LIVE-ELECTRON" }],
];

function observingFactory(story, observations) {
  return ({ modulePath, args, options }) => {
    const child = fork(modulePath, [...args], options);
    const observation = {
      at: isoNow(),
      pid: child.pid,
      modulePath,
      args: [...args],
      options: {
        cwd: options.cwd,
        requestedExecPath: options.execPath ?? null,
        actualExecutable: child.spawnfile,
        execArgv: options.execArgv,
        windowsHide: options.windowsHide,
        serialization: options.serialization,
        stdio: options.stdio,
        envKeys: Object.keys(options.env ?? {}).sort(),
      },
    };
    observations.push(observation);
    story.child(child.pid);
    return child;
  };
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function settleProcesses(pids) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && pids.some(processAlive)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return pids.filter(processAlive);
}

export async function runTypeScriptCampaign(run) {
  const modulePath = path.join(
    run.platformSnapshot,
    "packages",
    "agent-runtime-typescript",
    "dist",
    "index.js",
  );
  const runtime = await import(pathToFileURL(modulePath).href);
  const core = await import(pathToFileURL(path.join(
    run.platformSnapshot,
    "packages",
    "agent-runtime-core",
    "dist",
    "index.js",
  )).href);
  const { DirectTypeScriptExecutor } = runtime;
  const invocationContext = {
    principal: { id: "platform-acceptance", kind: "agent" },
    scope: { workspaceId: "workspace", projectId: "project", sessionId: "session" },
  };

  function kernelBroker(kernel) {
    return {
      async search(query) {
        return await kernel.runtimeSearch({
          protocolVersion: "1.0.0",
          query: typeof query?.query === "string" ? query.query : JSON.stringify(query),
          limit: 20,
        }, invocationContext);
      },
      async invoke(capability, input, brokerContext) {
        const response = await kernel.execute({
          protocolVersion: "1.0.0",
          targetType: "operation",
          target: capability,
          input,
        }, { ...invocationContext, signal: brokerContext.signal });
        if (response.status !== "success") {
          const error = new Error(response.error?.message ?? `Runtime invocation ended ${response.status}.`);
          error.code = response.error?.code ?? response.status;
          throw error;
        }
        return response.result?.output ?? null;
      },
    };
  }

  await runStory(run, "MRT-TS-001", "NODE-INTEGRATION", DEFINITIONS[0][2], async (story) => {
    const observations = [];
    const brokerCalls = [];
    const kernel = core.createRuntimeKernel({
      permissionBroker: core.createAllowAllPermissionBroker(),
    });
    kernel.register({
      id: "fixture.echo-provider",
      version: "1.0.0",
      list: async () => [{
        protocolVersion: "1.0.0",
        name: "fixture.echo",
        version: "1.0.0",
        description: "Acceptance echo capability.",
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
        outputSchema: {
          type: "object",
          properties: {
            capability: { type: "string" },
            value: { type: "object", properties: {}, additionalProperties: true },
          },
          required: ["capability", "value"],
          additionalProperties: false,
        },
      }],
      invoke: async (_name, value) => {
        brokerCalls.push(value);
        return { output: { capability: "fixture.echo", value } };
      },
    });
    const executor = new DirectTypeScriptExecutor(
      { workingDirectory: run.platformSnapshot },
      observingFactory(story, observations),
    );
    story.action("Execute a brokered TypeScript module through a real forked Node worker.");
    const input = { message: "platform-acceptance", value: 17 };
    const result = await executor.execute({
      input,
      source: `
        export default async (input, context) => {
          const invoked = await context.runtime.invoke("fixture.echo", input);
          return { input, invoked };
        };
      `,
    }, {
      broker: kernelBroker(kernel),
    });
    await executor.dispose();
    const orphans = await settleProcesses(observations.map((item) => item.pid));
    story.result("execution", result);
    story.result("brokerCalls", brokerCalls);
    story.result("childProcessObservations", observations);
    story.result("orphansAfterDispose", orphans);
    story.assert("brokered execution succeeds", result.ok === true && result.status === "succeeded", "succeeded", result.status);
    story.assert("input and broker output are preserved", result.value?.input?.value === 17
      && result.value?.invoked?.capability === "fixture.echo", input, result.value);
    story.assert("one nested invocation reaches the real kernel provider", brokerCalls.length === 1, 1, brokerCalls.length);
    story.assert("all observed children are real OS processes", observations.every((item) => Number.isInteger(item.pid)), true, observations);
    story.assert("executor disposal leaves no worker orphan", orphans.length === 0, [], orphans);
  });

  await runStory(run, "MRT-TS-002", "NODE-INTEGRATION", DEFINITIONS[1][2], async (story) => {
    const observations = [];
    let deniedProviderCalls = 0;
    const deniedKernel = core.createRuntimeKernel({
      permissionBroker: {
        decide: () => ({
          decision: "deny",
          code: "permission_denied",
          reason: "Acceptance denial.",
        }),
      },
    });
    deniedKernel.register({
      id: "fixture.denied-provider",
      version: "1.0.0",
      list: async () => [{
        protocolVersion: "1.0.0",
        name: "fixture.denied",
        version: "1.0.0",
        description: "Denied fixture capability.",
        permissions: [{ permission: "fixture.denied", reason: "Acceptance denial.", risk: "low" }],
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
        outputSchema: { type: "object", properties: {}, additionalProperties: true },
      }],
      invoke: async () => {
        deniedProviderCalls += 1;
        return { output: {} };
      },
    });
    const executor = new DirectTypeScriptExecutor(
      { workingDirectory: run.platformSnapshot },
      observingFactory(story, observations),
    );
    story.action("Attempt ambient Node and undeclared package authority in brokered mode.");
    const attempts = {};
    attempts.deniedNested = await executor.execute({
      source: `export default async (_input, context) =>
        context.runtime.invoke("fixture.denied", { value: 1 });`,
    }, { broker: kernelBroker(deniedKernel) });
    for (const [name, source] of Object.entries({
      filesystem: `import fs from "node:fs"; export default () => fs.existsSync(".");`,
      childProcess: `import child from "node:child_process"; export default () => child;`,
      package: `import value from "yaml"; export default () => value;`,
    })) {
      attempts[name] = await executor.execute({ source });
    }
    attempts.ambient = await executor.execute({
      source: `
        export default () => ({
          processType: typeof (globalThis as any).process,
          requireType: typeof (globalThis as any).require,
          constructorType: typeof (globalThis as any).constructor,
          prototypeIsNull: Object.getPrototypeOf(globalThis) === null
        });
      `,
    });
    await executor.dispose();
    const orphans = await settleProcesses(observations.map((item) => item.pid));
    story.result("attempts", attempts);
    story.result("deniedProviderCalls", deniedProviderCalls);
    story.result("childProcessObservations", observations);
    story.assert("Node filesystem import is denied", attempts.filesystem.error?.code === "IMPORT_DENIED", "IMPORT_DENIED", attempts.filesystem.error);
    story.assert("Node child_process import is denied", attempts.childProcess.error?.code === "IMPORT_DENIED", "IMPORT_DENIED", attempts.childProcess.error);
    story.assert("undeclared package import is denied", attempts.package.error?.code === "IMPORT_DENIED", "IMPORT_DENIED", attempts.package.error);
    story.assert("denied nested invocation never reaches its provider", attempts.deniedNested.ok === false
      && deniedProviderCalls === 0, "denied and zero provider calls", {
      execution: attempts.deniedNested,
      deniedProviderCalls,
    });
    story.assert("brokered realm has no ambient process or require", attempts.ambient.ok === true
      && attempts.ambient.value?.processType === "undefined"
      && attempts.ambient.value?.requireType === "undefined"
      && attempts.ambient.value?.constructorType === "undefined"
      && attempts.ambient.value?.prototypeIsNull === true, true, attempts.ambient.value);
    story.assert("ambient-denial workers leave no orphan", orphans.length === 0, [], orphans);
  });

  await runStory(run, "MRT-TS-003", "NODE-INTEGRATION", DEFINITIONS[2][2], async (story) => {
    const observations = [];
    const executor = new DirectTypeScriptExecutor(
      { workingDirectory: run.platformSnapshot },
      observingFactory(story, observations),
    );
    const configuredExecutor = new DirectTypeScriptExecutor(
      { workingDirectory: run.platformSnapshot, nodeExecutable: process.execPath },
      observingFactory(story, observations),
    );
    story.action("Exercise normal, timeout, output, request bounds, and default process options.");
    const normal = await executor.execute({ source: `export default () => ({ ok: true });` });
    const timeout = await executor.execute({
      source: `export default () => { while (true) {} };`,
      timeoutMs: 150,
    });
    const output = await executor.execute({
      source: `export default () => { console.log("x".repeat(10000)); return null; };`,
      maxOutputBytes: 256,
    });
    const configured = await configuredExecutor.execute({
      source: `export default () => ({ configured: true });`,
    });
    const invalidTimeout = await executor.execute({
      source: `export default () => null;`,
      timeoutMs: 0,
    });
    const invalidOutput = await executor.execute({
      source: `export default () => null;`,
      maxOutputBytes: -1,
    });
    await executor.dispose();
    await configuredExecutor.dispose();
    const orphans = await settleProcesses(observations.map((item) => item.pid));
    story.result("normal", normal);
    story.result("timeout", timeout);
    story.result("output", output);
    story.result("configured", configured);
    story.result("invalidTimeout", invalidTimeout);
    story.result("invalidOutput", invalidOutput);
    story.result("hostOwnedLimits", {
      sourceBytesMaximum: 2 * 1024 * 1024,
      timeoutMsMaximum: 60_000,
      evaluatedHere: false,
      reason: "The reviewed contract assigns these request bounds to the Electron production API, not DirectTypeScriptExecutor.",
    });
    story.result("childProcessObservations", observations);
    story.assert("normal real-child execution succeeds", normal.status === "succeeded", "succeeded", normal.status);
    story.assert("synchronous overrun is bounded by timeout", timeout.status === "timed_out" && timeout.error?.code === "TIMED_OUT", "TIMED_OUT", timeout.error);
    story.assert("output overflow is bounded", output.status === "output_limit_exceeded"
      && output.error?.code === "OUTPUT_LIMIT_EXCEEDED"
      && Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) <= 256,
    "bounded OUTPUT_LIMIT_EXCEEDED", output);
    story.assert("portable executor rejects invalid timeout and output bounds", invalidTimeout.error?.code === "INVALID_TIMEOUT"
      && invalidOutput.error?.code === "INVALID_OUTPUT_LIMIT", ["INVALID_TIMEOUT", "INVALID_OUTPUT_LIMIT"], {
      invalidTimeout,
      invalidOutput,
    });
    story.assert("default executable falls back to process.execPath", observations.some((item) =>
      item.options.requestedExecPath === null && item.options.actualExecutable === process.execPath),
    process.execPath, observations);
    story.assert("configured executable is propagated to the real fork", configured.ok === true && observations.some((item) =>
      item.options.requestedExecPath === process.execPath && item.options.actualExecutable === process.execPath),
    process.execPath, observations);
    story.assert("worker options hide Windows consoles and use broker temp cwd", observations.every((item) =>
      item.options.windowsHide === true && item.options.cwd !== run.platformSnapshot), true, observations);
    story.assert("process-option campaign leaves no orphan", orphans.length === 0, [], orphans);
  });

  await runStory(run, "MRT-TS-004", "NODE-INTEGRATION", DEFINITIONS[3][2], async (story) => {
    const observations = [];
    let brokerAbortObserved = false;
    let observeBrokerEntry;
    const brokerEntered = new Promise((resolve) => {
      observeBrokerEntry = resolve;
    });
    const executor = new DirectTypeScriptExecutor(
      { workingDirectory: run.platformSnapshot },
      observingFactory(story, observations),
    );
    story.action("Run concurrent identical modules and abort a sole in-flight worker.");
    const source = `export default async (input) => {
      await new Promise((resolve) => setTimeout(resolve, input.delay));
      return input.value;
    };`;
    const concurrent = await Promise.all([
      executor.execute({ source, input: { delay: 50, value: "one" } }),
      executor.execute({ source, input: { delay: 50, value: "two" } }),
    ]);
    const controller = new AbortController();
    const abortedPromise = executor.execute({
      source: `export default async (_input, context) =>
        context.runtime.invoke("fixture.block", null);`,
      timeoutMs: 30_000,
    }, {
      signal: controller.signal,
      broker: {
        search: async () => null,
        invoke: async (_capability, _input, brokerContext) => {
          observeBrokerEntry();
          return await new Promise((_resolve, reject) => {
            const abort = () => {
              brokerAbortObserved = true;
              reject(brokerContext.signal.reason);
            };
            if (brokerContext.signal.aborted) abort();
            else brokerContext.signal.addEventListener("abort", abort, { once: true });
          });
        },
      },
    });
    let brokerEntryTimer;
    const brokerReached = await Promise.race([
      brokerEntered.then(() => true),
      new Promise((resolve) => {
        brokerEntryTimer = setTimeout(() => resolve(false), 15_000);
      }),
    ]);
    if (brokerEntryTimer) clearTimeout(brokerEntryTimer);
    controller.abort("platform acceptance cancellation");
    const aborted = await abortedPromise;
    await executor.dispose();
    const orphans = await settleProcesses(observations.map((item) => item.pid));
    story.result("concurrent", concurrent);
    story.result("aborted", aborted);
    story.result("brokerReached", brokerReached);
    story.result("brokerAbortObserved", brokerAbortObserved);
    story.result("childProcessObservations", observations);
    story.result("hostIdempotencyCoverage", {
      covered: false,
      reason: "DirectTypeScriptExecutor does not own the Electron API idempotency ledger.",
    });
    story.assert("concurrent real-worker calls settle successfully", concurrent.every((item) => item.ok), true, concurrent);
    story.assert("sole waiter cancellation reaches the child and broker", brokerReached
      && aborted.status === "aborted"
      && aborted.error?.code === "ABORTED" && brokerAbortObserved, "ABORTED and broker cleanup", {
      aborted,
      brokerReached,
      brokerAbortObserved,
    });
    story.assert("cancellation and disposal leave no orphan", orphans.length === 0, [], orphans);
  });
}

export const TYPESCRIPT_STORY_DEFINITIONS = DEFINITIONS;
