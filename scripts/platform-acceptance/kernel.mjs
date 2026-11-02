import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  catalog,
  descriptor,
  invocationContext,
  provider,
  writeExtensionFixture,
} from "./extension-fixtures.mjs";
import { errorRecord, runCommand, runStory } from "./lib.mjs";

export const KERNEL_STORY_DEFINITIONS = [
  ["MRT-KRN-001", "NODE-INTEGRATION+STATIC", {}],
  ["MRT-KRN-002", "NODE-INTEGRATION", {}],
  ["MRT-KRN-003", "NODE-INTEGRATION", {}],
];

async function importPublic(consumerRoot, specifier) {
  const requireFromConsumer = createRequire(path.join(consumerRoot, "package.json"));
  return await import(pathToFileURL(requireFromConsumer.resolve(specifier)).href);
}

async function captureError(action) {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    return { ok: false, error: errorRecord(error) };
  }
}

export async function runKernelCampaign(run) {
  const core = await importPublic(run.consumerRoot, "@marshal/runtime/core");
  const extensions = await importPublic(run.consumerRoot, "@marshal/runtime/extensions");
  const context = invocationContext();

  await runStory(run, "MRT-KRN-001", "NODE-INTEGRATION+STATIC", {}, async (story) => {
    story.root(run.consumerRoot);
    story.action("Import @marshal/runtime/extensions from an isolated deployed consumer using ESM.");
    const esm = await runCommand(run, {
      id: "kernel-consumer-esm",
      category: "node-integration",
      program: process.execPath,
      args: [path.join(run.consumerRoot, "extensions-probe.mjs"), run.consumerFixtureRoot],
      cwd: run.consumerRoot,
    });
    story.action("Typecheck public extension imports from the isolated consumer.");
    const typecheck = await runCommand(run, {
      id: "kernel-consumer-typescript",
      category: "node-integration",
      program: "pnpm",
      args: ["exec", "tsc", "--noEmit", "-p", path.join(run.consumerRoot, "tsconfig.json")],
      cwd: run.platformSnapshot,
    });
    const probeOutput = esm.exitCode === 0
      ? JSON.parse((await readFile(path.join(run.runRoot, esm.stdoutArtifact), "utf8")).trim().split(/\r?\n/).at(-1))
      : null;
    const runtimeManifest = JSON.parse(await readFile(
      path.join(run.platformSnapshot, "packages", "runtime", "package.json"),
      "utf8",
    ));
    const boundaries = JSON.parse(await readFile(
      path.join(run.platformSnapshot, "runtime-boundaries.json"),
      "utf8",
    ));
    story.result("esmCommand", esm);
    story.result("typecheckCommand", typecheck);
    story.result("probe", probeOutput);
    story.result("runtimeManifest", runtimeManifest);
    story.result("runtimeBoundaries", boundaries);
    const requiredValues = [
      "RUNTIME_EXTENSION_MANIFEST_FILENAME",
      "RUNTIME_EXTENSION_MANIFEST_SCHEMA_VERSION",
      "RUNTIME_EXTENSION_MODULE_FORMAT",
      "RUNTIME_EXTENSION_INTEGRITY_DOMAIN",
      "RuntimeExtensionManager",
      "LocalRuntimeExtensionPackageLoader",
      "computeRuntimeExtensionIntegrity",
    ];
    story.assert("consumer ESM import succeeds", esm.exitCode === 0, 0, esm.exitCode);
    story.assert("consumer TypeScript import succeeds", typecheck.exitCode === 0, 0, typecheck.exitCode);
    story.assert("required runtime extension values are exported", requiredValues.every((name) =>
      probeOutput?.exportNames?.includes(name)), requiredValues, probeOutput?.exportNames);
    story.assert("stable extension constants match the contract", probeOutput?.constants?.manifestFilename === "runtime-extension.json"
      && probeOutput?.constants?.schemaVersion === 1
      && probeOutput?.constants?.moduleFormat === "commonjs-bundle-v1"
      && probeOutput?.constants?.integrityDomain === "marshal-runtime-extension-package-v1",
    "reviewed constants", probeOutput?.constants);
    story.assert("activation context exposes no kernel reference", probeOutput?.activationContextKeys?.join(",") === "execute,manifest,search,signal"
      && !probeOutput?.activationContextKeys?.includes("kernel"), ["execute", "manifest", "search", "signal"], probeOutput?.activationContextKeys);
    story.assert("runtime package exports the generic extension surface", Boolean(runtimeManifest.exports?.["./extensions"]),
    "extensions export", runtimeManifest.exports);
    story.assert("portable boundaries include agent-runtime-extensions", boundaries.portable?.includes("agent-runtime-extensions"), true, boundaries.portable);
  });

  await runStory(run, "MRT-KRN-002", "NODE-INTEGRATION", {}, async (story) => {
    story.action("Register, replace, stale-use, dispose, abort, and validation-fail real kernel ownership handles.");
    const lifecycle = [];
    const kernel = core.createRuntimeKernel({
      permissionBroker: core.createAllowAllPermissionBroker(),
    });
    kernel.observeLifecycle((event) => lifecycle.push(event));
    kernel.register(provider("unrelated.provider", "unrelated.echo", "unrelated"));
    const first = await kernel.registerContributions({
      providers: [provider("owned.provider", "owned.v1", "v1", "1.0.0")],
      catalogProviders: [catalog("owned.catalog", "resource://owned/v1", "Owned v1")],
    }, context);
    const afterRegister = {
      capabilities: (await kernel.list(context)).map((item) => `${item.provider.id}:${item.name}`),
      discoveries: (await kernel.search({
        protocolVersion: "1.0.0",
        query: "Owned",
      }, context)).discoveries?.map((item) => item.entry.id) ?? [],
    };
    const second = await first.replace({
      providers: [provider("owned.provider", "owned.v2", "v2", "2.0.0")],
      catalogProviders: [catalog("owned.catalog", "resource://owned/v2", "Owned v2")],
    }, context);
    const afterReplace = {
      capabilities: (await kernel.list(context)).map((item) => `${item.provider.id}:${item.name}`),
      discoveries: (await kernel.search({
        protocolVersion: "1.0.0",
        query: "Owned",
      }, context)).discoveries?.map((item) => item.entry.id) ?? [],
    };
    const staleReplace = await captureError(() => first.replace({
      providers: [provider("stale.provider", "stale.echo")],
    }, context));
    first.dispose();
    const afterStaleDispose = (await kernel.list(context)).map((item) => item.name);
    second.dispose();
    second.dispose();
    const afterDoubleDispose = (await kernel.list(context)).map((item) => item.name);
    const aborted = await captureError(() => kernel.registerContributions({
      providers: [provider("aborted.provider", "aborted.echo")],
    }, { ...context, signal: { aborted: true, reason: "acceptance pre-abort" } }));
    const validation = await captureError(() => kernel.registerContributions({
      providers: [provider("duplicate.provider", "unrelated.echo")],
    }, context));
    await new Promise((resolve) => setTimeout(resolve, 0));
    story.result("afterRegister", afterRegister);
    story.result("afterReplace", afterReplace);
    story.result("staleReplace", staleReplace);
    story.result("afterStaleDispose", afterStaleDispose);
    story.result("afterDoubleDispose", afterDoubleDispose);
    story.result("aborted", aborted);
    story.result("validation", validation);
    story.result("lifecycle", lifecycle);
    story.assert("initial ownership publishes provider and catalog atomically", afterRegister.capabilities.includes("owned.provider:owned.v1")
      && afterRegister.discoveries.includes("resource://owned/v1"), true, afterRegister);
    story.assert("replacement removes old and publishes complete new ownership", afterReplace.capabilities.includes("owned.provider:owned.v2")
      && !afterReplace.capabilities.some((item) => item.endsWith(":owned.v1"))
      && afterReplace.discoveries.includes("resource://owned/v2")
      && !afterReplace.discoveries.includes("resource://owned/v1"), true, afterReplace);
    story.assert("stale handle replace fails exactly", staleReplace.error?.message === "Runtime contribution registration is no longer active.",
      "Runtime contribution registration is no longer active.", staleReplace);
    story.assert("stale dispose cannot remove replacement", afterStaleDispose.includes("owned.v2"), true, afterStaleDispose);
    story.assert("double dispose is idempotent and preserves unrelated provider", afterDoubleDispose.join(",") === "unrelated.echo", ["unrelated.echo"], afterDoubleDispose);
    story.assert("pre-abort commits no provider", aborted.ok === false && !(await kernel.get("aborted.echo", context)), "cancelled/no mutation", aborted);
    story.assert("validation failure commits no provider", validation.ok === false && !(await kernel.get("duplicate.echo", context)), "failure/no mutation", validation);
    const eventIds = lifecycle
      .filter((event) => event.type === "runtime.provider.registered" || event.type === "runtime.provider.disposed")
      .map((event) => `${event.type}:${event.payload?.providerId}`);
    story.assert("lifecycle records stable owned provider IDs", eventIds.some((item) => item.endsWith(":owned.provider"))
      && eventIds.some((item) => item === "runtime.provider.disposed:owned.provider"), true, eventIds);
  });

  await runStory(run, "MRT-KRN-003", "NODE-INTEGRATION", {}, async (story) => {
    const root = path.join(run.fixtureRoot, "MRT-KRN-003");
    await mkdir(root, { recursive: true });
    story.root(root);
    story.action("Exercise real filesystem loader, VM activation, kernel registration, resources, cancellation, and disposal codes.");
    const kernel = core.createRuntimeKernel({
      permissionBroker: core.createAllowAllPermissionBroker(),
    });
    kernel.register(provider("reserved.provider", "reserved.echo", "reserved"));
    const loader = new extensions.LocalRuntimeExtensionPackageLoader({ allowedRoots: [root] });
    const manager = new extensions.RuntimeExtensionManager({
      kernel,
      loader,
      activationContext: context,
    });
    async function requestFor(name, options) {
      const fixture = await writeExtensionFixture(path.join(root, name), options);
      return {
        fixture,
        request: {
          packageRoot: fixture.root,
          integrity: extensions.computeRuntimeExtensionIntegrity(fixture.root),
        },
      };
    }
    const activationFailure = await requestFor("activation-failure", {
      identity: "@acceptance/activation-failure",
      source: `module.exports = { activate() { throw new Error("activation failure"); } };`,
    });
    const invalidShape = await requestFor("invalid-shape", {
      identity: "@acceptance/invalid-shape",
      source: `module.exports = { activate() { return { capabilityProviders: [null] }; } };`,
    });
    const registrationFailure = await requestFor("registration-failure", {
      identity: "@acceptance/registration-failure",
      providerId: "registration.failure",
      capability: "reserved.echo",
      disposeGlobal: "__krnRegistrationDisposed",
    });
    const cancelled = await requestFor("cancelled", {
      identity: "@acceptance/cancelled",
    });
    const resourceOne = await requestFor("resource-one", {
      identity: "@acceptance/resource-one",
      providerId: "resource.one",
      capability: "resource.one.echo",
      resourceUri: "resource://acceptance/duplicate",
    });
    const resourceDuplicate = await requestFor("resource-duplicate", {
      identity: "@acceptance/resource-duplicate",
      providerId: "resource.duplicate",
      capability: "resource.duplicate.echo",
      resourceUri: "resource://acceptance/duplicate",
      disposeGlobal: "__krnDuplicateResourceDisposed",
    });
    const disposalOne = await requestFor("disposal-one", {
      identity: "@acceptance/disposal-one",
      providerId: "disposal.one",
      capability: "disposal.one.echo",
      disposeThrows: true,
    });
    const disposalTwo = await requestFor("disposal-two", {
      identity: "@acceptance/disposal-two",
      providerId: "disposal.two",
      capability: "disposal.two.echo",
      disposeThrows: true,
    });
    const matrix = {
      activation: await captureError(() => manager.install(activationFailure.request)),
      invalid: await captureError(() => manager.install(invalidShape.request)),
      registration: await captureError(() => manager.install(registrationFailure.request)),
      cancellation: await captureError(() => manager.install(cancelled.request, {
        signal: { aborted: true, reason: "pre-aborted" },
      })),
    };
    await manager.install(resourceOne.request);
    matrix.resourceMissing = await captureError(() =>
      manager.resources.readResource("resource://acceptance/missing", context));
    matrix.resourceDuplicate = await captureError(() =>
      manager.install(resourceDuplicate.request));
    await manager.install(disposalOne.request);
    await manager.install(disposalTwo.request);
    matrix.disposal = await captureError(() => manager.dispose());
    matrix.postDispose = await captureError(() => manager.enable("@acceptance/disposal-one"));
    story.result("errorMatrix", matrix);
    story.result("registrationCleanupMarker", Reflect.get(globalThis, "__krnRegistrationDisposed"));
    story.result("duplicateResourceCleanupMarker", Reflect.get(globalThis, "__krnDuplicateResourceDisposed"));
    story.result("kernelInventory", (await kernel.list(context)).map((item) => item.name));
    story.assert("activation failure code is exact", matrix.activation.error?.code === "ACTIVATION_FAILED", "ACTIVATION_FAILED", matrix.activation);
    story.assert("invalid contribution code is exact", matrix.invalid.error?.code === "INVALID_CONTRIBUTIONS", "INVALID_CONTRIBUTIONS", matrix.invalid);
    story.assert("registration failure code is exact", matrix.registration.error?.code === "REGISTRATION_FAILED", "REGISTRATION_FAILED", matrix.registration);
    story.assert("cancelled manager operation code is exact", matrix.cancellation.error?.code === "CANCELLED", "CANCELLED", matrix.cancellation);
    story.assert("missing resource code is exact", matrix.resourceMissing.error?.code === "RESOURCE_NOT_FOUND", "RESOURCE_NOT_FOUND", matrix.resourceMissing);
    story.assert("duplicate resource code is exact", matrix.resourceDuplicate.error?.code === "DUPLICATE_RESOURCE", "DUPLICATE_RESOURCE", matrix.resourceDuplicate);
    story.assert("failed staged registration is disposed", Reflect.get(globalThis, "__krnRegistrationDisposed") === 1, 1, Reflect.get(globalThis, "__krnRegistrationDisposed"));
    story.assert("failed duplicate-resource activation is disposed", Reflect.get(globalThis, "__krnDuplicateResourceDisposed") === 1, 1, Reflect.get(globalThis, "__krnDuplicateResourceDisposed"));
    story.assert("manager disposal aggregates failures", matrix.disposal.error?.code === "DISPOSAL_FAILED"
      && matrix.disposal.error?.cause?.name === "AggregateError", "DISPOSAL_FAILED/AggregateError", matrix.disposal);
    story.assert("post-dispose mutations fail exactly", matrix.postDispose.error?.code === "MANAGER_DISPOSED", "MANAGER_DISPOSED", matrix.postDispose);
    story.assert("failed operations leave only unrelated kernel state", (await kernel.list(context)).map((item) => item.name).join(",") === "reserved.echo",
      ["reserved.echo"], (await kernel.list(context)).map((item) => item.name));
    Reflect.deleteProperty(globalThis, "__krnRegistrationDisposed");
    Reflect.deleteProperty(globalThis, "__krnDuplicateResourceDisposed");
  });
}
