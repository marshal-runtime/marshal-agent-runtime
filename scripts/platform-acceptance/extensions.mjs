import { fork, spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  addSparseFile,
  invocationContext,
  provider,
  providerModuleSource,
  writeExtensionFixture,
} from "./extension-fixtures.mjs";
import { errorRecord, inventoryTree, pathExists, runStory } from "./lib.mjs";
import { launchWorker } from "./worker-client.mjs";

export const EXTENSION_STORY_DEFINITIONS = [
  ["MRT-EXT-002", "NODE-INTEGRATION", { requiredLiveEvidence: "LIVE-ELECTRON" }],
  ["MRT-EXT-003", "NODE-INTEGRATION", { requiredLiveEvidence: "LIVE-ELECTRON" }],
  ["MRT-EXT-004", "NODE-INTEGRATION", { requiredLiveEvidence: "LIVE-ELECTRON" }],
  ["MRT-EXT-005", "NODE-INTEGRATION", { requiredLiveEvidence: "LIVE-ELECTRON" }],
  ["MRT-EXT-006", "NODE-INTEGRATION", { requiredLiveEvidence: "LIVE-ELECTRON" }],
  ["MRT-EXT-008", "NODE-INTEGRATION", { requiredLiveEvidence: "LIVE-ELECTRON" }],
  ["MRT-EXT-009", "NODE-INTEGRATION+STATIC", { requiredLiveEvidence: "LIVE-ELECTRON" }],
  ["MRT-EXT-010", "NODE-INTEGRATION", { requiredLiveEvidence: "LIVE-ELECTRON" }],
  ["MRT-EXT-011", "NODE-INTEGRATION", { requiredLiveEvidence: "LIVE-ELECTRON" }],
  ["MRT-EXT-012", "NODE-INTEGRATION", { requiredLiveEvidence: "LIVE-ELECTRON" }],
  ["MRT-EXT-013", "NODE-INTEGRATION", { requiredLiveEvidence: "LIVE-ELECTRON" }],
];

async function importPublic(consumerRoot, specifier) {
  const requireFromConsumer = createRequire(path.join(consumerRoot, "package.json"));
  return await import(pathToFileURL(requireFromConsumer.resolve(specifier)).href);
}

async function capture(action) {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    return { ok: false, error: errorRecord(error) };
  }
}

async function fixtureRequest(extensions, root, name, options) {
  const fixture = await writeExtensionFixture(path.join(root, name), options);
  return {
    fixture,
    request: {
      packageRoot: fixture.root,
      integrity: extensions.computeRuntimeExtensionIntegrity(fixture.root),
    },
  };
}

function managerFor(core, extensions, allowedRoot, extraKernelProviders = []) {
  const kernel = core.createRuntimeKernel({
    permissionBroker: core.createAllowAllPermissionBroker(),
  });
  for (const item of extraKernelProviders) kernel.register(item);
  return {
    kernel,
    manager: new extensions.RuntimeExtensionManager({
      kernel,
      loader: new extensions.LocalRuntimeExtensionPackageLoader({ allowedRoots: [allowedRoot] }),
      activationContext: invocationContext(),
    }),
  };
}

async function invokeValue(kernel, capability) {
  const response = await kernel.execute({
    protocolVersion: "1.0.0",
    targetType: "operation",
    target: capability,
    input: {},
  }, invocationContext());
  return response.result?.output?.value;
}

