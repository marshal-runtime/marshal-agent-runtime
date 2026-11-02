import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertDisjointPath,
  blockStories,
  captureProcess,
  errorRecord,
  inventoryTree,
  isSameOrInside,
  isoNow,
  pathExists,
  processTree,
  recordBug,
  runCommand,
  sanitizeName,
  sha256File,
  writeJson,
} from "./platform-acceptance/lib.mjs";
import {
  captureGitState,
  hashTextFile,
  materializeSnapshot,
} from "./platform-acceptance/snapshot.mjs";
import { deployPackedWorkspaceClosure } from "./platform-acceptance/deployment.mjs";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const platformWorktree = path.resolve(scriptRoot, "..");
const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";
const MAX_PNPM_SEED_FILES = 125_000;
const MAX_PNPM_SEED_BYTES = 25 * 1024 * 1024 * 1024;
const PACKAGE_MANAGER_CREDENTIAL_KEY =
  /^(?:NODE_AUTH_TOKEN|NPM_TOKEN|NPM_AUTH_TOKEN|YARN_NPM_AUTH_TOKEN)$/i;

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (![
      "--run-root",
      "--host-worktree",
      "--contract",
      "--session-id",
      "--pnpm-seed-store",
    ].includes(name)) {
      throw new Error(`Unknown platform acceptance argument ${name}.`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
    parsed[name.slice(2)] = value;
    index += 1;
  }
  return parsed;
}

