import { mkdir, rm, truncate, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeExtensionFixture(root, options = {}) {
  await rm(root, { recursive: true, force: true });
  const entrypoint = options.entrypoint ?? "dist/index.cjs";
  await mkdir(root, { recursive: true });
  await mkdir(path.dirname(path.join(root, entrypoint)), { recursive: true });
  const identity = options.identity ?? "@acceptance/example";
  const version = options.version ?? "1.0.0";
  const manifest = {
    schemaVersion: 1,
    identity,
    version,
    entrypoint,
    moduleFormat: "commonjs-bundle-v1",
    ...(options.manifest ?? {}),
  };
  const packageJson = {
    name: identity,
    version,
    type: "commonjs",
    main: entrypoint,
    ...(options.packageJson ?? {}),
  };
  if (options.writeManifest !== false) {
    await writeFile(
      path.join(root, "runtime-extension.json"),
      options.manifestBytes ?? JSON.stringify(manifest),
    );
  }
  if (options.writePackage !== false) {
    await writeFile(
      path.join(root, "package.json"),
      options.packageBytes ?? JSON.stringify(packageJson),
    );
  }
  if (options.writeEntrypoint !== false && !entrypoint.startsWith("..")) {
    await writeFile(
      path.join(root, entrypoint),
      options.source ?? providerModuleSource(options),
      "utf8",
    );
  }
  return { root, identity, version, entrypoint, manifest, packageJson };
}

export function providerModuleSource(options = {}) {
  const providerId = options.providerId ?? "acceptance.provider";
  const capability = options.capability ?? "acceptance.echo";
  const value = options.value ?? "ok";
  const disposeBody = options.disposeGlobal
    ? `globalThis[${JSON.stringify(options.disposeGlobal)}] =
        (globalThis[${JSON.stringify(options.disposeGlobal)}] || 0) + 1;
       ${options.disposeThrows ? `throw new Error("dispose failure");` : ""}`
    : options.disposeThrows ? `throw new Error("dispose failure");` : "";
  const resources = options.resourceUri
    ? `resourceProviders: [{
        listResources() { return [{
          uri: ${JSON.stringify(options.resourceUri)},
          name: "Acceptance resource",
          description: "Acceptance resource.",
          mimeType: "text/plain"
        }]; },
        readResource(uri) {
          return { uri, mimeType: "text/plain", text: ${JSON.stringify(options.resourceText ?? "resource")} };
        }
      }],`
    : "";
  const ui = options.uiApplicationId
    ? `uiApplications: [{
        id: ${JSON.stringify(options.uiApplicationId)},
        title: "Acceptance application",
        description: "Acceptance UI application.",
        renderId: ${JSON.stringify(options.renderId ?? "acceptance-render")},
        resource: {
          uri: ${JSON.stringify(options.uiResourceUri ?? "ui://acceptance/index.html")},
          mimeType: "text/html",
          text: "<main>acceptance</main>"
        },
        application: {
          version: "1.0.0",
          presentationModes: ["inline"],
          actions: [],
          tools: []
        }
      }],`
    : "";
  return `
module.exports = {
  activate(context) {
    return {
      capabilityProviders: [{
        id: ${JSON.stringify(providerId)},
        version: context.manifest.version,
        list() {
          return [{
            protocolVersion: "1.0.0",
            name: ${JSON.stringify(capability)},
            version: context.manifest.version,
            description: "Acceptance extension capability.",
            tags: ["acceptance"],
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            outputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false
            }
          }];
        },
        invoke() { return { output: { value: ${JSON.stringify(value)} } }; }
      }],
      ${resources}
      ${ui}
      dispose() { ${disposeBody} }
    };
  }
};`;
}

export async function addSparseFile(file, size) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "");
  await truncate(file, size);
}

export function invocationContext() {
  return {
    principal: { id: "platform-acceptance", kind: "agent" },
    scope: { workspaceId: "workspace", projectId: "project", sessionId: "session" },
  };
}

export function descriptor(name, version = "1.0.0") {
  return {
    protocolVersion: "1.0.0",
    name,
    version,
    description: `Acceptance capability ${name}.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      additionalProperties: false,
    },
  };
}

export function provider(id, capability, value = id, version = "1.0.0") {
  return {
    id,
    version,
    list: async () => [descriptor(capability, version)],
    invoke: async () => ({ output: { value } }),
  };
}

export function catalog(id, entryId, title = entryId) {
  return {
    id,
    list: async () => [{
      id: entryId,
      kind: "resource",
      title,
      description: `Acceptance catalog entry ${entryId}.`,
      action: { type: "resource_read", uri: entryId },
    }],
  };
}