export async function runExtensionCampaign(run) {
  const core = await importPublic(run.consumerRoot, "@marshal/runtime/core");
  const extensions = await importPublic(run.consumerRoot, "@marshal/runtime/extensions");
  const context = invocationContext();

  await runStory(run, "MRT-EXT-002", "NODE-INTEGRATION", EXTENSION_STORY_DEFINITIONS[0][2], async (story) => {
    const root = path.join(run.fixtureRoot, "MRT-EXT-002");
    await mkdir(root, { recursive: true });
    story.root(root);
    const fixture = await fixtureRequest(extensions, root, "live", {
      identity: "@acceptance/live",
      providerId: "acceptance.live",
      capability: "acceptance.live.echo",
      value: "live",
    });
    const { kernel, manager } = managerFor(core, extensions, root);
    story.action("Install a verified filesystem extension and invoke it without restarting the kernel.");
    const record = await manager.install(fixture.request);
    const found = await kernel.get("acceptance.live.echo", context);
    const value = await invokeValue(kernel, "acceptance.live.echo");
    story.result("fixture", { manifest: fixture.fixture.manifest, request: fixture.request });
    story.result("record", record);
    story.result("provider", found);
    story.result("value", value);
    story.assert("install preserves identity/version and enables immediately", record.identity === "@acceptance/live"
      && record.version === "1.0.0" && record.status === "enabled", true, record);
    story.assert("installed capability is immediately searchable and invokable", found?.provider.id === "acceptance.live" && value === "live", true, { found, value });
    await manager.dispose();
  });

  await runStory(run, "MRT-EXT-003", "NODE-INTEGRATION", EXTENSION_STORY_DEFINITIONS[1][2], async (story) => {
    const root = path.join(run.fixtureRoot, "MRT-EXT-003");
    await mkdir(root, { recursive: true });
    story.root(root);
    const first = await fixtureRequest(extensions, root, "v1", {
      identity: "@acceptance/update",
      version: "1.0.0",
      providerId: "acceptance.update",
      capability: "acceptance.update.v1",
      value: "v1",
      disposeGlobal: "__acceptanceUpdateDisposed",
    });
    const second = await fixtureRequest(extensions, root, "v2", {
      identity: "@acceptance/update",
      version: "2.0.0",
      providerId: "acceptance.update",
      capability: "acceptance.update.v2",
      value: "v2",
    });
    const { kernel, manager } = managerFor(core, extensions, root);
    await manager.install(first.request);
    story.action("Update while concurrent readers inspect complete kernel inventories.");
    const observations = [];
    let stop = false;
    const reader = (async () => {
      while (!stop) {
        try {
          observations.push((await kernel.list(context)).map((item) => item.name));
        } catch (error) {
          observations.push({ error: errorRecord(error) });
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    })();
    const updated = await manager.update("@acceptance/update", second.request);
    stop = true;
    await reader;
    const final = (await kernel.list(context)).map((item) => item.name);
    story.result("readerObservations", observations);
    story.result("updated", updated);
    story.result("final", final);
    story.assert("every reader sees a complete old or new contribution set", observations.every((items) =>
      Array.isArray(items) && (items.join(",") === "acceptance.update.v1" || items.join(",") === "acceptance.update.v2")),
    "only complete v1 or v2", observations);
    story.assert("old registration disappears and new registration appears once", final.join(",") === "acceptance.update.v2", ["acceptance.update.v2"], final);
    story.assert("old activation disposes after successful replacement", Reflect.get(globalThis, "__acceptanceUpdateDisposed") === 1, 1, Reflect.get(globalThis, "__acceptanceUpdateDisposed"));
    Reflect.deleteProperty(globalThis, "__acceptanceUpdateDisposed");
    await manager.dispose();
  });

  await runStory(run, "MRT-EXT-004", "NODE-INTEGRATION", EXTENSION_STORY_DEFINITIONS[2][2], async (story) => {
    const root = path.join(run.fixtureRoot, "MRT-EXT-004");
    await mkdir(root, { recursive: true });
    story.root(root);
    const first = await fixtureRequest(extensions, root, "v1", {
      identity: "@acceptance/rollback",
      providerId: "acceptance.rollback",
      capability: "acceptance.rollback.echo",
      value: "old",
    });
    const activationFailure = await fixtureRequest(extensions, root, "activation", {
      identity: "@acceptance/rollback",
      version: "2.0.0",
      source: `module.exports = { activate() { throw new Error("activation failed"); } };`,
    });
    const registrationFailure = await fixtureRequest(extensions, root, "registration", {
      identity: "@acceptance/rollback",
      version: "2.1.0",
      providerId: "acceptance.rollback.next",
      capability: "reserved.echo",
      disposeGlobal: "__acceptanceRollbackDisposed",
    });
    const { kernel, manager } = managerFor(core, extensions, root, [
      provider("reserved.provider", "reserved.echo", "reserved"),
    ]);
    await manager.install(first.request);
    const activation = await capture(() => manager.update("@acceptance/rollback", activationFailure.request));
    const registration = await capture(() => manager.update("@acceptance/rollback", registrationFailure.request));
    const value = await invokeValue(kernel, "acceptance.rollback.echo");
    story.result("activationFailure", activation);
    story.result("registrationFailure", registration);
    story.result("record", manager.get("@acceptance/rollback"));
    story.result("kernelInventory", (await kernel.list(context)).map((item) => item.name));
    story.assert("activation failure rolls back to v1", activation.error?.code === "ACTIVATION_FAILED"
      && manager.get("@acceptance/rollback")?.version === "1.0.0" && value === "old", true, { activation, value });
    story.assert("registration failure rolls back and cleans staged activation", registration.error?.code === "REGISTRATION_FAILED"
      && Reflect.get(globalThis, "__acceptanceRollbackDisposed") === 1, true, registration);
    story.assert("no partial next registration remains", !(await kernel.get("acceptance.rollback.next", context)), undefined, await kernel.get("acceptance.rollback.next", context));
    Reflect.deleteProperty(globalThis, "__acceptanceRollbackDisposed");
    await manager.dispose();
  });

  await runStory(run, "MRT-EXT-005", "NODE-INTEGRATION", EXTENSION_STORY_DEFINITIONS[3][2], async (story) => {
    const root = path.join(run.fixtureRoot, "MRT-EXT-005");
    await mkdir(root, { recursive: true });
    story.root(root);
    const fixture = await fixtureRequest(extensions, root, "lifecycle", {
      identity: "@acceptance/lifecycle",
      providerId: "acceptance.lifecycle",
      capability: "acceptance.lifecycle.echo",
    });
    const { kernel, manager } = managerFor(core, extensions, root);
    await manager.install(fixture.request);
    const disabled = await manager.disable("@acceptance/lifecycle");
    const afterDisable = await kernel.get("acceptance.lifecycle.echo", context);
    const enabled = await manager.enable("@acceptance/lifecycle");
    const enabledAgain = await manager.enable("@acceptance/lifecycle");
    const count = (await kernel.list(context)).filter((item) => item.name === "acceptance.lifecycle.echo").length;
    await manager.remove("@acceptance/lifecycle");
    const afterRemove = await kernel.get("acceptance.lifecycle.echo", context);
    story.result("transitions", { disabled, afterDisable, enabled, enabledAgain, count, afterRemove, list: manager.list() });
    story.assert("disable preserves a disabled record and revokes registrations", disabled.status === "disabled" && !afterDisable, true, { disabled, afterDisable });
    story.assert("enable is idempotent and publishes exactly one registration", enabled.status === "enabled" && enabledAgain.status === "enabled" && count === 1, 1, count);
    story.assert("remove deletes record and capability", manager.get("@acceptance/lifecycle") === undefined && afterRemove === undefined, true, { record: manager.get("@acceptance/lifecycle"), afterRemove });
  });

  await runStory(run, "MRT-EXT-006", "NODE-INTEGRATION", EXTENSION_STORY_DEFINITIONS[4][2], async (story) => {
    const root = path.join(run.fixtureRoot, "MRT-EXT-006");
    await mkdir(root, { recursive: true });
    story.root(root);
    const one = await fixtureRequest(extensions, root, "one", {
      identity: "@acceptance/owner-one",
      providerId: "acceptance.owner.one",
      capability: "acceptance.owner.echo",
      resourceUri: "resource://acceptance/owner-one",
    });
    const duplicate = await fixtureRequest(extensions, root, "duplicate", {
      identity: "@acceptance/owner-two",
      providerId: "acceptance.owner.two",
      capability: "acceptance.owner.echo",
      resourceUri: "resource://acceptance/owner-two",
    });
    const unrelated = provider("unrelated.provider", "unrelated.echo", "unrelated");
    const { kernel, manager } = managerFor(core, extensions, root, [unrelated]);
    await manager.install(one.request);
    const failed = await capture(() => manager.install(duplicate.request));
    const beforeDispose = (await kernel.list(context)).map((item) => item.name);
    await manager.remove("@acceptance/owner-one");
    const afterDispose = (await kernel.list(context)).map((item) => item.name);
    story.result("duplicateFailure", failed);
    story.result("beforeDispose", beforeDispose);
    story.result("afterDispose", afterDispose);
    story.assert("duplicate contribution fails atomically", failed.error?.code === "REGISTRATION_FAILED", "REGISTRATION_FAILED", failed);
    story.assert("first ownership remains intact after duplicate failure", beforeDispose.includes("acceptance.owner.echo"), true, beforeDispose);
    story.assert("disposing owner removes only its registrations", afterDispose.join(",") === "unrelated.echo", ["unrelated.echo"], afterDispose);
  });

  await runLoaderMatrix(run, core, extensions);
  await runRootSafety(run, core, extensions);

  await runStory(run, "MRT-EXT-010", "NODE-INTEGRATION", EXTENSION_STORY_DEFINITIONS[7][2], async (story) => {
    const root = path.join(run.fixtureRoot, "MRT-EXT-010");
    await mkdir(root, { recursive: true });
    story.root(root);
    const fixture = await fixtureRequest(extensions, root, "cancel", {
      identity: "@acceptance/cancel",
      disposeGlobal: "__acceptanceCancelDisposed",
      source: `
module.exports = {
  activate(context) {
    context.signal.aborted = true;
    return {
      capabilityProviders: [],
      dispose() { globalThis.__acceptanceCancelDisposed = (globalThis.__acceptanceCancelDisposed || 0) + 1; }
    };
  }
};`,
    });
    const { kernel, manager } = managerFor(core, extensions, root);
    const pre = await capture(() => manager.install(fixture.request, {
      signal: { aborted: true, reason: "pre-load" },
    }));
    const during = await capture(() => manager.install(fixture.request, {
      signal: { aborted: false, reason: undefined },
    }));
    const retryFixture = await fixtureRequest(extensions, root, "retry", {
      identity: "@acceptance/cancel",
      providerId: "acceptance.cancel",
      capability: "acceptance.cancel.echo",
    });
    const retry = await manager.install(retryFixture.request);
    story.result("preLoad", pre);
    story.result("duringActivation", during);
    story.result("retry", retry);
    story.result("inventory", (await kernel.list(context)).map((item) => item.name));
    story.assert("pre-load cancellation is exact and mutation-free", pre.error?.code === "CANCELLED", "CANCELLED", pre);
    story.assert("activation-time cancellation is exact and staged activation is cleaned", during.error?.code === "CANCELLED"
      && Reflect.get(globalThis, "__acceptanceCancelDisposed") === 1, true, during);
    story.assert("cancelled operation does not poison retry", retry.status === "enabled"
      && (await kernel.get("acceptance.cancel.echo", context)) !== undefined, true, retry);
    Reflect.deleteProperty(globalThis, "__acceptanceCancelDisposed");
    await manager.dispose();
  });

  await runStory(run, "MRT-EXT-011", "NODE-INTEGRATION", EXTENSION_STORY_DEFINITIONS[8][2], async (story) => {
    const root = path.join(run.fixtureRoot, "MRT-EXT-011");
    await mkdir(root, { recursive: true });
    story.root(root);
    const first = await fixtureRequest(extensions, root, "first", {
      identity: "@acceptance/zeta",
      version: "1.0.0",
      providerId: "acceptance.zeta",
      capability: "acceptance.zeta.v1",
    });
    const second = await fixtureRequest(extensions, root, "second", {
      identity: "@acceptance/zeta",
      version: "2.0.0",
      providerId: "acceptance.zeta",
      capability: "acceptance.zeta.v2",
    });
    const alpha = await fixtureRequest(extensions, root, "alpha", {
      identity: "@acceptance/alpha",
      providerId: "acceptance.alpha",
      capability: "acceptance.alpha.echo",
    });
    const { kernel, manager } = managerFor(core, extensions, root);
    await manager.install(first.request);
    const duplicate = await capture(() => manager.install(first.request));
    const unknown = {};
    for (const [name, action] of Object.entries({
      update: () => manager.update("@acceptance/missing", second.request),
      disable: () => manager.disable("@acceptance/missing"),
      enable: () => manager.enable("@acceptance/missing"),
      remove: () => manager.remove("@acceptance/missing"),
    })) unknown[name] = await capture(action);
    await manager.disable("@acceptance/zeta");
    const stored = await manager.update("@acceptance/zeta", second.request);
    const inactive = await kernel.get("acceptance.zeta.v2", context);
    await manager.install(alpha.request);
    const sorted = manager.list().map((item) => item.identity);
    await manager.enable("@acceptance/zeta");
    story.result("duplicate", duplicate);
    story.result("unknown", unknown);
    story.result("disabledUpdate", stored);
    story.result("inactiveBeforeEnable", inactive);
    story.result("sorted", sorted);
    story.assert("duplicate install code is exact", duplicate.error?.code === "ALREADY_INSTALLED", "ALREADY_INSTALLED", duplicate);
    story.assert("unknown mutation codes are exact", Object.values(unknown).every((item) => item.error?.code === "NOT_INSTALLED"), "all NOT_INSTALLED", unknown);
    story.assert("disabled update stores v2 without activating it", stored.status === "disabled" && stored.version === "2.0.0" && inactive === undefined, true, { stored, inactive });
    story.assert("list is sorted by identity", sorted.join(",") === [...sorted].sort().join(","), [...sorted].sort(), sorted);
    story.assert("enable activates only stored v2", await kernel.get("acceptance.zeta.v2", context) !== undefined
      && await kernel.get("acceptance.zeta.v1", context) === undefined, true, (await kernel.list(context)).map((item) => item.name));
    await manager.dispose();
  });

  await runStory(run, "MRT-EXT-012", "NODE-INTEGRATION", EXTENSION_STORY_DEFINITIONS[9][2], async (story) => {
    const root = path.join(run.fixtureRoot, "MRT-EXT-012");
    await mkdir(root, { recursive: true });
    story.root(root);
    const one = await fixtureRequest(extensions, root, "one", {
      identity: "@acceptance/dispose-one",
      providerId: "acceptance.dispose.one",
      capability: "acceptance.dispose.one.echo",
      disposeGlobal: "__acceptanceDisposeOne",
      disposeThrows: true,
    });
    const two = await fixtureRequest(extensions, root, "two", {
      identity: "@acceptance/dispose-two",
      providerId: "acceptance.dispose.two",
      capability: "acceptance.dispose.two.echo",
      disposeGlobal: "__acceptanceDisposeTwo",
      disposeThrows: true,
    });
    const { kernel, manager } = managerFor(core, extensions, root, [
      provider("unrelated.provider", "unrelated.echo"),
    ]);
    await manager.install(one.request);
    await manager.install(two.request);
    const remove = await capture(() => manager.remove("@acceptance/dispose-one"));
    const dispose = await capture(() => manager.dispose());
    const post = {};
    for (const [name, action] of Object.entries({
      install: () => manager.install(one.request),
      update: () => manager.update("@acceptance/dispose-two", two.request),
      enable: () => manager.enable("@acceptance/dispose-two"),
      disable: () => manager.disable("@acceptance/dispose-two"),
      remove: () => manager.remove("@acceptance/dispose-two"),
    })) post[name] = await capture(action);
    story.result("remove", remove);
    story.result("dispose", dispose);
    story.result("postDispose", post);
    story.result("markers", {
      one: Reflect.get(globalThis, "__acceptanceDisposeOne"),
      two: Reflect.get(globalThis, "__acceptanceDisposeTwo"),
    });
    story.result("kernelInventory", (await kernel.list(context)).map((item) => item.name));
    story.assert("remove revokes and deletes despite disposal failure", remove.error?.code === "DISPOSAL_FAILED"
      && manager.get("@acceptance/dispose-one") === undefined
      && await kernel.get("acceptance.dispose.one.echo", context) === undefined, true, remove);
    story.assert("manager disposal reports failure after attempting remaining extension", dispose.error?.code === "DISPOSAL_FAILED"
      && Reflect.get(globalThis, "__acceptanceDisposeTwo") === 1, true, dispose);
    story.assert("every later mutation fails MANAGER_DISPOSED", Object.values(post).every((item) => item.error?.code === "MANAGER_DISPOSED"), "all MANAGER_DISPOSED", post);
    story.assert("unrelated kernel registration remains", (await kernel.list(context)).map((item) => item.name).join(",") === "unrelated.echo", ["unrelated.echo"], (await kernel.list(context)).map((item) => item.name));
    for (const key of ["__acceptanceDisposeOne", "__acceptanceDisposeTwo"]) Reflect.deleteProperty(globalThis, key);
  });

  await runIntegrityResources(run, core, extensions);
}

async function runLoaderMatrix(run, core, extensions) {
  await runStory(run, "MRT-EXT-008", "NODE-INTEGRATION", EXTENSION_STORY_DEFINITIONS[5][2], async (story) => {
    const root = path.join(run.fixtureRoot, "MRT-EXT-008");
    const allowed = path.join(root, "allowed");
    await mkdir(allowed, { recursive: true });
    story.root(root);
    story.action("Run the complete finite loader error-code matrix against real package trees.");
    const loader = new extensions.LocalRuntimeExtensionPackageLoader({ allowedRoots: [allowed] });
    const matrix = {};
    async function expectCode(name, expected, action) {
      const outcome = await capture(action);
      matrix[name] = { expected, ...outcome };
      return outcome;
    }
    await expectCode("invalidLoaderRoot", "INVALID_LOADER_ROOT", () =>
      new extensions.LocalRuntimeExtensionPackageLoader({ allowedRoots: [] }));
    await expectCode("invalidRequest", "INVALID_REQUEST", () => loader.load(null));
    const valid = await fixtureRequest(extensions, allowed, "valid", { identity: "@acceptance/loader-valid" });
    await expectCode("invalidIntegrity", "INVALID_INTEGRITY", () => loader.load({
      packageRoot: valid.fixture.root,
      integrity: { algorithm: "md5", domain: "wrong", value: "x" },
    }));
    await expectCode("sourceUnavailable", "SOURCE_UNAVAILABLE", () => loader.load({
      packageRoot: path.join(allowed, "missing"),
      integrity: valid.request.integrity,
    }));
    const outsideRoot = path.join(root, "outside");
    const outside = await fixtureRequest(extensions, outsideRoot, "package", { identity: "@acceptance/outside" });
    await expectCode("rootNotAllowed", "ROOT_NOT_ALLOWED", () => loader.load(outside.request));
    await expectCode("integrityMismatch", "INTEGRITY_MISMATCH", () => loader.load({
      packageRoot: valid.fixture.root,
      integrity: { ...valid.request.integrity, value: "0".repeat(64) },
    }));
    const missingManifest = await writeExtensionFixture(path.join(allowed, "missing-manifest"), {
      identity: "@acceptance/missing-manifest",
      writeManifest: false,
    });
    await expectCode("invalidManifest", "INVALID_MANIFEST", () => loader.load({
      packageRoot: missingManifest.root,
      integrity: extensions.computeRuntimeExtensionIntegrity(missingManifest.root),
    }));
    const identityMismatch = await fixtureRequest(extensions, allowed, "identity-mismatch", {
      identity: "@acceptance/identity-a",
      packageJson: { name: "@acceptance/identity-b" },
    });
    await expectCode("identityMismatch", "IDENTITY_MISMATCH", () => loader.load(identityMismatch.request));
    const versionMismatch = await fixtureRequest(extensions, allowed, "version-mismatch", {
      identity: "@acceptance/version",
      version: "1.0.0",
      packageJson: { version: "2.0.0" },
    });
    await expectCode("versionMismatch", "VERSION_MISMATCH", () => loader.load(versionMismatch.request));
    const missingEntrypoint = await fixtureRequest(extensions, allowed, "missing-entrypoint", {
      identity: "@acceptance/missing-entrypoint",
      writeEntrypoint: false,
    });
    await expectCode("invalidEntrypoint", "INVALID_ENTRYPOINT", () => loader.load(missingEntrypoint.request));
    const format = await fixtureRequest(extensions, allowed, "format", {
      identity: "@acceptance/format",
      packageJson: { type: "module" },
    });
    await expectCode("unsupportedFormat", "UNSUPPORTED_MODULE_FORMAT", () => loader.load(format.request));
    const dependency = await fixtureRequest(extensions, allowed, "dependency", {
      identity: "@acceptance/dependency",
      source: `require("node:fs"); module.exports = { activate() { return {}; } };`,
    });
    await expectCode("unsupportedDependency", "UNSUPPORTED_MODULE_DEPENDENCY", () => loader.load(dependency.request));
    const shape = await fixtureRequest(extensions, allowed, "shape", {
      identity: "@acceptance/shape",
      source: `module.exports = {};`,
    });
    await expectCode("unsupportedShape", "UNSUPPORTED_MODULE_SHAPE", () => loader.load(shape.request));
    const loadFailure = await fixtureRequest(extensions, allowed, "load-failure", {
      identity: "@acceptance/load-failure",
      source: `throw new Error("module load failure");`,
    });
    await expectCode("moduleLoadFailure", "MODULE_LOAD_FAILED", () => loader.load(loadFailure.request));
    const invalidUtf8 = await fixtureRequest(extensions, allowed, "invalid-utf8", {
      identity: "@acceptance/invalid-utf8",
    });
    await writeFile(path.join(invalidUtf8.fixture.root, invalidUtf8.fixture.entrypoint), Buffer.from([0xff, 0xfe, 0xfd]));
    invalidUtf8.request.integrity = extensions.computeRuntimeExtensionIntegrity(invalidUtf8.fixture.root);
    await expectCode("invalidUtf8Entrypoint", "MODULE_LOAD_FAILED", () => loader.load(invalidUtf8.request));
    const extraManifestKey = await fixtureRequest(extensions, allowed, "manifest-extra-key", {
      identity: "@acceptance/manifest-extra-key",
      manifest: { unexpected: true },
    });
    await expectCode("manifestExtraKey", "INVALID_MANIFEST", () => loader.load(extraManifestKey.request));
    const oversizedManifest = await writeExtensionFixture(path.join(allowed, "manifest-oversized"), {
      identity: "@acceptance/manifest-oversized",
      manifestBytes: JSON.stringify({
        schemaVersion: 1,
        identity: "@acceptance/manifest-oversized",
        version: "1.0.0",
        entrypoint: "dist/index.cjs",
        moduleFormat: "commonjs-bundle-v1",
        padding: "x".repeat(70 * 1024),
      }),
    });
    await expectCode("manifestOversized", "INVALID_MANIFEST", () => loader.load({
      packageRoot: oversizedManifest.root,
      integrity: extensions.computeRuntimeExtensionIntegrity(oversizedManifest.root),
    }));
    for (const [name, entrypoint] of [
      ["unsafeEntrypoint", "../outside.cjs"],
      ["reservedEntrypoint", "CON.cjs"],
      ["nonCjsEntrypoint", "dist/index.js"],
    ]) {
      const fixture = await fixtureRequest(extensions, allowed, name, {
        identity: `@acceptance/${name.toLowerCase()}`,
        entrypoint,
        writeEntrypoint: false,
      });
      await expectCode(name, "INVALID_MANIFEST", () => loader.load(fixture.request));
    }
    const unsafeTree = await fixtureRequest(extensions, allowed, "unsafe-tree", {
      identity: "@acceptance/unsafe-tree",
    });
    const linkTarget = path.join(root, "unsafe-tree-target.txt");
    await writeFile(linkTarget, "outside");
    try {
      await symlink(linkTarget, path.join(unsafeTree.fixture.root, "linked.txt"), "file");
      await expectCode("unsafePackageTree", "UNSAFE_PACKAGE_TREE", () => loader.load({
        packageRoot: unsafeTree.fixture.root,
        integrity: { ...unsafeTree.request.integrity, value: "0".repeat(64) },
      }));
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        story.block("filesystem permits loader unsafe-tree link fixture", errorRecord(error));
      } else {
        throw error;
      }
    }
    await expectCode("cancelled", "CANCELLED", () => loader.load(valid.request, { aborted: true }));

    const fileLimit = await fixtureRequest(extensions, allowed, "file-limit", {
      identity: "@acceptance/file-limit",
    });
    for (let index = 0; index < 2_047; index += 1) {
      await writeFile(path.join(fileLimit.fixture.root, `finite-${String(index).padStart(4, "0")}.txt`), "");
    }
    await expectCode("fileCountLimit", "PACKAGE_LIMIT_EXCEEDED", () =>
      extensions.computeRuntimeExtensionIntegrity(fileLimit.fixture.root));
    await rm(fileLimit.fixture.root, { recursive: true, force: true });

    const largeFile = await fixtureRequest(extensions, allowed, "large-file", {
      identity: "@acceptance/large-file",
    });
    await addSparseFile(path.join(largeFile.fixture.root, "large.bin"), 32 * 1024 * 1024 + 1);
    await expectCode("singleFileLimit", "PACKAGE_LIMIT_EXCEEDED", () =>
      extensions.computeRuntimeExtensionIntegrity(largeFile.fixture.root));
    await rm(largeFile.fixture.root, { recursive: true, force: true });

    const treeLimit = await fixtureRequest(extensions, allowed, "tree-limit", {
      identity: "@acceptance/tree-limit",
    });
    for (let index = 0; index < 5; index += 1) {
      await addSparseFile(path.join(treeLimit.fixture.root, `tree-${index}.bin`), 32 * 1024 * 1024);
    }
    await expectCode("treeByteLimit", "PACKAGE_LIMIT_EXCEEDED", () =>
      extensions.computeRuntimeExtensionIntegrity(treeLimit.fixture.root));
    await rm(treeLimit.fixture.root, { recursive: true, force: true });

    story.result("matrix", matrix);
    for (const [name, item] of Object.entries(matrix)) {
      story.assert(`${name} returns ${item.expected}`, item.error?.code === item.expected, item.expected, item.error);
    }
  });
}

async function runRootSafety(run, core, extensions) {
  await runStory(run, "MRT-EXT-009", "NODE-INTEGRATION+STATIC", EXTENSION_STORY_DEFINITIONS[6][2], async (story) => {
    const root = path.join(run.fixtureRoot, "MRT-EXT-009");
    const allowed = path.join(root, "allowed");
    const outside = path.join(root, "outside");
    await mkdir(allowed, { recursive: true });
    await mkdir(outside, { recursive: true });
    story.root(root);
    const loader = new extensions.LocalRuntimeExtensionPackageLoader({ allowedRoots: [allowed] });
    const outsideFixture = await fixtureRequest(extensions, outside, "outside-package", {
      identity: "@acceptance/root-outside",
    });
    const outsideResult = await capture(() => loader.load(outsideFixture.request));
    const network = await fixtureRequest(extensions, allowed, "network", {
      identity: "@acceptance/network",
      source: `require("node:https"); module.exports = { activate() { return {}; } };`,
    });
    const networkResult = await capture(() => loader.load(network.request));
    const linkTarget = await fixtureRequest(extensions, allowed, "link-target", {
      identity: "@acceptance/link-target",
    });
    const outsideFile = path.join(outside, "outside.cjs");
    await writeFile(outsideFile, "module.exports = {};");
    let internalLinkResult;
    try {
      await symlink(outsideFile, path.join(linkTarget.fixture.root, "linked.cjs"), "file");
      internalLinkResult = await capture(() => loader.load({
        packageRoot: linkTarget.fixture.root,
        integrity: { ...linkTarget.request.integrity, value: "0".repeat(64) },
      }));
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        story.block("filesystem permits required file-link rejection fixture", errorRecord(error));
      } else {
        throw error;
      }
    }
    const junctionPath = path.join(allowed, "junction-package");
    let junctionResult;
    try {
      await symlink(outsideFixture.fixture.root, junctionPath, process.platform === "win32" ? "junction" : "dir");
      junctionResult = await capture(() => loader.load({
        packageRoot: junctionPath,
        integrity: outsideFixture.request.integrity,
      }));
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        story.block("filesystem permits required junction rejection fixture", errorRecord(error));
      } else {
        throw error;
      }
    }

    const mutable = await fixtureRequest(extensions, allowed, "mutable", {
      identity: "@acceptance/mutable",
    });
    await addSparseFile(path.join(mutable.fixture.root, "payload.bin"), 8 * 1024 * 1024);
    mutable.request.integrity = extensions.computeRuntimeExtensionIntegrity(mutable.fixture.root);
    const mutatorReady = path.join(root, "mutable-mutator-ready.txt");
    const mutatorSource = `
      const fs = require("node:fs");
      const file = process.argv[1];
      const ready = process.argv[2];
      const end = Date.now() + 3000;
      let signalled = false;
      while (Date.now() < end) {
        try {
          const handle = fs.openSync(file, "r+");
          fs.writeSync(handle, Buffer.from([255]), 0, 1, 0);
          fs.fsyncSync(handle);
          fs.closeSync(handle);
          if (!signalled) {
            fs.writeFileSync(ready, String(process.pid));
            signalled = true;
          }
        } catch {}
      }
    `;
    const mutator = spawn(process.execPath, [
      "-e",
      mutatorSource,
      path.join(mutable.fixture.root, "payload.bin"),
      mutatorReady,
    ], {
      windowsHide: true,
      stdio: "ignore",
    });
    story.child(mutator.pid);
    const readyDeadline = Date.now() + 2_000;
    while (!await pathExists(mutatorReady) && mutator.exitCode === null && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!await pathExists(mutatorReady)) throw new Error("Mutable package fixture did not start.");
    const mutableResult = await capture(() => loader.load(mutable.request));
    if (mutator.exitCode === null) mutator.kill("SIGTERM");
    if (mutator.exitCode === null) await new Promise((resolve) => mutator.once("exit", resolve));
    await unlink(mutatorReady).catch(() => undefined);
    await rm(mutable.fixture.root, { recursive: true, force: true });

    story.result("outsideRoot", outsideResult);
    story.result("networkDependency", networkResult);
    story.result("internalLink", internalLinkResult);
    story.result("junction", junctionResult);
    story.result("mutableRead", mutableResult);
    story.assert("outside package root is rejected", outsideResult.error?.code === "ROOT_NOT_ALLOWED", "ROOT_NOT_ALLOWED", outsideResult);
    story.assert("network-capable dependency is not resolved", networkResult.error?.code === "UNSUPPORTED_MODULE_DEPENDENCY", "UNSUPPORTED_MODULE_DEPENDENCY", networkResult);
    if (internalLinkResult) story.assert("internal link is rejected", internalLinkResult.error?.code === "UNSAFE_PACKAGE_TREE", "UNSAFE_PACKAGE_TREE", internalLinkResult);
    if (junctionResult) story.assert("junction package root is rejected", junctionResult.error?.code === "UNSAFE_PACKAGE_TREE", "UNSAFE_PACKAGE_TREE", junctionResult);
    story.assert("concurrent package mutation is rejected before execution", ["UNSAFE_PACKAGE_TREE", "INTEGRITY_MISMATCH"].includes(mutableResult.error?.code),
      "UNSAFE_PACKAGE_TREE or INTEGRITY_MISMATCH", mutableResult);
  });
}