function gitHead(worktree) {
  return execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function defaultRunRoot(commit) {
  const drive = path.parse(platformWorktree).root.replace(/[\\/:]+/g, "") || "root";
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const runId = `${drive}-${timestamp}-${commit.slice(0, 12)}`;
  return path.join(path.parse(platformWorktree).root, "TestResults", "marshal-runtime-live", runId);
}

function createCommandEnvironment(run, authoritativeRoots) {
  const env = { ...process.env };
  const removedLifecycleKeys = [];
  const removedPackageManagerConfigKeys = [];
  let removedCredentialKeyCount = 0;
  for (const key of Object.keys(env)) {
    if (/^(?:INIT_CWD|PNPM_SCRIPT_SRC_DIR|npm_(?:lifecycle|package)_)/i.test(key)) {
      removedLifecycleKeys.push(key);
      delete env[key];
      continue;
    }
    if (/^(?:npm|pnpm)_config_/i.test(key)) {
      removedPackageManagerConfigKeys.push(key);
      delete env[key];
      continue;
    }
    if (PACKAGE_MANAGER_CREDENTIAL_KEY.test(key)) {
      removedCredentialKeyCount += 1;
      delete env[key];
    }
  }
  const pathKeys = Object.keys(env).filter((key) => key.toLowerCase() === "path");
  const pathKey = pathKeys[0] ?? (process.platform === "win32" ? "Path" : "PATH");
  const pathEntries = pathKeys
    .flatMap((key) => String(env[key] ?? "").split(path.delimiter))
    .filter(Boolean);
  for (const key of pathKeys) delete env[key];
  const removedPathEntries = pathEntries.filter((entry) =>
    authoritativeRoots.some((root) => isSameOrInside(root, entry)));
  const retainedPathEntries = pathEntries.filter((entry) =>
    !removedPathEntries.includes(entry));
  env[pathKey] = [...new Set(retainedPathEntries)].join(path.delimiter);
  env.TEMP = run.temporaryRoot;
  env.TMP = run.temporaryRoot;
  env.CI = "true";
  env.INIT_CWD = run.platformSnapshot;
  env.NPM_CONFIG_ALWAYS_AUTH = "false";
  env.NPM_CONFIG_CACHE = run.npmCacheRoot;
  env.NPM_CONFIG_GLOBALCONFIG = run.npmGlobalConfigPath;
  env.NPM_CONFIG_REGISTRY = PUBLIC_NPM_REGISTRY;
  env.NPM_CONFIG_STORE_DIR = run.pnpmStoreRoot;
  env.NPM_CONFIG_USERCONFIG = run.npmUserConfigPath;
  return {
    env,
    evidence: {
      pathKey,
      ci: env.CI,
      retainedPathEntries: [...new Set(retainedPathEntries)],
      removedPathEntries: [...new Set(removedPathEntries)],
      removedLifecycleKeys: removedLifecycleKeys.sort(),
      removedPackageManagerConfigKeyCount: removedPackageManagerConfigKeys.length,
      removedCredentialKeyCount,
      credentialsForwarded: false,
      npmCacheRoot: run.npmCacheRoot,
      npmRegistry: env.NPM_CONFIG_REGISTRY,
      npmUserConfigPath: run.npmUserConfigPath,
      npmGlobalConfigPath: run.npmGlobalConfigPath,
      pnpmStoreRoot: run.pnpmStoreRoot,
    },
  };
}

function skippedCommand(id, reason) {
  return { id, skipped: true, exitCode: null, reason };
}

function countBy(items, key) {
  return items.reduce((counts, item) => {
    const value = item[key] ?? "unknown";
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

async function toolVersion(program, args = ["--version"]) {
  const executable = process.platform === "win32" && program === "pnpm" ? "pnpm.cmd" : program;
  const result = await captureProcess(executable, args, {
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable),
  });
  return {
    program,
    argv: args,
    exitCode: result.exitCode,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    ...(result.error ? { error: result.error } : {}),
  };
}

async function toolValue(program, args) {
  const executable = process.platform === "win32" && program === "pnpm" ? "pnpm.cmd" : program;
  const result = await captureProcess(executable, args, {
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable),
  });
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    throw new Error(`${program} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function toolValueInEnvironment(program, args, options) {
  const executable = process.platform === "win32" && ["npm", "pnpm"].includes(program)
    ? `${program}.cmd`
    : program;
  const result = await captureProcess(executable, args, {
    cwd: options.cwd,
    env: options.env,
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable),
  });
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    throw new Error(`${program} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function normalizeRegistry(value) {
  return `${value.trim().replace(/\/+$/, "")}/`;
}

async function hashFile(file, algorithms) {
  const hashes = new Map(algorithms.map((algorithm) => [algorithm, createHash(algorithm)]));
  for await (const chunk of createReadStream(file)) {
    for (const hash of hashes.values()) hash.update(chunk);
  }
  return Object.fromEntries(
    [...hashes].map(([algorithm, hash]) => [algorithm, hash.digest("hex")]),
  );
}

async function fileIdentity(file) {
  const metadata = await stat(file, { bigint: true });
  return {
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    linkCount: metadata.nlink.toString(),
    size: Number(metadata.size),
    modifiedAtNs: metadata.mtimeNs.toString(),
  };
}

async function seedPnpmStore(sourceStore, targetStoreRoot) {
  const configuredSourceStore = sourceStore;
  const configuredTargetStoreRoot = targetStoreRoot;
  const source = path.resolve(sourceStore);
  const target = path.join(targetStoreRoot, path.basename(source));
  if (isSameOrInside(source, target) || isSameOrInside(target, source)) {
    throw new Error("pnpm seed store must differ from the run-local target store.");
  }
  await Promise.all([
    access(path.join(source, "index")),
    access(path.join(source, "files")),
  ]);
  await mkdir(target, { recursive: true });
  const [sourceRealPath, targetRealPath] = await Promise.all([
    realpath(source),
    realpath(target),
  ]);
  if (isSameOrInside(sourceRealPath, targetRealPath)
    || isSameOrInside(targetRealPath, sourceRealPath)) {
    throw new Error("pnpm seed store resolves into the run-local target store.");
  }

  const pending = [
    path.join(source, "files"),
    path.join(source, "index"),
  ];
  const sourceFiles = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile()) {
        sourceFiles.push(candidate);
        if (sourceFiles.length > MAX_PNPM_SEED_FILES) {
          throw new Error(
            `pnpm seed store exceeds the ${MAX_PNPM_SEED_FILES} file limit.`,
          );
        }
      } else {
        throw new Error(`pnpm seed store contains an unsupported entry: ${candidate}`);
      }
    }
  }
  sourceFiles.sort((left, right) => left.localeCompare(right));

  let totalBytes = 0;
  let copiedContentFiles = 0;
  let copiedMetadataFiles = 0;
  let contentIntegrityFileCount = 0;
  const manifestEntries = [];
  const indexEntries = [];
  for (const sourceFile of sourceFiles) {
    const relative = path.relative(source, sourceFile);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`pnpm seed file escapes the source store: ${sourceFile}`);
    }
    const sourceMetadata = await stat(sourceFile);
    totalBytes += sourceMetadata.size;
    if (totalBytes > MAX_PNPM_SEED_BYTES) {
      throw new Error(
        `pnpm seed store exceeds the ${MAX_PNPM_SEED_BYTES} byte limit.`,
      );
    }

    const targetFile = path.join(target, relative);
    await mkdir(path.dirname(targetFile), { recursive: true });
    await copyFile(sourceFile, targetFile);
    const isContentFile = relative.startsWith(`files${path.sep}`);
    const [sourceHashes, targetHashes, sourceIdentity, targetIdentity] = await Promise.all([
      hashFile(sourceFile, isContentFile ? ["sha256", "sha512"] : ["sha256"]),
      hashFile(targetFile, ["sha256"]),
      fileIdentity(sourceFile),
      fileIdentity(targetFile),
    ]);
    if (sourceHashes.sha256 !== targetHashes.sha256) {
      throw new Error(`pnpm seed copy verification failed: ${relative}`);
    }
    if (sourceIdentity.device === targetIdentity.device
      && sourceIdentity.inode === targetIdentity.inode) {
      throw new Error(`pnpm seed file shares mutable identity with its source: ${relative}`);
    }
    if (isContentFile) {
      const digest = `${path.basename(path.dirname(relative))}${
        path.basename(relative).replace(/-exec$/, "")
      }`;
      if (sourceHashes.sha512 !== digest) {
        throw new Error(`pnpm content integrity verification failed: ${relative}`);
      }
      copiedContentFiles += 1;
      contentIntegrityFileCount += 1;
    } else {
      copiedMetadataFiles += 1;
    }

    const targetMetadata = await stat(targetFile);
    if (targetMetadata.size !== sourceMetadata.size) {
      throw new Error(`pnpm seed size verification failed: ${relative}`);
    }
    manifestEntries.push(
      `${relative.replaceAll("\\", "/")}\0${sourceMetadata.size}\0${targetHashes.sha256}`,
    );

    if (relative.startsWith(`index${path.sep}`)) {
      const index = JSON.parse(await readFile(targetFile, "utf8"));
      for (const [fileName, descriptor] of Object.entries(index.files ?? {})) {
        const [algorithm, encoded] = (descriptor.integrity ?? "").split("-", 2);
        if (algorithm !== "sha512" || !encoded) {
          throw new Error(`Unsupported pnpm integrity in ${relative}:${fileName}`);
        }
        const digest = Buffer.from(encoded, "base64").toString("hex");
        const executable = (Number(descriptor.mode) & 0o111) !== 0;
        await access(path.join(
          target,
          "files",
          digest.slice(0, 2),
          `${digest.slice(2)}${executable ? "-exec" : ""}`,
        ));
      }
      indexEntries.push(`${relative.replaceAll("\\", "/")}\0${targetHashes.sha256}`);
    }
  }

  manifestEntries.sort();
  indexEntries.sort();
  return {
    strategy: "offline-pnpm-store-copy-v1",
    configuredSourceStore,
    sourceStore: source,
    sourceRealPath,
    sourceIdentity: await fileIdentity(source),
    configuredTargetStoreRoot,
    targetStore: target,
    targetRealPath,
    targetIdentity: await fileIdentity(target),
    fileCount: sourceFiles.length,
    totalBytes,
    hardlinkedContentFiles: 0,
    copiedContentFiles,
    copiedMetadataFiles,
    sharedFileIdentityCount: 0,
    contentIntegrityFileCount,
    indexFileCount: indexEntries.length,
    manifestSha256: createHash("sha256").update(manifestEntries.join("\n")).digest("hex"),
    sourceManifestSha256: createHash("sha256").update(manifestEntries.join("\n")).digest("hex"),
    targetManifestSha256: createHash("sha256").update(manifestEntries.join("\n")).digest("hex"),
    indexManifestSha256: createHash("sha256").update(indexEntries.join("\n")).digest("hex"),
    limits: {
      files: MAX_PNPM_SEED_FILES,
      bytes: MAX_PNPM_SEED_BYTES,
    },
    verified: true,
  };
}

