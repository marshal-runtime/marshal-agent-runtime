import { createRequire } from "node:module";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { errorRecord, inventoryTree, runStory, sha256Text } from "./lib.mjs";
import { launchWorker } from "./worker-client.mjs";

export const PUI_STORY_DEFINITIONS = [
  ["MRT-PUI-001", "NODE-INTEGRATION", {}],
  ["MRT-PUI-002", "NODE-INTEGRATION", {}],
  ["MRT-PUI-003", "NODE-INTEGRATION", {}],
  ["MRT-PUI-004", "NODE-INTEGRATION", {}],
  ["MRT-PUI-005", "NODE-INTEGRATION", {}],
];

async function importPublic(consumerRoot, specifier) {
  const requireFromConsumer = createRequire(path.join(consumerRoot, "package.json"));
  return await import(pathToFileURL(requireFromConsumer.resolve(specifier)).href);
}

function context(sessionId = "session") {
  return {
    principal: { id: "platform-acceptance", kind: "agent" },
    scope: { workspaceId: "workspace", projectId: "project", sessionId },
  };
}

function compiledComponent(title, sourcePath, sourceDigest, body) {
  const style = "";
  const script = "";
  const html = `<main>${body}</main><style>${style}</style><script>${script}</script>`;
  const bundleDigest = sha256Text(`${script}\0${style}`);
  const htmlDigest = sha256Text(html);
  const inputs = [sourcePath];
  const id = sha256Text(JSON.stringify({
    protocol: 1,
    sourceKind: "workspace_file",
    sourcePath,
    sourceDigest,
    bundleDigest,
    htmlDigest,
    title,
    description: "",
    registeredComponent: null,
    authoringProfile: undefined,
    inputs,
  }));
  return {
    id,
    title,
    sourceKind: "workspace_file",
    sourcePath,
    sourceDigest,
    bundleDigest,
    htmlDigest,
    createdAt: new Date(0).toISOString(),
    resourceUri: `ui://marshal-react/${id}/index.html`,
    html,
    inputs,
  };
}

async function capture(action) {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    return { ok: false, error: errorRecord(error) };
  }
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function walk(root) {
  const found = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const value = path.join(directory, entry.name);
      found.push(value);
      if (entry.isDirectory()) await visit(value);
    }
  }
  await visit(root);
  return found;
}

