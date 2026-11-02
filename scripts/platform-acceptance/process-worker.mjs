import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const consumerRootIndex = process.argv.indexOf("--consumer-root");
const consumerRoot = consumerRootIndex >= 0 ? process.argv[consumerRootIndex + 1] : undefined;
if (!consumerRoot) throw new Error("Missing --consumer-root.");

const requireFromConsumer = createRequire(path.join(consumerRoot, "package.json"));
const moduleCache = new Map();
const stores = new Map();
const transactionLocks = new Map();

async function publicModule(specifier) {
  if (!moduleCache.has(specifier)) {
    const resolved = requireFromConsumer.resolve(specifier);
    moduleCache.set(specifier, import(pathToFileURL(resolved).href));
  }
  return await moduleCache.get(specifier);
}

function context() {
  return {
    principal: { id: "platform-acceptance", kind: "agent" },
    scope: { workspaceId: "workspace", projectId: "project", sessionId: "session" },
  };
}

async function store(storeId, storageRoot, options = {}) {
  if (!stores.has(storeId)) {
    const { ReactUiStore } = await publicModule("@marshal/runtime/ui");
    stores.set(storeId, new ReactUiStore({ storageRoot, ...options }));
  }
  return stores.get(storeId);
}

function successRecord(requestDigest, key, output = { ok: true }) {
  const timestamp = new Date().toISOString();
  return {
    requestDigest,
    result: {
      status: "success",
      output,
      receipt: {
        receiptId: `receipt-${key.slice(0, 12)}`,
        executionId: `execution-${key.slice(0, 12)}`,
        lineage: { rootExecutionId: `execution-${key.slice(0, 12)}`, depth: 0 },
        renderId: "1".repeat(64),
        actionId: "platform-acceptance",
        actionVersion: "1.0.0",
        target: { kind: "capability", capability: "acceptance.execute" },
        scope: "project",
        principalId: "platform-acceptance",
        idempotencyKey: key,
        requestDigest,
        targetIdempotencyKey: "f".repeat(64),
        permission: { decision: "allow", grants: ["acceptance.execute"] },
        status: "success",
        startedAt: timestamp,
        completedAt: timestamp,
        durationMs: 0,
      },
    },
  };
}

async function execute(operation, args) {
  if (operation === "integrity.compute") {
    const { computeRuntimeExtensionIntegrity } = await publicModule("@marshal/runtime/extensions");
    return computeRuntimeExtensionIntegrity(args.packageRoot);
  }
  if (operation === "pui.claim") {
    const value = await store(args.storeId, args.storageRoot, args.options);
    return await value.claim(args.key, "project", args.requestDigest, args.leaseMs, context());
  }
  if (operation === "pui.renew") {
    const value = await store(args.storeId, args.storageRoot, args.options);
    return await value.renew(args.key, "project", args.lease, args.leaseMs, context());
  }
  if (operation === "pui.complete") {
    const value = await store(args.storeId, args.storageRoot, args.options);
    return await value.complete(
      args.key,
      "project",
      args.lease,
      successRecord(args.lease.requestDigest, args.key, args.output),
      context(),
    );
  }
  if (operation === "pui.release") {
    const value = await store(args.storeId, args.storageRoot, args.options);
    await value.release(args.key, "project", args.lease, context());
    return { released: true };
  }
  if (operation === "pui.transaction.acquire") {
    const value = await store(args.storeId, args.storageRoot, args.options);
    const canonicalRoot = await value.root();
    const lock = await value.acquireActionTransaction(
      canonicalRoot,
      args.key,
      "project",
      context(),
    );
    transactionLocks.set(args.lockId, lock);
    return { lockId: args.lockId, canonicalRoot };
  }
  if (operation === "pui.transaction.healthy") {
    const lock = transactionLocks.get(args.lockId);
    if (!lock) throw new Error(`Unknown transaction lock ${args.lockId}`);
    await lock.assertHealthy();
    return { healthy: true };
  }
  if (operation === "pui.transaction.release") {
    const lock = transactionLocks.get(args.lockId);
    if (!lock) return { released: false };
    await lock.release();
    transactionLocks.delete(args.lockId);
    return { released: true };
  }
  if (operation === "pui.four-replay") {
    const { ReactUiStore, UiActionDispatcher } = await publicModule("@marshal/runtime/ui");
    const idempotencyStore = new ReactUiStore({
      storageRoot: args.storageRoot,
      actionTransactionTimeoutMs: 2_000,
      actionTransactionStaleMs: 250,
    });
    let executions = 0;
    const application = {
      version: "1.0.0",
      presentationModes: ["inline"],
      actions: [{
        id: "execute",
        version: "1.0.0",
        target: { kind: "capability", capability: "acceptance.execute" },
        inputSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: { acknowledged: { type: "boolean" } },
          required: ["acknowledged"],
          additionalProperties: false,
        },
        allowedScopes: ["project"],
        requiredPermissions: ["acceptance.execute"],
        risk: "write",
        idempotency: "required",
      }],
      tools: [],
    };
    const dispatcher = new UiActionDispatcher({
      loadApplication: async () => application,
      authorize: {
        authorize: async () => ({ decision: "allow", grants: ["acceptance.execute"] }),
      },
      executor: {
        execute: async (_request, executionContext) => {
          executions += 1;
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 150);
            executionContext.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(executionContext.signal.reason);
            }, { once: true });
          });
          const timestamp = new Date().toISOString();
          return {
            protocolVersion: "1.0.0",
            status: "success",
            result: { output: { acknowledged: true } },
            receipt: {
              protocolVersion: "1.0.0",
              receiptId: "target-receipt",
              executionId: "target-execution",
              target: "acceptance.execute",
              principalId: "platform-acceptance",
              lineage: { rootExecutionId: "target-execution", depth: 0 },
              status: "success",
              startedAt: timestamp,
              completedAt: timestamp,
              durationMs: 0,
            },
          };
        },
      },
      idempotencyStore,
      journalStore: idempotencyStore,
      idempotencyLeaseMs: 1_000,
      idempotencyPollMs: 10,
    });
    const request = {
      renderId: "2".repeat(64),
      actionId: "execute",
      input: { value: 7 },
      scope: "project",
      idempotencyKey: args.idempotencyKey,
    };
    const results = await Promise.all(Array.from({ length: args.count ?? 4 }, () =>
      dispatcher.invoke(request, context())));
    return { results, executions };
  }
  throw new Error(`Unsupported worker operation ${operation}`);
}

process.on("message", async (message) => {
  if (!message || typeof message !== "object" || typeof message.id !== "string") return;
  try {
    const value = await execute(message.operation, message.args ?? {});
    process.send?.({ id: message.id, ok: true, value });
  } catch (error) {
    process.send?.({
      id: message.id,
      ok: false,
      error: {
        name: error instanceof Error ? error.name : "NonError",
        message: error instanceof Error ? error.message : String(error),
        ...(error && typeof error === "object" && typeof error.code === "string"
          ? { code: error.code }
          : {}),
        stack: error instanceof Error ? error.stack : undefined,
      },
    });
  }
});

process.send?.({ type: "ready", pid: process.pid });