async function loadSnapshotCampaigns(platformSnapshot, authoritativeRoots) {
  const files = {
    typescript: path.join(platformSnapshot, "scripts", "platform-acceptance", "typescript.mjs"),
    extensions: path.join(platformSnapshot, "scripts", "platform-acceptance", "extensions.mjs"),
    kernel: path.join(platformSnapshot, "scripts", "platform-acceptance", "kernel.mjs"),
    pui: path.join(platformSnapshot, "scripts", "platform-acceptance", "pui.mjs"),
    legacy: path.join(platformSnapshot, "scripts", "platform-acceptance", "legacy.mjs"),
    workerClient: path.join(platformSnapshot, "scripts", "platform-acceptance", "worker-client.mjs"),
    processWorker: path.join(platformSnapshot, "scripts", "platform-acceptance", "process-worker.mjs"),
    library: path.join(platformSnapshot, "scripts", "platform-acceptance", "lib.mjs"),
  };
  const evidence = {};
  for (const [name, file] of Object.entries(files)) {
    const realPath = await realpath(file);
    if (!isSameOrInside(platformSnapshot, realPath)
      || authoritativeRoots.some((root) => isSameOrInside(root, realPath))) {
      throw new Error(`Snapshot campaign module escaped the snapshot: ${file} -> ${realPath}`);
    }
    evidence[name] = {
      configuredPath: file,
      resolvedPath: path.resolve(file),
      realPath,
      sha256: await sha256File(realPath),
    };
  }
  const [
    typescript,
    extensions,
    kernel,
    pui,
    legacy,
    workerClient,
  ] = await Promise.all([
    import(pathToFileURL(files.typescript).href),
    import(pathToFileURL(files.extensions).href),
    import(pathToFileURL(files.kernel).href),
    import(pathToFileURL(files.pui).href),
    import(pathToFileURL(files.legacy).href),
    import(pathToFileURL(files.workerClient).href),
  ]);
  return {
    TYPESCRIPT_STORY_DEFINITIONS: typescript.TYPESCRIPT_STORY_DEFINITIONS,
    runTypeScriptCampaign: typescript.runTypeScriptCampaign,
    EXTENSION_STORY_DEFINITIONS: extensions.EXTENSION_STORY_DEFINITIONS,
    runExtensionCampaign: extensions.runExtensionCampaign,
    KERNEL_STORY_DEFINITIONS: kernel.KERNEL_STORY_DEFINITIONS,
    runKernelCampaign: kernel.runKernelCampaign,
    PUI_STORY_DEFINITIONS: pui.PUI_STORY_DEFINITIONS,
    runPuiCampaign: pui.runPuiCampaign,
    LEGACY_STORY_DEFINITIONS: legacy.LEGACY_STORY_DEFINITIONS,
    runLegacyCampaign: legacy.runLegacyCampaign,
    terminateTrackedWorkers: workerClient.terminateTrackedWorkers,
    evidence: {
      verified: true,
      modules: evidence,
    },
  };
}

async function captureDependencyTopology(run) {
  const modulesMetadataPath = path.join(run.platformSnapshot, "node_modules", ".modules.yaml");
  const modulesMetadata = JSON.parse(await readFile(modulesMetadataPath, "utf8"));
  const workspaceEntries = await readdir(path.join(run.platformSnapshot, "packages"), {
    withFileTypes: true,
  });
  const roots = [
    { label: "workspace-root", path: path.join(run.platformSnapshot, "node_modules") },
    ...workspaceEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        label: `package:${entry.name}`,
        path: path.join(run.platformSnapshot, "packages", entry.name, "node_modules"),
      })),
  ];
  const links = [];
  async function inspectEntry(linkRoot, entryPath, label) {
    const metadata = await lstat(entryPath);
    if (!metadata.isSymbolicLink()) return false;
    const realPath = await realpath(entryPath);
    links.push({
      label,
      linkRoot,
      path: entryPath,
      resolvedPath: path.resolve(entryPath),
      realPath,
      insideSnapshot: isSameOrInside(run.platformSnapshot, realPath),
      insideRunRoot: isSameOrInside(run.runRoot, realPath),
      authoritativeRoot: [run.platformWorktree, run.hostWorktree]
        .find((root) => isSameOrInside(root, realPath)) ?? null,
    });
    return true;
  }
  for (const root of roots) {
    if (!await pathExists(root.path)) continue;
    if (await inspectEntry(root.path, root.path, root.label)) continue;
    for (const entry of await readdir(root.path, { withFileTypes: true })) {
      const entryPath = path.join(root.path, entry.name);
      if (await inspectEntry(root.path, entryPath, `${root.label}:${entry.name}`)) continue;
      if (!entry.isDirectory() || !entry.name.startsWith("@")) continue;
      for (const scopedEntry of await readdir(entryPath, { withFileTypes: true })) {
        await inspectEntry(
          root.path,
          path.join(entryPath, scopedEntry.name),
          `${root.label}:${entry.name}/${scopedEntry.name}`,
        );
      }
    }
  }
  const authoritativeLinks = links.filter((entry) => entry.authoritativeRoot);
  const storeDir = path.resolve(modulesMetadata.storeDir);
  const virtualStoreDir = path.resolve(modulesMetadata.virtualStoreDir);
  const verified = authoritativeLinks.length === 0
    && isSameOrInside(run.pnpmStoreRoot, storeDir)
    && isSameOrInside(run.platformSnapshot, virtualStoreDir);
  if (!verified) {
    throw new Error(`Snapshot dependency topology escaped confinement: ${
      JSON.stringify({ authoritativeLinks, storeDir, virtualStoreDir })
    }`);
  }
  return {
    verified,
    modulesMetadata: {
      path: modulesMetadataPath,
      resolvedPath: path.resolve(modulesMetadataPath),
      realPath: await realpath(modulesMetadataPath),
      sha256: await sha256File(modulesMetadataPath),
      packageManager: modulesMetadata.packageManager,
      storeDir,
      virtualStoreDir,
    },
    inspectedRoots: roots.map((entry) => entry.path),
    linkCount: links.length,
    links,
  };
}

async function writeModuleOriginProbe(run) {
  const probePath = path.join(run.temporaryRoot, "module-origin-probe.mjs");
  await writeFile(probePath, `
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const request = JSON.parse(process.argv[2]);
const requireFromConsumer = createRequire(path.join(request.consumerRoot, "package.json"));
const origins = [];
for (const specifier of request.consumerSpecifiers) {
  const resolvedPath = requireFromConsumer.resolve(specifier);
  await import(pathToFileURL(resolvedPath).href);
  const realPath = await realpath(resolvedPath);
  origins.push({
    kind: "consumer",
    id: specifier,
    configuredPath: specifier,
    resolvedPath,
    realPath,
    sha256: createHash("sha256").update(await readFile(realPath)).digest("hex"),
  });
}
for (const entry of request.exactFiles) {
  await import(pathToFileURL(entry.path).href);
  const realPath = await realpath(entry.path);
  origins.push({
    kind: "snapshot-dist",
    id: entry.id,
    configuredPath: entry.path,
    resolvedPath: path.resolve(entry.path),
    realPath,
    sha256: createHash("sha256").update(await readFile(realPath)).digest("hex"),
  });
}
console.log(JSON.stringify({ pid: process.pid, origins }));
`, "utf8");
  return probePath;
}

