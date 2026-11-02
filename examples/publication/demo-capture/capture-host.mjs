#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const captureRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(captureRoot, '..', '..', '..');

export function buildWindowsCaptureArguments({
  output,
  source = 'desktop',
  windowTitle = 'Codex',
  frameRate = 30,
} = {}) {
  if (!isAbsolute(output ?? '')) throw new Error('Recording output must be an absolute path.');
  if (!['desktop', 'window'].includes(source)) throw new Error('Capture source must be desktop or window.');
  if (!Number.isInteger(frameRate) || frameRate < 15 || frameRate > 60) {
    throw new Error('Frame rate must be an integer from 15 through 60.');
  }
  const input = source === 'desktop' ? 'desktop' : `title=${windowTitle}`;
  return [
    '-hide_banner', '-loglevel', 'info', '-nostdin', '-n',
    '-f', 'gdigrab', '-draw_mouse', '1', '-framerate', String(frameRate),
    '-i', input,
    '-an', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '4',
    '-b:v', '0', '-crf', '28', '-row-mt', '1',
    output,
  ];
}

export async function probeCaptureHost({ ffmpeg = 'ffmpeg', windowTitle = 'Codex' } = {}) {
  const report = {
    schemaVersion: '1.0.0',
    status: 'preflight-not-evidence',
    inspectedAt: new Date().toISOString(),
    platform: process.platform,
    capture: {
      method: 'ffmpeg-gdigrab',
      continuousDesktopSupported: false,
      windowCaptureSupported: false,
      restartSafeSource: 'desktop',
      ffmpeg,
      ffmpegVersion: undefined,
    },
    target: { windowTitle, visible: false, processName: undefined },
    interaction: {
      pixels: 'foreground-os-recorder-available-after-operator-start',
      clicks: 'human-required',
      displayModes: 'human-control-in-authored-app-required',
      historicalReopen: 'human-required',
      applicationRestart: 'human-product-operation-required',
      automatedRestartAttempted: false,
    },
    warnings: [
      'Desktop capture can include notifications or unrelated windows; close sensitive surfaces before recording.',
      'This preflight does not create evidence and does not inspect Codex pixels.',
    ],
  };

  if (process.platform !== 'win32') {
    report.capture.reason = 'This driver currently supports Windows gdigrab only.';
    return report;
  }

  const version = await run(ffmpeg, ['-hide_banner', '-version']);
  report.capture.ffmpegVersion = version.stdout.split(/\r?\n/, 1)[0]?.trim();
  if (version.code !== 0) {
    report.capture.reason = version.stderr.trim() || 'ffmpeg did not start.';
    return report;
  }
  const formats = await run(ffmpeg, ['-hide_banner', '-formats']);
  const hasGdiGrab = /\bgdigrab\b/.test(`${formats.stdout}\n${formats.stderr}`);
  report.capture.continuousDesktopSupported = hasGdiGrab;
  report.capture.windowCaptureSupported = hasGdiGrab;
  if (!hasGdiGrab) report.capture.reason = 'ffmpeg does not advertise the gdigrab input format.';

  const window = await findVisibleWindow(windowTitle);
  if (window) {
    report.target.visible = true;
    report.target.processName = window.processName;
    report.target.processId = window.processId;
    report.target.actualTitle = window.title;
  }
  return report;
}