export async function runPuiCampaign(run) {
  const ui = await importPublic(run.consumerRoot, "@marshal/runtime/ui");

  await runStory(run, "MRT-PUI-001", "NODE-INTEGRATION", {}, async (story) => {
    const root = path.join(run.fixtureRoot, "MRT-PUI-001");
    await mkdir(root, { recursive: true });
    story.root(root);
    const key = "a".repeat(64);
    const requestDigest = "b".repeat(64);
    const first = await launchWorker(run, run.workerPath, run.consumerRoot, "pui-predecessor");
    const second = await launchWorker(run, run.workerPath, run.consumerRoot, "pui-successor");
    story.child(first.pid);
    story.child(second.pid);
    story.action("Claim in process A, expire, claim successor in B, then exercise stale A operations.");
    const predecessor = await first.request("pui.claim", {
      storeId: "store",
      storageRoot: root,
      key,
      requestDigest,
      leaseMs: 100,
    });
    await delay(175);
    const successor = await second.request("pui.claim", {
      storeId: "store",
      storageRoot: root,
      key,
      requestDigest,
      leaseMs: 2_000,
    });
    const staleRenew = await first.request("pui.renew", {
      storeId: "store",
      storageRoot: root,
      key,
      lease: predecessor.lease,
      leaseMs: 2_000,
    });
    const staleComplete = await capture(() => first.request("pui.complete", {
      storeId: "store",
      storageRoot: root,
      key,
      lease: predecessor.lease,
      output: { owner: "predecessor" },
    }));
    const staleRelease = await first.request("pui.release", {
      storeId: "store",
      storageRoot: root,
      key,
      lease: predecessor.lease,
    });
    const completed = await second.request("pui.complete", {
      storeId: "store",
      storageRoot: root,
      key,
      lease: successor.lease,
      output: { owner: "successor" },
    });
    const replay = await first.request("pui.claim", {
      storeId: "store",
      storageRoot: root,
      key,
      requestDigest,
      leaseMs: 1_000,
    });
    story.result("predecessor", predecessor);
    story.result("successor", successor);
    story.result("staleRenew", staleRenew);
    story.result("staleComplete", staleComplete);
    story.result("staleRelease", staleRelease);
    story.result("completed", completed);
    story.result("replay", replay);
    story.result("filesystem", await inventoryTree(root));
    story.assert("process B acquires successor ownership", successor.status === "acquired"
      && successor.lease.ownerId !== predecessor.lease.ownerId, "different successor owner", successor);
    story.assert("expired predecessor cannot renew", staleRenew === undefined, undefined, staleRenew);
    story.assert("expired predecessor completion fails exactly", staleComplete.error?.message === "UI action idempotency lease was lost before completion",
      "UI action idempotency lease was lost before completion", staleComplete);
    story.assert("predecessor release cannot displace successor", staleRelease.released === true, true, staleRelease);
    story.assert("successor is the only replayable record", replay.status === "replay"
      && replay.record.result.output.owner === "successor", "successor replay", replay);
    await first.terminate();
    await second.terminate();
  });

  await runStory(run, "MRT-PUI-002", "NODE-INTEGRATION", {}, async (story) => {
    const root = path.join(run.fixtureRoot, "MRT-PUI-002");
    await mkdir(root, { recursive: true });
    story.root(root);
    const options = { actionTransactionTimeoutMs: 150, actionTransactionStaleMs: 75 };
    const key = "c".repeat(64);
    const owner = await launchWorker(run, run.workerPath, run.consumerRoot, "pui-lock-owner");
    const contender = await launchWorker(run, run.workerPath, run.consumerRoot, "pui-lock-contender");
    story.child(owner.pid);
    story.child(contender.pid);
    story.action("Hold a heartbeating transaction, verify timeout, kill exact owner, and recover stale lock.");
    const acquired = await owner.request("pui.transaction.acquire", {
      storeId: "owner",
      storageRoot: root,
      options,
      key,
      lockId: "owner-lock",
    });
    await delay(225);
    const healthy = await owner.request("pui.transaction.healthy", { lockId: "owner-lock" });
    const blocked = await capture(() => contender.request("pui.transaction.acquire", {
      storeId: "contender",
      storageRoot: root,
      options,
      key,
      lockId: "blocked-lock",
    }));
    await owner.terminate();
    await delay(150);
    const recovered = await contender.request("pui.transaction.acquire", {
      storeId: "recovery",
      storageRoot: root,
      options: { actionTransactionTimeoutMs: 1_000, actionTransactionStaleMs: 75 },
      key,
      lockId: "recovered-lock",
    });
    await contender.request("pui.transaction.release", { lockId: "recovered-lock" });

    const unsafeKey = "d".repeat(64);
    const lockDirectory = path.join(
      root,
      "scopes",
      ui.stateScopeKey(context(), "project"),
      "action-locks",
    );
    await mkdir(lockDirectory, { recursive: true });
    const unsafePath = path.join(lockDirectory, `${unsafeKey}.lock`);
    await writeFile(unsafePath, "not a valid lock");
    const unsafeFile = await capture(() => contender.request("pui.transaction.acquire", {
      storeId: "unsafe-file",
      storageRoot: root,
      options: { actionTransactionTimeoutMs: 250, actionTransactionStaleMs: 75 },
      key: unsafeKey,
      lockId: "unsafe-file-lock",
    }));
    await rm(unsafePath, { recursive: true, force: true });
    const outside = path.join(root, "outside-lock-target");
    await mkdir(outside, { recursive: true });
    let unsafeLink;
    try {
      await symlink(outside, unsafePath, process.platform === "win32" ? "junction" : "dir");
      unsafeLink = await capture(() => contender.request("pui.transaction.acquire", {
        storeId: "unsafe-link",
        storageRoot: root,
        options: { actionTransactionTimeoutMs: 250, actionTransactionStaleMs: 75 },
        key: unsafeKey,
        lockId: "unsafe-link-lock",
      }));
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        story.block("filesystem permits required unsafe link fixture", errorRecord(error));
      } else {
        throw error;
      }
    }
    story.result("acquired", acquired);
    story.result("healthy", healthy);
    story.result("blocked", blocked);
    story.result("recovered", recovered);
    story.result("unsafeFile", unsafeFile);
    story.result("unsafeLink", unsafeLink);
    story.result("filesystem", await inventoryTree(root));
    story.assert("live heartbeat prevents lock theft", healthy.healthy === true
      && blocked.error?.code === "UI_ACTION_TRANSACTION_TIMEOUT", "healthy + timeout", { healthy, blocked });
    story.assert("dead owner is recovered after stale bound", recovered.lockId === "recovered-lock", "recovered-lock", recovered);
    story.assert("unsafe file lock is rejected", unsafeFile.ok === false, "rejected", unsafeFile);
    if (unsafeLink) story.assert("unsafe linked lock is rejected", unsafeLink.ok === false, "rejected", unsafeLink);
    await contender.terminate();
  });

  await runStory(run, "MRT-PUI-003", "NODE-INTEGRATION", {}, async (story) => {
    const root = path.join(run.fixtureRoot, "MRT-PUI-003");
    await mkdir(root, { recursive: true });
    story.root(root);
    const originalContext = context("legacy-session");
    const laterContext = context("later-session");
    const unsigned = compiledComponent(
      "Legacy component",
      "Legacy.tsx",
      "f".repeat(64),
      "legacy",
    );
    const id = unsigned.id;
    const unsignedStore = new ui.ReactUiStore({ storageRoot: root });
    await unsignedStore.putComponent(unsigned, originalContext);
    const currentDirectory = path.join(root, "scopes", ui.scopeKey(originalContext));
    const legacyDirectory = path.join(root, "scopes", ui.legacySessionScopeKey(originalContext));
    await rename(currentDirectory, legacyDirectory);
    const componentPath = path.join(legacyDirectory, "components", `${id}.json`);
    const component = JSON.parse(await readFile(componentPath, "utf8"));
    await writeFile(componentPath, `${JSON.stringify({
      ...component,
      scopeKey: ui.legacySessionScopeKey(originalContext),
    }, null, 2)}\n`);

    const hidden = await capture(() => new ui.ReactUiStore({
      storageRoot: root,
      recoverLegacySessionScopes: false,
    }).getComponent(id, laterContext));
    const recovered = await capture(() => new ui.ReactUiStore({
      storageRoot: root,
      recoverLegacySessionScopes: true,
    }).getComponent(id, laterContext));
    const authenticator = new ui.HmacReactUiRecordAuthenticator({
      authorityId: "platform-acceptance",
      key: new Uint8Array(32).fill(7),
    });
    await rm(path.join(root, "scopes", ui.scopeKey(laterContext)), { recursive: true, force: true });
    const secureReject = await capture(() => new ui.ReactUiStore({
      storageRoot: root,
      recoverLegacySessionScopes: true,
      recordAuthenticator: authenticator,
    }).getComponent(id, laterContext));
    const contentOnly = await capture(() => new ui.ReactUiStore({
      storageRoot: root,
      recoverLegacySessionScopes: true,
      recordAuthenticator: authenticator,
      unsignedRecordPolicy: "content-only",
    }).getComponent(id, laterContext));
    const signedRoot = path.join(root, "signed");
    const signedComponent = compiledComponent(
      "Signed component",
      "Signed.tsx",
      "8".repeat(64),
      "signed",
    );
    const signedId = signedComponent.id;
    const signedStore = new ui.ReactUiStore({
      storageRoot: signedRoot,
      recordAuthenticator: authenticator,
    });
    await signedStore.putComponent(signedComponent, laterContext);
    const signed = await capture(() => signedStore.getComponent(signedId, laterContext));
    story.result("hidden", hidden);
    story.result("recovered", recovered);
    story.result("secureReject", secureReject);
    story.result("contentOnly", contentOnly);
    story.result("signed", signed);
    story.result("filesystem", await inventoryTree(root));
    story.assert("legacy session records are invisible by default", hidden.ok === false && /not found/i.test(hidden.error?.message), "not found", hidden);
    story.assert("legacy recovery is explicit", recovered.ok === true && recovered.value.id === id, id, recovered);
    story.assert("secure authenticator does not recover unsigned executable records", secureReject.ok === false,
      "unsigned record rejected or hidden", secureReject);
    story.assert("content-only compatibility policy permits explicit recovery", contentOnly.ok === true && contentOnly.value.id === id, id, contentOnly);
    story.assert("authenticated executable records reopen with the same authority", signed.ok === true
      && signed.value.id === signedId, signedId, signed);
  });

  await runStory(run, "MRT-PUI-004", "NODE-INTEGRATION", {}, async (story) => {
    const root = path.join(run.fixtureRoot, "MRT-PUI-004");
    await mkdir(root, { recursive: true });
    story.root(root);
    const store = new ui.ReactUiStore({
      storageRoot: root,
      actionTransactionTimeoutMs: 1_000,
      actionTransactionStaleMs: 100,
    });
    const key = "2".repeat(64);
    const digest = "3".repeat(64);
    const claim = await store.claim(key, "project", digest, 10_000, context());
    if (claim.status !== "acquired") throw new Error("Expected initial acquired claim.");
    const attempt = {
      receiptId: "receipt-pui-004",
      executionId: "execution-pui-004",
      lineage: { rootExecutionId: "execution-pui-004", depth: 0 },
      renderId: "4".repeat(64),
      actionId: "execute",
      actionVersion: "1.0.0",
      target: { kind: "capability", capability: "acceptance.execute" },
      scope: "project",
      principalId: "platform-acceptance",
      idempotencyKey: "external-key",
      requestDigest: digest,
      targetIdempotencyKey: "6".repeat(64),
      startedAt: new Date().toISOString(),
      ownerId: claim.lease.ownerId,
      leaseExpiresAt: claim.lease.expiresAt,
      ownerPid: process.pid,
      phase: "pending",
    };
    await store.begin(key, "project", attempt, context());
    const unavailable = `${root}.temporarily-unavailable`;
    await rename(root, unavailable);
    const sameDigest = await store.claim(key, "project", digest, 10_000, context());
    const differentDigest = await capture(() => store.claim(key, "project", "5".repeat(64), 10_000, context()));
    await rename(unavailable, root);

    const leaseFiles = (await walk(root)).filter((item) => path.basename(item) === `${key}.json`);
    const leasePath = leaseFiles.find((item) => item.includes("action-leases"));
    if (!leasePath) throw new Error("Expected persisted lease path.");
    let releaseBlocker;
    const blocked = new Promise((resolve) => { releaseBlocker = resolve; });
    let enteredBlocker;
    const entered = new Promise((resolve) => { enteredBlocker = resolve; });
    const blocker = store.withActionTransaction(key, "project", context(), async () => {
      enteredBlocker();
      await blocked;
    });
    await entered;
    let contenderExpiry;
    const contender = store.withActionTransaction(key, "project", context(), async () => {
      contenderExpiry = JSON.parse(await readFile(leasePath, "utf8")).expiresAt;
    });
    await Promise.resolve();
    const renewal = store.renew(key, "project", claim.lease, 10_000, context());
    await Promise.resolve();
    releaseBlocker();
    const renewed = await renewal;
    await Promise.all([blocker, contender]);
    const invalidExpiry = await capture(() => store.renew(
      key,
      "project",
      { ...renewed, expiresAt: "invalid" },
      10_000,
      context(),
    ));
    const record = successRecord(digest, key);
    await store.complete(key, "project", renewed, record, context());
    const replayAfterComplete = await store.claim(key, "project", digest, 1_000, context());
    await store.release(key, "project", renewed, context());
    await store.close(key, "project", attempt.receiptId, context()).catch(() => undefined);
    const replayAfterRelease = await store.claim(key, "project", digest, 1_000, context());
    story.result("sameDigest", sameDigest);
    story.result("differentDigest", differentDigest);
    story.result("renewed", renewed);
    story.result("contenderObservedExpiry", contenderExpiry);
    story.result("invalidExpiry", invalidExpiry);
    story.result("replayAfterComplete", replayAfterComplete);
    story.result("replayAfterRelease", replayAfterRelease);
    story.assert("same-digest busy claim needs no accessible filesystem", sameDigest.status === "busy", "busy", sameDigest);
    story.assert("different digest conflicts before filesystem access", /reused with a different request/.test(differentDigest.error?.message), "exact reuse error", differentDigest);
    story.assert("renewal runs before later-deadline contender", Date.parse(contenderExpiry) > Date.parse(claim.lease.expiresAt), `>${claim.lease.expiresAt}`, contenderExpiry);
    story.assert("invalid expiresAt fails exactly", invalidExpiry.error?.message === "UI action idempotency lease expiration validation failed",
      "UI action idempotency lease expiration validation failed", invalidExpiry);
    story.assert("complete clears the in-memory lease before a fresh claim", replayAfterComplete.status === "replay",
      "replay immediately after complete", replayAfterComplete);
    story.assert("cleanup preserves the persistent replay", replayAfterRelease.status === "replay",
      "replay after cleanup", replayAfterRelease);
  });

  await runStory(run, "MRT-PUI-005", "NODE-INTEGRATION", {}, async (story) => {
    const root = path.join(run.fixtureRoot, "MRT-PUI-005");
    await mkdir(root, { recursive: true });
    story.root(root);
    const idempotencyKey = "four-contender-replay";
    const first = await launchWorker(run, run.workerPath, run.consumerRoot, "pui-four-calls");
    story.child(first.pid);
    story.action("Run one live caller plus three contenders, settle, terminate, and replay after process restart.");
    const firstRun = await first.request("pui.four-replay", {
      storageRoot: root,
      idempotencyKey,
      count: 4,
    });
    await first.terminate();
    const second = await launchWorker(run, run.workerPath, run.consumerRoot, "pui-restart");
    story.child(second.pid);
    const restarted = await second.request("pui.four-replay", {
      storageRoot: root,
      idempotencyKey,
      count: 1,
    });
    await second.terminate();
    const files = await walk(root);
    const receipts = firstRun.results.map((item) => item.receipt.receiptId);
    story.result("firstRun", firstRun);
    story.result("restarted", restarted);
    story.result("filesystem", await inventoryTree(root));
    story.assert("one caller executes and three contenders replay", firstRun.executions === 1
      && firstRun.results.length === 4
      && firstRun.results.filter((item) => item.receipt?.replayed === true).length === 3,
    "1 execution, 3 replayed", firstRun);
    story.assert("all four callers receive the same receipt", new Set(receipts).size === 1, "one receipt", receipts);
    story.assert("restart re-discovers the persisted replay without executing", restarted.executions === 0
      && restarted.results[0]?.receipt?.replayed === true
      && restarted.results[0]?.receipt?.receiptId === receipts[0], "disk replay/same receipt", restarted);
    story.assert("transaction queues and temporary filesystem state are cleaned", files.every((item) =>
      !/\.lock$|\.write-|\.candidate-|\.stale-/.test(item)), "no temporary lock/write/candidate/stale files", files);
  });
}

function successRecord(requestDigest, key) {
  const timestamp = new Date().toISOString();
  return {
    requestDigest,
    result: {
      status: "success",
      output: { ok: true },
      receipt: {
        receiptId: "receipt-pui-004",
        executionId: "execution-pui-004",
        lineage: { rootExecutionId: "execution-pui-004", depth: 0 },
        renderId: "4".repeat(64),
        actionId: "execute",
        actionVersion: "1.0.0",
        target: { kind: "capability", capability: "acceptance.execute" },
        scope: "project",
        principalId: "platform-acceptance",
        idempotencyKey: key,
        requestDigest,
        targetIdempotencyKey: "6".repeat(64),
        permission: { decision: "allow", grants: ["acceptance.execute"] },
        status: "success",
        startedAt: timestamp,
        completedAt: timestamp,
        durationMs: 0,
      },
    },
  };
}