async function captureModuleOrigins(run) {
  const probePath = await writeModuleOriginProbe(run);
  const exactFiles = Object.entries(run.packageBuildIdentity.hashes)
    .filter(([, entry]) => entry.path && entry.sha256 && !entry.path.endsWith(".d.ts"))
    .map(([id, entry]) => ({ id, path: entry.path, expectedSha256: entry.sha256 }));
  const request = {
    consumerRoot: run.consumerRoot,
    consumerSpecifiers: [
      "@marshal/runtime",
      "@marshal/runtime/core",
      "@marshal/runtime/extensions",
      "@marshal/runtime/ui",
    ],
    exactFiles,
  };
  const command = await runCommand(run, {
    id: "verify-module-origins",
    category: "harness-confinement",
    program: process.execPath,
    args: [probePath, JSON.stringify(request)],
    cwd: run.consumerRoot,
    failureClassification: "harness",
  });
  if (command.exitCode !== 0) {
    return { verified: false, commandId: command.id, origins: [] };
  }
  const stdout = await readFile(path.join(run.runRoot, command.stdoutArtifact), "utf8");
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  const expectedHashes = new Map(exactFiles.map((entry) => [entry.id, entry.expectedSha256]));
  const violations = [];
  for (const origin of result.origins) {
    const expectedRoot = origin.kind === "consumer" ? run.consumerRoot : run.platformSnapshot;
    if (!isSameOrInside(expectedRoot, origin.realPath)) {
      violations.push({ ...origin, violation: `outside ${expectedRoot}` });
    }
    if ([run.platformWorktree, run.hostWorktree]
      .some((root) => isSameOrInside(root, origin.realPath))) {
      violations.push({ ...origin, violation: "inside authoritative worktree" });
    }
    if (!origin.realPath.split(/[\\/]/).includes("dist")) {
      violations.push({ ...origin, violation: "not a built dist entrypoint" });
    }
    const expectedHash = expectedHashes.get(origin.id);
    if (expectedHash && expectedHash !== origin.sha256) {
      violations.push({ ...origin, violation: `hash mismatch; expected ${expectedHash}` });
    }
  }
  const verified = result.origins.length
    === request.consumerSpecifiers.length + request.exactFiles.length
    && violations.length === 0;
  if (!verified) {
    await recordBug(run, {
      id: "BUG-HARNESS-MODULE-ORIGIN",
      kind: "harness-confinement",
      classification: "harness",
      status: "OPEN",
      summary: "Built package module origins escaped the external snapshot or consumer.",
      details: { result, violations },
      artifacts: [command.stdoutArtifact, command.stderrArtifact],
    });
  }
  return {
    verified,
    commandId: command.id,
    probePid: result.pid,
    probePath,
    origins: result.origins,
    violations,
  };
}