export async function recordCapture({
  ffmpeg = 'ffmpeg',
  output,
  source = 'desktop',
  windowTitle = 'Codex',
  frameRate = 30,
} = {}) {
  const target = resolve(output ?? '');
  if (!isAbsolute(output ?? '')) throw new Error('Recording output must be an absolute path.');
  if (basename(target) !== 'screen.webm') throw new Error('Recording output filename must be screen.webm.');
  if (inside(target, repositoryRoot)) throw new Error('Live media must be recorded outside the source repository.');
  await access(dirname(target));
  const sidecarPath = resolve(dirname(target), 'recorder.json');
  await requireMissing(target, 'recording');
  await requireMissing(sidecarPath, 'recorder provenance');

  const preflight = await probeCaptureHost({ ffmpeg, windowTitle });
  if (!preflight.capture.continuousDesktopSupported) {
    throw new Error(preflight.capture.reason ?? 'Windows desktop capture is unavailable.');
  }
  if (source === 'window' && !preflight.target.visible) {
    throw new Error(`No visible window matched title ${JSON.stringify(windowTitle)}.`);
  }

  const args = buildWindowsCaptureArguments({ output: target, source, windowTitle, frameRate });
  const startedAt = new Date().toISOString();
  process.stderr.write([
    `Recording ${source === 'desktop' ? 'the full desktop' : `window ${JSON.stringify(windowTitle)}`} to ${target}`,
    'Press Ctrl+C once after the complete run. The recorder will not click, restart, or reopen Codex for you.',
    source === 'window'
      ? 'Warning: window-only capture cannot remain continuous while Codex is closed; use --source desktop for restart evidence.'
      : 'Warning: desktop capture can record notifications and unrelated windows.',
    '',
  ].join('\n'));

  const child = spawn(ffmpeg, args, { shell: false, stdio: 'inherit', windowsHide: true });
  const interrupt = () => {
    if (!child.killed) child.kill('SIGINT');
  };
  process.once('SIGINT', interrupt);
  const outcome = await waitForChild(child);
  process.removeListener('SIGINT', interrupt);
  const completedAt = new Date().toISOString();
  const info = await stat(target);
  const sha256 = createHash('sha256').update(await readFile(target)).digest('hex');
  const sidecar = {
    schemaVersion: '1.0.0',
    evidenceClass: 'recorder-provenance-supporting-only',
    startedAt,
    completedAt,
    source,
    targetWindowTitle: windowTitle,
    output: { path: 'screen.webm', bytes: info.size, sha256 },
    encoder: { executable: ffmpeg, version: preflight.capture.ffmpegVersion, arguments: args },
    processOutcome: outcome,
    interactionDriver: 'human',
    applicationRestartAutomated: false,
  };
  await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, { flag: 'wx' });
  return { target, sidecarPath, outcome, bytes: info.size, sha256 };
}

async function findVisibleWindow(title) {
  const escaped = title.replaceAll("'", "''");
  const script = [
    "$match = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -eq '" + escaped + "' } | Select-Object -First 1",
    "if ($match) { [pscustomobject]@{ processId=$match.Id; processName=$match.ProcessName; title=$match.MainWindowTitle } | ConvertTo-Json -Compress }",
  ].join('; ');
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (result.code !== 0 || !result.stdout.trim()) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

function run(command, args) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolveResult({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (code, signal) => resolveResult({ code: code ?? -1, signal, stdout, stderr }));
  });
}

function waitForChild(child) {
  return new Promise((resolveResult, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolveResult({ code, signal }));
  });
}

function inside(candidate, parent) {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

async function requireMissing(path, label) {
  try {
    await stat(path);
    throw new Error(`Refusing to overwrite existing ${label}: ${path}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

if (import.meta.url === pathToFileURL(process.argv[1] ? resolve(process.argv[1]) : '').href) {
  const args = process.argv.slice(2);
  const command = args[0];
  try {
    if (command === 'probe') {
      const report = await probeCaptureHost({
        ffmpeg: option(args, '--ffmpeg', 'ffmpeg'),
        windowTitle: option(args, '--window-title', 'Codex'),
      });
      const output = option(args, '--output');
      if (output) {
        if (!isAbsolute(output)) throw new Error('--output must be absolute.');
        await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
      }
      console.log(JSON.stringify(report, null, 2));
    } else if (command === 'record') {
      const result = await recordCapture({
        output: args[1],
        ffmpeg: option(args, '--ffmpeg', 'ffmpeg'),
        source: option(args, '--source', 'desktop'),
        windowTitle: option(args, '--window-title', 'Codex'),
        frameRate: Number(option(args, '--framerate', '30')),
      });
      console.log(JSON.stringify(result, null, 2));
    } else {
      throw new Error('Usage: capture-host.mjs probe [--ffmpeg path] [--window-title Codex] [--output absolute.json]\n   or: capture-host.mjs record absolute-screen.webm [--source desktop|window] [--ffmpeg path] [--window-title Codex] [--framerate 30]');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
