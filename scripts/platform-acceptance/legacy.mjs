import { readFile } from "node:fs/promises";
import path from "node:path";
import { runStory } from "./lib.mjs";

export const LEGACY_STORY_DEFINITIONS = [
  ["MRT-LEG-001", "STATIC+NODE-INTEGRATION", { requiredLiveEvidence: "LIVE-ELECTRON" }],
  ["MRT-LEG-002", "STATIC", {}],
];

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function runLegacyCampaign(run) {
  await runStory(run, "MRT-LEG-001", "STATIC+NODE-INTEGRATION", LEGACY_STORY_DEFINITIONS[0][2], async (story) => {
    story.action("Verify the public runtime manifest and source retain only portable package surfaces.");
    const runtimeManifest = await readJson(
      path.join(run.platformSnapshot, "packages", "runtime", "package.json"),
    );
    const runtimeIndex = await readFile(
      path.join(run.platformSnapshot, "packages", "runtime", "src", "index.ts"),
      "utf8",
    );
    story.result("runtimeManifest", runtimeManifest);
    story.result("runtimeIndex", runtimeIndex);
    story.assert("runtime exports the generic extension surface", Boolean(runtimeManifest.exports?.["./extensions"]),
      "./extensions", runtimeManifest.exports);
    story.assert("runtime main entrypoint remains portable",
      !/extension-specific/i.test(runtimeIndex), "portable entrypoint", runtimeIndex);
  });

  await runStory(run, "MRT-LEG-002", "STATIC", {}, async (story) => {
    const rootManifest = await readJson(path.join(run.platformSnapshot, "package.json"));
    const runtimeManifest = await readJson(
      path.join(run.platformSnapshot, "packages", "runtime", "package.json"),
    );
    const requiredCommands = ["build", "typecheck", "pack:check", "verify", "acceptance:platform"];
    story.action("Verify repository validation commands remain explicit.");
    story.result("rootScripts", rootManifest.scripts);
    story.result("runtimeScripts", runtimeManifest.scripts);
    story.assert("remaining validation commands are explicit",
      requiredCommands.every((name) => typeof rootManifest.scripts?.[name] === "string"
        && rootManifest.scripts[name].trim()), requiredCommands, rootManifest.scripts);
    story.assert("runtime package retains build and typecheck scripts",
      typeof runtimeManifest.scripts?.build === "string"
        && typeof runtimeManifest.scripts?.typecheck === "string",
      "build/typecheck", runtimeManifest.scripts);
  });
}