async function prepareConsumer(run) {
  await rm(run.consumerRoot, { recursive: true, force: true });
  await mkdir(run.consumerRoot, { recursive: true });
  await writeFile(path.join(run.consumerRoot, "package.json"), `${JSON.stringify({
    name: "marshal-runtime-platform-acceptance-consumer",
    private: true,
    type: "module",
  }, null, 2)}\n`);
  await writeFile(path.join(run.consumerRoot, "extensions-probe.mjs"), `
import * as extensions from "@marshal/runtime/extensions";
import { createAllowAllPermissionBroker, createRuntimeKernel } from "@marshal/runtime/core";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const fixtureRoot = process.argv[2];
await mkdir(fixtureRoot, { recursive: true });
const packageRoot = path.join(fixtureRoot, "package");
await mkdir(packageRoot, { recursive: true });
await writeFile(path.join(packageRoot, "runtime-extension.json"), JSON.stringify({
  schemaVersion: 1,
  identity: "@acceptance/consumer-probe",
  version: "1.0.0",
  entrypoint: "index.cjs",
  moduleFormat: "commonjs-bundle-v1"
}));
await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
  name: "@acceptance/consumer-probe",
  version: "1.0.0",
  type: "commonjs",
  main: "index.cjs"
}));
await writeFile(path.join(packageRoot, "index.cjs"),
  'module.exports = { activate(context) { globalThis.__consumerProbeContextKeys = Object.keys(context).sort(); return {}; } };');
const loader = new extensions.LocalRuntimeExtensionPackageLoader({ allowedRoots: [fixtureRoot] });
const integrity = extensions.computeRuntimeExtensionIntegrity(packageRoot);
const activationContext = {
  principal: { id: "consumer-probe", kind: "agent" },
  scope: { workspaceId: "workspace" }
};
const kernel = createRuntimeKernel({ permissionBroker: createAllowAllPermissionBroker() });
const manager = new extensions.RuntimeExtensionManager({
  kernel,
  activationContext,
  loader
});
await manager.install({ packageRoot, integrity });
const activationContextKeys = globalThis.__consumerProbeContextKeys;
await manager.dispose();
delete globalThis.__consumerProbeContextKeys;
console.log(JSON.stringify({
  exportNames: Object.keys(extensions).sort(),
  constants: {
    manifestFilename: extensions.RUNTIME_EXTENSION_MANIFEST_FILENAME,
    schemaVersion: extensions.RUNTIME_EXTENSION_MANIFEST_SCHEMA_VERSION,
    moduleFormat: extensions.RUNTIME_EXTENSION_MODULE_FORMAT,
    integrityDomain: extensions.RUNTIME_EXTENSION_INTEGRITY_DOMAIN
  },
  activationContextKeys,
  constructed: {
    loader: loader.constructor.name,
    manager: manager.constructor.name
  }
}));
`, "utf8");
  await writeFile(path.join(run.consumerRoot, "extensions-probe.ts"), `
import {
  LocalRuntimeExtensionPackageLoader,
  RuntimeExtensionManager,
  computeRuntimeExtensionIntegrity,
  type RuntimeExtensionActivationContext,
  type RuntimeExtensionInstallRequest,
  type RuntimeExtensionRecord,
  type RuntimeExtensionUiApplication,
} from "@marshal/runtime/extensions";
import {
  createAllowAllPermissionBroker,
  createRuntimeKernel,
  type InvocationContext,
} from "@marshal/runtime/core";

declare const activationContext: RuntimeExtensionActivationContext;
declare const request: RuntimeExtensionInstallRequest;
declare const record: RuntimeExtensionRecord;
declare const application: RuntimeExtensionUiApplication;
const context: InvocationContext = {
  principal: { id: "consumer", kind: "agent" },
  scope: { workspaceId: "workspace" },
};
const loader = new LocalRuntimeExtensionPackageLoader({ allowedRoots: ["."] });
const manager = new RuntimeExtensionManager({
  kernel: createRuntimeKernel({ permissionBroker: createAllowAllPermissionBroker() }),
  loader,
  activationContext: context,
});
void activationContext.manifest;
void activationContext.signal;
void activationContext.search;
void activationContext.execute;
// @ts-expect-error The public activation context intentionally exposes no kernel reference.
void activationContext.kernel;
void request;
void record;
void application;
void manager;
void computeRuntimeExtensionIntegrity;
`, "utf8");
  await writeFile(path.join(run.consumerRoot, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ["extensions-probe.ts"],
  }, null, 2)}\n`);
}

async function buildIdentity(run) {
  const files = [
    ["runtimeExtensions", path.join(run.platformSnapshot, "packages", "runtime", "dist", "extensions.js")],
    ["runtimeExtensionsTypes", path.join(run.platformSnapshot, "packages", "runtime", "dist", "extensions.d.ts")],
    ["core", path.join(run.platformSnapshot, "packages", "agent-runtime-core", "dist", "index.js")],
    ["extensions", path.join(run.platformSnapshot, "packages", "agent-runtime-extensions", "dist", "index.js")],
    ["typescript", path.join(run.platformSnapshot, "packages", "agent-runtime-typescript", "dist", "index.js")],
    ["ui", path.join(run.platformSnapshot, "packages", "agent-runtime-ui", "dist", "index.js")],
  ];
  const hashes = {};
  for (const [name, file] of files) {
    try {
      hashes[name] = { path: file, size: (await stat(file)).size, sha256: await sha256File(file) };
    } catch (error) {
      hashes[name] = { path: file, error: errorRecord(error) };
    }
  }
  return {
    platformHead: run.platformBefore.head,
    platformSnapshot: run.platformSnapshot,
    packageVersion: JSON.parse(await readFile(
      path.join(run.platformSnapshot, "packages", "runtime", "package.json"),
      "utf8",
    )).version,
    hashes,
  };
}

async function writeFinalHashes(run) {
  const exclusions = [
    path.join("snapshots", "platform", "node_modules"),
    "npm-cache",
    "pnpm-store",
  ];
  const inventory = await inventoryTree(run.runRoot, {
    exclude: exclusions,
  });
  const hashes = inventory.entries
    .filter((item) => item.type === "file" && item.path !== "hashes.json")
    .map((item) => ({ path: item.path, size: item.size, sha256: item.sha256 }));
  await writeJson(path.join(run.runRoot, "hashes.json"), {
    generatedAt: isoNow(),
    algorithm: "sha256",
    exclusions,
    files: hashes,
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const platformHead = gitHead(platformWorktree);
  const hostWorktree = path.resolve(
    options["host-worktree"] ?? "Q:\\m-worktrees\\runtime-host-rebuild-20260814",
  );
  const contract = path.resolve(
    options.contract ?? path.join(hostWorktree, "docs", "validation", "marshal-runtime-live-user-stories.md"),
  );
  const pnpmSeedStore = options["pnpm-seed-store"]
    ? path.resolve(options["pnpm-seed-store"])
    : null;
  const runRoot = path.resolve(options["run-root"] ?? defaultRunRoot(platformHead));
  const sessionId = options["session-id"] ?? path.basename(runRoot);
  assertDisjointPath(runRoot, [platformWorktree, hostWorktree], "Run root");
  const platformSnapshot = path.join(runRoot, "snapshots", "platform");
  assertDisjointPath(platformSnapshot, [platformWorktree, hostWorktree], "Platform snapshot");
  await mkdir(path.dirname(runRoot), { recursive: true });
  await mkdir(runRoot, { recursive: false });

  const run = {
    runRoot,
    sessionId,
    platformWorktree,
    hostWorktree,
    contract,
    platformSnapshot,
    fixtureRoot: path.join(runRoot, "fixtures", "roots"),
    consumerRoot: path.join(runRoot, "consumer"),
    consumerFixtureRoot: path.join(runRoot, "fixtures", "consumer-probe"),
    archiveRoot: path.join(runRoot, "package-archives"),
    temporaryRoot: path.join(runRoot, "temp"),
    npmCacheRoot: path.join(runRoot, "npm-cache"),
    pnpmStoreRoot: path.join(runRoot, "pnpm-store"),
    packageManagerConfigRoot: path.join(runRoot, "package-manager-config"),
    npmUserConfigPath: path.join(runRoot, "package-manager-config", "user.npmrc"),
    npmGlobalConfigPath: path.join(runRoot, "package-manager-config", "global.npmrc"),
    workerPath: path.join(platformSnapshot, "scripts", "platform-acceptance", "process-worker.mjs"),
    commandTranscriptPath: path.join(runRoot, "command-transcript.jsonl"),
    processTranscriptPath: path.join(runRoot, "process-transcript.jsonl"),
    bugLedgerJsonlPath: path.join(runRoot, "bug-ledger.jsonl"),
    commands: [],
    stories: [],
    bugs: [],
    runtimeArchive: null,
    consumerReady: false,
    deploymentEvidence: null,
    pnpmSeedStore,
  };
  await Promise.all([
    mkdir(run.fixtureRoot, { recursive: true }),
    mkdir(run.archiveRoot, { recursive: true }),
    mkdir(run.temporaryRoot, { recursive: true }),
    mkdir(run.npmCacheRoot, { recursive: true }),
    mkdir(run.pnpmStoreRoot, { recursive: true }),
    mkdir(run.packageManagerConfigRoot, { recursive: true }),
    mkdir(path.join(runRoot, "stories"), { recursive: true }),
    mkdir(path.join(runRoot, "command-transcripts"), { recursive: true }),
    writeFile(run.bugLedgerJsonlPath, "", "utf8"),
  ]);
  const isolatedNpmConfig = `registry=${PUBLIC_NPM_REGISTRY}\nalways-auth=false\n`;
  await Promise.all([
    writeFile(run.npmUserConfigPath, isolatedNpmConfig, "utf8"),
    writeFile(run.npmGlobalConfigPath, isolatedNpmConfig, "utf8"),
  ]);
  process.env.TEMP = run.temporaryRoot;
  process.env.TMP = run.temporaryRoot;

  const startedAt = isoNow();
  const [
    nodeVersion,
    pnpmVersion,
    gitVersion,
    inheritedPnpmRegistry,
    globalPnpmStore,
    platformBefore,
    hostBefore,
  ] = await Promise.all([
    toolVersion(process.execPath),
    toolVersion("pnpm"),
    toolVersion("git"),
    toolValue("pnpm", ["config", "get", "registry"]),
    toolValue("pnpm", ["store", "path"]),
    captureGitState(platformWorktree, "platform", runRoot, "before"),
    captureGitState(hostWorktree, "host", runRoot, "before"),
  ]);
  const commandEnvironment = createCommandEnvironment(
    run,
    [platformWorktree, hostWorktree],
  );
  run.commandEnvironment = commandEnvironment.env;
  run.platformBefore = platformBefore;
  run.hostBefore = hostBefore;
  const contractHash = await hashTextFile(contract);
  const hostManifest = JSON.parse(await readFile(path.join(hostWorktree, "package.json"), "utf8"));
  await writeFile(path.join(runRoot, "dirty-files.txt"), [
    "[platform]",
    platformBefore.status.trimEnd(),
    "",
    "[host]",
    hostBefore.status.trimEnd(),
    "",
  ].join("\n"), "utf8");

  const snapshot = await materializeSnapshot(platformWorktree, platformSnapshot, platformBefore);
  run.snapshot = snapshot;
  await prepareConsumer(run);
  const campaigns = await loadSnapshotCampaigns(
    platformSnapshot,
    [platformWorktree, hostWorktree],
  );
  run.campaignModuleEvidence = campaigns.evidence;
  const [effectivePnpmRegistry, effectiveNpmRegistry] = await Promise.all([
    toolValueInEnvironment("pnpm", ["config", "get", "registry"], {
      cwd: platformSnapshot,
      env: run.commandEnvironment,
    }),
    toolValueInEnvironment("npm", ["config", "get", "registry"], {
      cwd: platformSnapshot,
      env: run.commandEnvironment,
    }),
  ]);
  for (const [manager, registry] of [
    ["pnpm", effectivePnpmRegistry],
    ["npm", effectiveNpmRegistry],
  ]) {
    if (normalizeRegistry(registry) !== PUBLIC_NPM_REGISTRY) {
      throw new Error(`${manager} registry isolation failed: expected ${PUBLIC_NPM_REGISTRY}, received ${registry}`);
    }
  }
  const selectedPnpmSeedStore = pnpmSeedStore ?? path.resolve(globalPnpmStore);
  run.pnpmSeedStore = selectedPnpmSeedStore;
  run.pnpmSeedEvidence = await seedPnpmStore(selectedPnpmSeedStore, run.pnpmStoreRoot);
  run.pnpmSeedEvidence.selection = pnpmSeedStore
    ? "explicit --pnpm-seed-store"
    : "configured pnpm store";
  await writeJson(path.join(runRoot, "process-tree-before.json"), await processTree());
  await writeJson(path.join(runRoot, "filesystem-before.json"), {
    capturedAt: isoNow(),
    fixtures: await inventoryTree(run.fixtureRoot),
    consumer: await inventoryTree(run.consumerRoot),
    archives: await inventoryTree(run.archiveRoot),
  });
  await writeJson(path.join(runRoot, "environment.json"), {
    capturedAt: isoNow(),
    sessionId,
    os: process.platform,
    osRelease: os.release(),
    architecture: process.arch,
    node: nodeVersion,
    pnpm: pnpmVersion,
    packageManagerRegistry: {
      intended: PUBLIC_NPM_REGISTRY,
      inheritedPnpm: inheritedPnpmRegistry,
      effective: {
        pnpm: effectivePnpmRegistry,
        npm: effectiveNpmRegistry,
      },
      isolatedConfig: {
        user: {
          path: run.npmUserConfigPath,
          sha256: await sha256File(run.npmUserConfigPath),
        },
        global: {
          path: run.npmGlobalConfigPath,
          sha256: await sha256File(run.npmGlobalConfigPath),
        },
      },
    },
    globalPnpmStore,
    offlineInstall: true,
    requestedPnpmSeedStore: pnpmSeedStore,
    selectedPnpmSeedStore,
    pnpmSeedEvidence: run.pnpmSeedEvidence,
    campaignModuleEvidence: run.campaignModuleEvidence,
    git: gitVersion,
    authoritative: {
      platformWorktree,
      platformHead: platformBefore.head,
      hostWorktree,
      hostHead: hostBefore.head,
      hostAppName: hostManifest.name,
      hostAppVersion: hostManifest.version,
      electronVersion: hostManifest.devDependencies?.electron
        ?? hostManifest.dependencies?.electron
        ?? null,
      contract,
      contractSha256: contractHash,
    },
    roots: {
      runRoot,
      platformSnapshot,
      fixtures: run.fixtureRoot,
      consumer: run.consumerRoot,
      archives: run.archiveRoot,
      temporary: run.temporaryRoot,
      npmCache: run.npmCacheRoot,
      pnpmStore: run.pnpmStoreRoot,
      packageManagerConfig: run.packageManagerConfigRoot,
    },
    commandEnvironment: commandEnvironment.evidence,
  });

  const install = await runCommand(run, {
    id: "snapshot-install",
    category: "required-snapshot-command",
    program: "pnpm",
    args: [
      "install",
      "--frozen-lockfile",
      "--offline",
      `--registry=${PUBLIC_NPM_REGISTRY}`,
    ],
    cwd: platformSnapshot,
    failureClassification: "environment",
  });
  const tscShim = path.join(
    platformSnapshot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsc.CMD" : "tsc",
  );
  const modulesMetadata = path.join(platformSnapshot, "node_modules", ".modules.yaml");
  const installReady = install.exitCode === 0
    && await pathExists(tscShim)
    && await pathExists(modulesMetadata);
  let dependencyTopology = null;
  if (installReady) {
    try {
      dependencyTopology = await captureDependencyTopology(run);
    } catch (error) {
      dependencyTopology = { verified: false, error: errorRecord(error) };
      await recordBug(run, {
        id: "BUG-HARNESS-DEPENDENCY-TOPOLOGY",
        kind: "harness-confinement",
        classification: "harness",
        status: "OPEN",
        summary: "Snapshot dependency links or pnpm metadata escaped the run root.",
        details: dependencyTopology,
      });
    }
  }
  run.dependencyTopology = dependencyTopology;
  const dependencyReady = installReady && dependencyTopology?.verified === true;
  run.installEvidence = {
    installReady,
    dependencyReady,
    tscShim: {
      path: tscShim,
      exists: await pathExists(tscShim),
      ...(await pathExists(tscShim) ? { sha256: await sha256File(tscShim) } : {}),
    },
    modulesMetadata: {
      path: modulesMetadata,
      exists: await pathExists(modulesMetadata),
      ...(await pathExists(modulesMetadata) ? { sha256: await sha256File(modulesMetadata) } : {}),
    },
    dependencyTopology,
  };
  if (install.exitCode === 0 && !installReady) {
    await recordBug(run, {
      id: "BUG-HARNESS-INSTALL-CONFINEMENT",
      kind: "harness-confinement",
      classification: "harness",
      status: "OPEN",
      summary: "Snapshot install succeeded without local TypeScript and pnpm metadata.",
      details: run.installEvidence,
    });
  }
  let build = skippedCommand("snapshot-build", "Snapshot install did not produce confined dependencies.");
  let typecheck = skippedCommand("snapshot-typecheck", "Snapshot install did not produce confined dependencies.");
  let test = skippedCommand("snapshot-test", "Snapshot install did not produce confined dependencies.");
  let packCheck = skippedCommand("snapshot-pack-check", "Snapshot install did not produce confined dependencies.");
  let verify = skippedCommand("snapshot-verify", "Snapshot install did not produce confined dependencies.");
  if (dependencyReady) {
    build = await runCommand(run, {
      id: "snapshot-build",
      category: "required-snapshot-command",
      program: "pnpm",
      args: ["build"],
      cwd: platformSnapshot,
    });
    typecheck = await runCommand(run, {
      id: "snapshot-typecheck",
      category: "required-snapshot-command",
      program: "pnpm",
      args: ["typecheck"],
      cwd: platformSnapshot,
    });
    test = await runCommand(run, {
      id: "snapshot-test",
      category: "required-snapshot-command",
      program: "pnpm",
      args: ["test"],
      cwd: platformSnapshot,
    });
    packCheck = await runCommand(run, {
      id: "snapshot-pack-check",
      category: "required-snapshot-command",
      program: "pnpm",
      args: ["pack:check"],
      cwd: platformSnapshot,
    });
    verify = await runCommand(run, {
      id: "snapshot-verify",
      category: "required-snapshot-command",
      program: "pnpm",
      args: ["verify"],
      cwd: platformSnapshot,
    });
  }
  run.packageBuildIdentity = await buildIdentity(run);
  const buildReady = dependencyReady
    && build.exitCode === 0
    && !run.packageBuildIdentity.hashes.runtimeExtensions.error;

  if (buildReady) {
    try {
      const deployment = await deployPackedWorkspaceClosure(run);
      run.consumerReady = deployment.ready;
      run.runtimeArchive = deployment.runtimeArchive;
      run.deploymentEvidence = deployment.evidence;
    } catch (error) {
      run.deploymentEvidence = {
        strategy: "locally-packed-workspace-closure",
        ready: false,
        networkAllowed: false,
        error: errorRecord(error),
      };
      await recordBug(run, {
        id: "BUG-HARNESS-LOCAL-DEPLOYMENT",
        kind: "harness-confinement",
        classification: "harness",
        status: "OPEN",
        summary: "Local packed workspace deployment failed.",
        details: run.deploymentEvidence,
      });
    }
  }

  if (buildReady && run.consumerReady) {
    try {
      run.moduleOriginEvidence = await captureModuleOrigins(run);
    } catch (error) {
      run.moduleOriginEvidence = { verified: false, error: errorRecord(error) };
      await recordBug(run, {
        id: "BUG-HARNESS-MODULE-ORIGIN-PROBE",
        kind: "harness-confinement",
        classification: "harness",
        status: "OPEN",
        summary: "Built package module-origin probe failed.",
        details: run.moduleOriginEvidence,
      });
    }
  } else {
    run.moduleOriginEvidence = {
      verified: false,
      skipped: true,
      reason: "Built runtime was not deployed into the isolated consumer.",
    };
  }
  const campaignReady = buildReady
    && run.consumerReady
    && run.moduleOriginEvidence.verified === true;

  if (campaignReady) {
    await campaigns.runTypeScriptCampaign(run).catch(async (error) => {
      await recordBug(run, {
        id: "BUG-CAMPAIGN-TS",
        kind: "campaign-error",
        classification: "harness",
        status: "OPEN",
        error: errorRecord(error),
      });
      const completed = new Set(run.stories.map((item) => item.id));
      await blockStories(
        run,
        campaigns.TYPESCRIPT_STORY_DEFINITIONS.filter(([id]) => !completed.has(id)),
        errorRecord(error),
      );
    });
  } else {
    await blockStories(run, campaigns.TYPESCRIPT_STORY_DEFINITIONS, {
      reason: "Confined snapshot build/deployment/module origins were not ready.",
      installExitCode: install.exitCode,
      buildExitCode: build.exitCode,
      consumerReady: run.consumerReady,
      moduleOriginEvidence: run.moduleOriginEvidence,
    });
  }

  if (campaignReady) {
    for (const [campaign, definitions, label] of [
      [campaigns.runExtensionCampaign, campaigns.EXTENSION_STORY_DEFINITIONS, "EXT"],
      [campaigns.runKernelCampaign, campaigns.KERNEL_STORY_DEFINITIONS, "KRN"],
      [campaigns.runPuiCampaign, campaigns.PUI_STORY_DEFINITIONS, "PUI"],
    ]) {
      try {
        await campaign(run);
      } catch (error) {
        await recordBug(run, {
          id: `BUG-CAMPAIGN-${label}`,
          kind: "campaign-error",
          classification: "harness",
          status: "OPEN",
          error: errorRecord(error),
        });
        const completed = new Set(run.stories.map((item) => item.id));
        await blockStories(run, definitions.filter(([id]) => !completed.has(id)), errorRecord(error));
      }
    }
  } else {
    const reason = {
      reason: "Built @marshal/runtime was not safely deployed into the isolated consumer.",
      buildReady,
      consumerReady: run.consumerReady,
      moduleOriginEvidence: run.moduleOriginEvidence,
    };
    await blockStories(run, campaigns.EXTENSION_STORY_DEFINITIONS, reason);
    await blockStories(run, campaigns.KERNEL_STORY_DEFINITIONS, reason);
    await blockStories(run, campaigns.PUI_STORY_DEFINITIONS, reason);
  }

  try {
    await campaigns.runLegacyCampaign(run);
  } catch (error) {
    await recordBug(run, {
      id: "BUG-CAMPAIGN-LEG",
      kind: "campaign-error",
      classification: "harness",
      status: "OPEN",
      error: errorRecord(error),
    });
    const completed = new Set(run.stories.map((item) => item.id));
    await blockStories(
      run,
      campaigns.LEGACY_STORY_DEFINITIONS.filter(([id]) => !completed.has(id)),
      errorRecord(error),
    );
  }

  await campaigns.terminateTrackedWorkers(run);
  await writeJson(path.join(runRoot, "process-tree-after.json"), await processTree());
  await writeJson(path.join(runRoot, "filesystem-after.json"), {
    capturedAt: isoNow(),
    fixtures: await inventoryTree(run.fixtureRoot, { hashLimit: 16 * 1024 * 1024 }),
    consumer: await inventoryTree(run.consumerRoot),
    archives: await inventoryTree(run.archiveRoot),
  });
  const [platformAfter, hostAfter] = await Promise.all([
    captureGitState(platformWorktree, "platform", runRoot, "after"),
    captureGitState(hostWorktree, "host", runRoot, "after"),
  ]);
  const authoritativeUnchanged = platformBefore.head === platformAfter.head
    && platformBefore.status === platformAfter.status
    && platformBefore.diffStat === platformAfter.diffStat
    && platformBefore.manifestSha256 === platformAfter.manifestSha256
    && hostBefore.head === hostAfter.head
    && hostBefore.status === hostAfter.status
    && hostBefore.diffStat === hostAfter.diffStat
    && hostBefore.manifestSha256 === hostAfter.manifestSha256;
  if (!authoritativeUnchanged) {
    await recordBug(run, {
      id: "BUG-AUTHORITATIVE-WORKTREE-MUTATION",
      kind: "confinement-failure",
      classification: "harness",
      status: "OPEN",
      summary: "An authoritative worktree changed during the acceptance run.",
    });
  }
  await writeJson(path.join(runRoot, "source-snapshots.json"), {
    platform: { before: platformBefore, after: platformAfter, snapshot },
    host: { before: hostBefore, after: hostAfter },
    authoritativeUnchanged,
  });
  const environment = JSON.parse(await readFile(path.join(runRoot, "environment.json"), "utf8"));
  environment.packageBuildIdentity = run.packageBuildIdentity;
  environment.installEvidence = run.installEvidence;
  environment.dependencyProvenance = {
    seed: run.pnpmSeedEvidence,
    topology: run.dependencyTopology,
    campaignModules: run.campaignModuleEvidence,
    deployment: run.deploymentEvidence,
    moduleOrigins: run.moduleOriginEvidence,
  };
  environment.runtimeArchive = run.runtimeArchive
    ? {
        path: run.runtimeArchive,
        size: (await stat(run.runtimeArchive)).size,
        sha256: await sha256File(run.runtimeArchive),
      }
    : null;
  await writeJson(path.join(runRoot, "environment.json"), environment);
  await writeJson(path.join(runRoot, "supporting-tests.json"), {
    generatedAt: isoNow(),
    commands: run.commands,
    requiredSnapshotCommands: {
      install: install.exitCode,
      build: build.exitCode,
      typecheck: typecheck.exitCode,
      test: test.exitCode,
      packCheck: packCheck.exitCode,
      verify: verify.exitCode,
    },
  });
  await writeJson(path.join(runRoot, "story-ledger.json"), {
    generatedAt: isoNow(),
    stories: run.stories.map((item) => ({
      id: item.id,
      evidenceClass: item.evidenceClass,
      runtimeSideStatus: item.runtimeSideStatus,
      contractStatus: item.contractStatus,
      continuationClassification: item.continuationClassification,
      artifact: path.join("stories", `${item.id}.json`),
    })),
  });
  await writeJson(path.join(runRoot, "bug-ledger.json"), {
    generatedAt: isoNow(),
    count: run.bugs.length,
    appendLog: "bug-ledger.jsonl",
    bugs: run.bugs,
  });
  const summary = {
    runRoot,
    sessionId,
    authoritativeUnchanged,
    storyCount: run.stories.length,
    storyLedgerCount: run.stories.length,
    bugLedgerCount: run.bugs.length,
    runtimeSideStatusCounts: countBy(run.stories, "runtimeSideStatus"),
    contractStatusCounts: countBy(run.stories, "contractStatus"),
    bugClassificationCounts: countBy(run.bugs, "classification"),
    runtimeFailures: run.stories
      .filter((item) => item.runtimeSideStatus === "FAIL")
      .map((item) => item.id),
    runtimeBlocked: run.stories
      .filter((item) => item.runtimeSideStatus === "BLOCKED")
      .map((item) => item.id),
    commandCount: run.commands.length,
    failedCommands: run.commands
      .filter((item) => item.exitCode !== 0)
      .map((item) => item.id),
  };
  await writeJson(path.join(runRoot, "summary.json"), summary);
  await writeJson(path.join(runRoot, "run-manifest.json"), {
    runId: path.basename(runRoot),
    sessionId,
    startedAt,
    endedAt: isoNow(),
    authoritative: {
      platformWorktree,
      hostWorktree,
      contract,
      readOnly: true,
      unchanged: authoritativeUnchanged,
    },
    snapshots: { platform: platformSnapshot },
    roots: {
      evidence: runRoot,
      fixtures: run.fixtureRoot,
      consumer: run.consumerRoot,
      archives: run.archiveRoot,
      temporary: run.temporaryRoot,
      npmCache: run.npmCacheRoot,
      pnpmStore: run.pnpmStoreRoot,
      packageManagerConfig: run.packageManagerConfigRoot,
    },
    packageBuildIdentity: run.packageBuildIdentity,
    dependencyProvenance: environment.dependencyProvenance,
    runtimeArchive: run.runtimeArchive,
    statusSemantics: {
      primary: "MRT-KRN-*, MRT-PUI-*, and MRT-LEG-002 may PASS from required NODE-INTEGRATION/STATIC evidence.",
      supporting: "MRT-TS-*, MRT-EXT-*, and MRT-LEG-001 remain NOT RUN without LIVE-ELECTRON unless runtime support FAILs.",
    },
    requiredArtifacts: [
      "environment.json",
      "dirty-files.txt",
      "source-snapshots.json",
      "supporting-tests.json",
      "process-tree-before.json",
      "process-tree-after.json",
      "filesystem-before.json",
      "filesystem-after.json",
      "process-transcript.jsonl",
      "command-transcript.jsonl",
      "hashes.json",
      "story-ledger.json",
      "bug-ledger.json",
      "bug-ledger.jsonl",
      "summary.json",
      "run-manifest.json",
      "stories",
      "fixtures",
      "consumer",
      "package-archives",
      "package-manager-config",
    ],
  });
  await writeFinalHashes(run);

  const failed = run.stories.some((item) => item.runtimeSideStatus === "FAIL");
  const blocked = run.stories.some((item) => item.runtimeSideStatus === "BLOCKED");
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = failed ? 1 : blocked ? 2 : 0;
}

main().catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
