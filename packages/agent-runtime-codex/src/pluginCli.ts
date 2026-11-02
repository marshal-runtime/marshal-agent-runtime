#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { isDirectEntrypoint } from './entrypoint.js';
import { installCodexPlugin } from './plugin.js';

export async function runCodexPluginInstaller(argv = process.argv.slice(2)): Promise<void> {
  const options = parse(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (!options.destination) throw new Error('--destination is required.');
  const installOptions: Parameters<typeof installCodexPlugin>[0] & {
    readonly adaptiveAgentic: boolean;
  } = {
    destination: options.destination,
    ...(options.pluginVersion ? { version: options.pluginVersion } : {}),
    force: options.force,
    boundedAgentic: options.boundedAgentic,
    adaptiveAgentic: options.adaptiveAgentic,
    trustedLocal: options.trustedLocal,
    runtimeLaunch: {
      nodeExecutable: process.execPath,
      serverEntrypoint: fileURLToPath(new URL('./cli.js', import.meta.url)),
      hookEntrypoint: fileURLToPath(new URL('./hookCli.js', import.meta.url)),
      ...(options.kernelModule ? { kernelModule: options.kernelModule } : {}),
    },
  };
  const installed = await installCodexPlugin(installOptions);
  process.stdout.write(`${JSON.stringify({ ok: true, ...installed }, null, 2)}\n`);
}

function parse(argv: readonly string[]): {
  destination?: string;
  kernelModule?: string;
  pluginVersion?: string;
  force: boolean;
  boundedAgentic: boolean;
  adaptiveAgentic: boolean;
  trustedLocal: boolean;
  help: boolean;
} {
  const parsed = {
    force: false,
    boundedAgentic: false,
    adaptiveAgentic: false,
    trustedLocal: false,
    help: false,
  } as {
    destination?: string;
    kernelModule?: string;
    pluginVersion?: string;
    force: boolean;
    boundedAgentic: boolean;
    adaptiveAgentic: boolean;
    trustedLocal: boolean;
    help: boolean;
  };
  for (let index = 0; index < argv.length; index += 1) {
    switch (argv[index]) {
      case '--destination': {
        const destination = argv[++index];
        if (!destination || destination.startsWith('--')) throw new Error('--destination requires a path.');
        parsed.destination = destination;
        break;
      }
      case '--kernel-module': {
        const kernelModule = argv[++index];
        if (!kernelModule || kernelModule.startsWith('--')) {
          throw new Error('--kernel-module requires an absolute ESM module path.');
        }
        parsed.kernelModule = kernelModule;
        break;
      }
      case '--plugin-version': {
        const pluginVersion = argv[++index];
        if (!pluginVersion || pluginVersion.startsWith('--')) {
          throw new Error('--plugin-version requires a version.');
        }
        parsed.pluginVersion = pluginVersion;
        break;
      }
      case '--force':
        parsed.force = true;
        break;
      case '--brokered-only':
        parsed.boundedAgentic = false;
        parsed.adaptiveAgentic = false;
        parsed.trustedLocal = false;
        break;
      case '--bounded-agentic':
        parsed.boundedAgentic = true;
        parsed.adaptiveAgentic = false;
        parsed.trustedLocal = false;
        break;
      case '--adaptive-agentic':
        parsed.boundedAgentic = false;
        parsed.adaptiveAgentic = true;
        parsed.trustedLocal = false;
        break;
      case '--trusted-local':
        parsed.boundedAgentic = false;
        parsed.adaptiveAgentic = false;
        parsed.trustedLocal = true;
        break;
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  return parsed;
}

function usage(): string {
  return `agent-runtime-codex-install-plugin

Usage:
  agent-runtime-codex-install-plugin --destination <plugin-root> [--plugin-version <version>] [--kernel-module <absolute-esm-path>] [--force] [--bounded-agentic|--adaptive-agentic|--trusted-local]

The generated plugin pins its MCP server and lifecycle hooks to this installed
adapter's Node entrypoints, so desktop and noninteractive hosts do not depend on
shell PATH resolution. Regenerate the plugin when updating the adapter. The
optional --plugin-version is passed unchanged through the existing installer
projection and can provide a unique local-marketplace cache buster after source changes. The
default is brokered/default-deny. --bounded-agentic preauthorizes bounded native
agent spawn/steer/cancel operations. --adaptive-agentic additionally permits
bounded agent-authored UI compilation without trusted Node or wildcard imports.
--trusted-local deliberately enables the control plane plus wildcard local
package and Node builtin imports.
--kernel-module pins the MCP server to a detachable composition module while
hooks remain pinned to this adapter's lightweight lifecycle entrypoint.
`;
}

if (isDirectEntrypoint(import.meta.url)) {
  runCodexPluginInstaller().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
