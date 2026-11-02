#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validMediaSignature, verifyEvidenceBundle } from './verify-evidence.mjs';

const captureRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(captureRoot, '..', '..', '..');
const plan = JSON.parse(await readFile(join(captureRoot, 'capture-plan.json'), 'utf8'));

/** Generate honest short derivatives only after the complete uncut bundle passes capture verification. */
export async function generateDerivatives(evidenceArgument, demoId, editsArgument, options = {}) {
  requireAbsolute(evidenceArgument, 'Evidence bundle');
  requireAbsolute(editsArgument, 'Edit manifest');
  const evidenceRoot = resolve(evidenceArgument);
  if (inside(evidenceRoot, repositoryRoot)) throw new Error('Evidence bundles must live outside the source repository.');
  const demo = plan.demos.find((item) => item.id === demoId);
  if (!demo) throw new Error(`Unknown capture demo: ${demoId}`);
  const demoRoot = join(evidenceRoot, demo.id);
  const capture = await verifyEvidenceBundle(evidenceRoot, { level: 'capture', writeIndex: false });
  if (!capture.ok) throw new Error(`Uncut capture bundle is not accepted:\n${capture.errors.join('\n')}`);

  const editInput = JSON.parse(await readFile(resolve(editsArgument), 'utf8'));
  const edits = validateEditManifest(editInput, demo.id);
  const ffmpeg = options.ffmpeg ?? 'ffmpeg';
  const ffprobe = options.ffprobe ?? 'ffprobe';
  const version = run(ffmpeg, ['-version']).stdout.split(/\r?\n/, 1)[0]?.trim();
  if (!version) throw new Error('FFmpeg did not report a version.');
  const duration = Number.parseFloat(run(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', 'screen.webm',
  ], demoRoot).stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('FFprobe did not report a positive screen.webm duration.');
  for (const edit of edits) {
    if (edit.sourceEndMs > Math.floor(duration * 1000) + 1) {
      throw new Error(`Edit range ${edit.sourceStartMs}-${edit.sourceEndMs}ms exceeds the ${duration}s source.`);
    }
  }

  const outputs = ['preview.gif', 'short.mp4', 'derivatives.json'];
  await Promise.all(outputs.map((name) => requireMissing(join(demoRoot, name))));
  const commands = buildDerivativeCommands(edits);
  const tempGif = '.marshal-preview.tmp.gif';
  const tempMp4 = '.marshal-short.tmp.mp4';
  await Promise.all([tempGif, tempMp4, '.marshal-derivatives.tmp.json'].map((name) => requireMissing(join(demoRoot, name))));
  const created = [];
  try {
    run(ffmpeg, commands.gif, demoRoot);
    run(ffmpeg, commands.mp4, demoRoot);
    const gifBytes = await readFile(join(demoRoot, tempGif));
    const mp4Bytes = await readFile(join(demoRoot, tempMp4));
    if (!validMediaSignature(gifBytes, 'gif') || !validMediaSignature(mp4Bytes, 'mp4')) {
      throw new Error('FFmpeg outputs did not have the expected GIF and MP4 signatures.');
    }
    const sourceBytes = await readFile(join(demoRoot, 'screen.webm'));
    const manifest = {
      schemaVersion: '1.0.0',
      evidenceClass: 'deterministic-derivative-provenance-supporting-only',
      demoId: demo.id,
      encoder: {
        name: 'ffmpeg',
        version,
        commands: [commandRecord(ffmpeg, commands.gif), commandRecord(ffmpeg, commands.mp4)],
        probe: commandRecord(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', 'screen.webm']),
      },
      source: { path: 'screen.webm', bytes: sourceBytes.length, sha256: sha256(sourceBytes), durationMs: Math.round(duration * 1000) },
      outputs: [
        { path: 'preview.gif', bytes: gifBytes.length, sha256: sha256(gifBytes) },
        { path: 'short.mp4', bytes: mp4Bytes.length, sha256: sha256(mp4Bytes) },
      ],
      edits,
      caveats: [
        'These files are edited derivatives, not uncut evidence.',
        'Ranges are applied in the listed order and map to screen.webm milliseconds.',
        'Human review must confirm continuity and that the short edit fairly represents the uncut run.',
      ],
    };
    await writeFile(join(demoRoot, '.marshal-derivatives.tmp.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await rename(join(demoRoot, tempGif), join(demoRoot, 'preview.gif'));
    created.push('preview.gif');
    await rename(join(demoRoot, tempMp4), join(demoRoot, 'short.mp4'));
    created.push('short.mp4');
    await rename(join(demoRoot, '.marshal-derivatives.tmp.json'), join(demoRoot, 'derivatives.json'));
    created.push('derivatives.json');
    return { demoRoot, manifest };
  } catch (error) {
    await Promise.all([tempGif, tempMp4, '.marshal-derivatives.tmp.json', ...created].map((name) => rm(join(demoRoot, name), { force: true })));
    throw error;
  }
}

export function validateEditManifest(value, demoId) {
  if (!value || value.schemaVersion !== '1.0.0' || value.demoId !== demoId || !Array.isArray(value.edits) || value.edits.length === 0) {
    throw new Error('Edit manifest requires schemaVersion 1.0.0, matching demoId, and at least one edit.');
  }
  return value.edits.map((edit, index) => {
    if (!finiteRange(edit?.sourceStartMs, edit?.sourceEndMs) || typeof edit.purpose !== 'string' || !edit.purpose.trim()) {
      throw new Error(`Edit ${index} requires a finite positive source range and purpose.`);
    }
    return { sourceStartMs: edit.sourceStartMs, sourceEndMs: edit.sourceEndMs, purpose: edit.purpose.trim() };
  });
}

export function buildDerivativeCommands(edits) {
  const trims = edits.map((edit, index) => `[0:v]trim=start=${seconds(edit.sourceStartMs)}:end=${seconds(edit.sourceEndMs)},setpts=PTS-STARTPTS[v${index}]`).join(';');
  const inputs = edits.map((_, index) => `[v${index}]`).join('');
  const concat = `${trims};${inputs}concat=n=${edits.length}:v=1:a=0`;
  const common = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', 'screen.webm'];
  return {
    gif: [
      ...common,
      '-filter_complex', `${concat},fps=12,scale=w='min(960,iw)':h=-2:flags=lanczos,split[g0][g1];[g0]palettegen=stats_mode=diff[p];[g1][p]paletteuse=dither=bayer:bayer_scale=3[outv]`,
      '-map', '[outv]', '-an', '-map_metadata', '-1', '-threads', '1', '.marshal-preview.tmp.gif',
    ],
    mp4: [
      ...common,
      '-filter_complex', `${concat},scale=w='min(1280,iw)':h=-2:flags=lanczos,fps=30,format=yuv420p[outv]`,
      '-map', '[outv]', '-an', '-map_metadata', '-1', '-c:v', 'libx264', '-preset', 'medium', '-crf', '22',
      '-threads', '1', '-movflags', '+faststart', '-fflags', '+bitexact', '-flags:v', '+bitexact', '.marshal-short.tmp.mp4',
    ],
  };
}

function seconds(milliseconds) {
  return (milliseconds / 1000).toFixed(3);
}

function commandRecord(executable, args) {
  return { executable, arguments: args };
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true, shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}: ${(result.stderr || result.stdout).trim()}`);
  return result;
}

async function requireMissing(path) {
  try {
    await access(path);
    throw new Error(`Refusing to overwrite existing derivative: ${path}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function requireAbsolute(value, label) {
  if (!value || !isAbsolute(value)) throw new Error(`${label} path must be absolute.`);
}

function inside(candidate, parent) {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function finiteRange(start, end) {
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

if (import.meta.url === pathToFileURL(process.argv[1] ? resolve(process.argv[1]) : '').href) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const positional = args.filter((value, index) => !value.startsWith('--') && !['--ffmpeg', '--ffprobe'].includes(args[index - 1]));
  try {
    const result = await generateDerivatives(positional[0], positional[1], positional[2], {
      ffmpeg: option('--ffmpeg', 'ffmpeg'),
      ffprobe: option('--ffprobe', 'ffprobe'),
    });
    console.log(`Generated preview.gif and short.mp4 for ${result.manifest.demoId} from ${result.manifest.edits.length} disclosed source range(s).`);
    console.log('The derivatives remain edited media and require human fairness review.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