async function runIntegrityResources(run, core, extensions) {
  await runStory(run, "MRT-EXT-013", "NODE-INTEGRATION", EXTENSION_STORY_DEFINITIONS[10][2], async (story) => {
    const context = invocationContext();
    const root = path.join(run.fixtureRoot, "MRT-EXT-013");
    await mkdir(root, { recursive: true });
    story.root(root);
    const fixture = await fixtureRequest(extensions, root, "stable", {
      identity: "@acceptance/stable",
      providerId: "acceptance.stable",
      capability: "acceptance.stable.echo",
      resourceUri: "resource://acceptance/stable",
      uiApplicationId: "dashboard",
      uiResourceUri: "ui://acceptance/stable/index.html",
    });
    const localOne = extensions.computeRuntimeExtensionIntegrity(fixture.fixture.root);
    const localTwo = extensions.computeRuntimeExtensionIntegrity(fixture.fixture.root);
    const worker = await launchWorker(run, run.workerPath, run.consumerRoot, "extension-integrity");
    story.child(worker.pid);
    const crossProcess = await worker.request("integrity.compute", { packageRoot: fixture.fixture.root });
    await worker.terminate();
    const { kernel, manager } = managerFor(core, extensions, root);
    await manager.install(fixture.request);
    const firstIds = (await kernel.search({
      protocolVersion: "1.0.0",
      query: "Acceptance",
      limit: 20,
    }, context)).discoveries?.map((item) => item.entry.id).sort() ?? [];
    const resources = (await manager.resources.listResources(context)).map((item) => item.uri);
    const missing = await capture(() => manager.resources.readResource("resource://acceptance/missing", context));
    await manager.remove("@acceptance/stable");
    await manager.install(fixture.request);
    const secondIds = (await kernel.search({
      protocolVersion: "1.0.0",
      query: "Acceptance",
      limit: 20,
    }, context)).discoveries?.map((item) => item.entry.id).sort() ?? [];

    Reflect.set(globalThis, "__acceptanceDuplicateResource", false);
    const dynamicOne = await fixtureRequest(extensions, root, "dynamic-one", {
      identity: "@acceptance/dynamic-one",
      source: `
module.exports = { activate() { return { resourceProviders: [{
  listResources() { return [{ uri: "resource://acceptance/dynamic", name: "One", mimeType: "text/plain" }]; },
  readResource(uri) { return { uri, mimeType: "text/plain", text: "one" }; }
}] }; } };`,
    });
    const dynamicTwo = await fixtureRequest(extensions, root, "dynamic-two", {
      identity: "@acceptance/dynamic-two",
      source: `
module.exports = { activate() { return { resourceProviders: [{
  listResources() { return [{ uri: globalThis.__acceptanceDuplicateResource
    ? "resource://acceptance/dynamic" : "resource://acceptance/dynamic-two",
    name: "Two", mimeType: "text/plain" }]; },
  readResource(uri) { return { uri, mimeType: "text/plain", text: "two" }; }
}] }; } };`,
    });
    await manager.install(dynamicOne.request);
    await manager.install(dynamicTwo.request);
    Reflect.set(globalThis, "__acceptanceDuplicateResource", true);
    const duplicateList = await capture(() => manager.resources.listResources(context));
    const duplicateRead = await capture(() => manager.resources.readResource("resource://acceptance/dynamic", context));
    story.result("integrity", { localOne, localTwo, crossProcess });
    story.result("stableIds", { firstIds, secondIds });
    story.result("resources", resources);
    story.result("missingResource", missing);
    story.result("duplicateList", duplicateList);
    story.result("duplicateRead", duplicateRead);
    story.assert("domain-separated SHA-256 is deterministic across calls and processes", localOne.value === localTwo.value
      && localOne.value === crossProcess.value && /^[a-f0-9]{64}$/.test(localOne.value)
      && localOne.domain === "marshal-runtime-extension-package-v1", true, { localOne, localTwo, crossProcess });
    story.assert("resource/UI catalog IDs are stable across reinstall", firstIds.length > 0 && firstIds.join(",") === secondIds.join(","), firstIds, secondIds);
    story.assert("stable catalog IDs use reviewed resource and UI formats", firstIds.some((item) =>
      /^catalog:\/\/runtime\.extension\.resource\.[a-f0-9]{24}\.\d+\//.test(item))
      && firstIds.some((item) => /^ui:\/\/runtime-extension\/[a-f0-9]{24}\/dashboard$/.test(item)),
    "reviewed stable ID patterns", firstIds);
    story.assert("resource inventory includes declared resource and UI content", resources.includes("resource://acceptance/stable")
      && resources.includes("ui://acceptance/stable/index.html"), true, resources);
    story.assert("missing resource code is exact", missing.error?.code === "RESOURCE_NOT_FOUND", "RESOURCE_NOT_FOUND", missing);
    story.assert("aggregate duplicate list code is exact", duplicateList.error?.code === "DUPLICATE_RESOURCE", "DUPLICATE_RESOURCE", duplicateList);
    story.assert("aggregate duplicate read code is exact", duplicateRead.error?.code === "DUPLICATE_RESOURCE", "DUPLICATE_RESOURCE", duplicateRead);
    Reflect.deleteProperty(globalThis, "__acceptanceDuplicateResource");
    await manager.dispose().catch(() => undefined);
  });
}
