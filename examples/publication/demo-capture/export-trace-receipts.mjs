#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const captureRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(captureRoot, '..', '..', '..');

/**
 * Canonicalize a harness-exported JSON/JSONL event stream and extract only
 * receipt-shaped objects already present in it. No event or receipt is
 * synthesized. The provenance manifest binds every output to the raw input.
 */
export async function exportTraceAndReceipts(sourceArgument, targetArgument, options = {}) {
  requireAbsolute(sourceArgument, 'Source trace');
  requireAbsolute(targetArgument, 'Target demo directory');
  const source = resolve(sourceArgument);
  const target = resolve(targetArgument);
  if (inside(target, repositoryRoot)) throw new Error('Evidence exports must live outside the source repository.');

  const traceName = safeOutputName(options.traceName ?? 'trace.jsonl');
  const receiptsName = options.receipts === false
    ? undefined
    : safeOutputName(options.receiptsName ?? 'receipts.export.jsonl');
  const manifestName = safeOutputName(options.manifestName ?? 'trace-export.json');
  const outputNames = [traceName, manifestName, ...(receiptsName ? [receiptsName] : [])];
  await mkdir(target, { recursive: true });
  await Promise.all(outputNames.map((name) => requireMissing(join(target, name))));

  const raw = await readFile(source);
  const parsed = parseRecords(raw.toString('utf8'));
  if (parsed.records.length === 0) throw new Error('Source trace contains no JSON records.');
  const traceBytes = Buffer.from(`${parsed.records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  const discovered = collectReceipts(parsed.records);
  if (receiptsName && discovered.receipts.length === 0 && options.allowNoReceipts !== true) {
    throw new Error('No receipt-shaped objects were found; pass --allow-no-receipts or --no-receipts only when that absence is expected.');
  }
  const receiptBytes = receiptsName
    ? Buffer.from(discovered.receipts.length === 0 ? '' : `${discovered.receipts.map((item) => JSON.stringify(item.value)).join('\n')}\n`)
    : undefined;
  const manifest = {
    schemaVersion: '1.0.0',
    evidenceClass: 'trace-receipt-export-provenance-supporting-only',
    transformation: 'parse-json-or-jsonl-and-canonicalize-one-json-value-per-line',
    source: {
      fileName: source.split(/[\\/]/).at(-1),
      format: parsed.format,
      bytes: raw.length,
      sha256: sha256(raw),
      recordCount: parsed.records.length,
    },
    outputs: [
      { path: traceName, bytes: traceBytes.length, sha256: sha256(traceBytes), recordCount: parsed.records.length },
      ...(receiptsName ? [{
        path: receiptsName,
        bytes: receiptBytes.length,
        sha256: sha256(receiptBytes),
        recordCount: discovered.receipts.length,
      }] : []),
    ],
    receiptExtraction: receiptsName ? {
      policy: 'existing-objects-with-receiptId-status-and-target-operation-or-executionId',
      receiptIds: discovered.receipts.map((item) => item.value.receiptId),
      sourcePointers: discovered.receipts.map((item) => item.pointer),
      conflictingDuplicateIdsRejected: true,
    } : { policy: 'disabled', receiptIds: [], sourcePointers: [], conflictingDuplicateIdsRejected: true },
    caveats: [
      'This export proves byte provenance and structural extraction only.',
      'It does not prove that a host action occurred or that a receipt is truthful.',
      'Human redaction and trace/receipt correspondence review remain required.',
    ],
  };

  const nonce = `${process.pid}-${Date.now()}`;
  const pending = [
    [traceName, traceBytes],
    ...(receiptsName ? [[receiptsName, receiptBytes]] : []),
    [manifestName, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)],
  ];
  const temporary = pending.map(([name, bytes]) => [name, join(target, `.${name}.${nonce}.tmp`), bytes]);
  const created = [];
  try {
    for (const [, path, bytes] of temporary) await writeFile(path, bytes, { flag: 'wx' });
    for (const [name, path] of temporary) {
      await rename(path, join(target, name));
      created.push(name);
    }
  } catch (error) {
    await Promise.all([
      ...temporary.map(([, path]) => rm(path, { force: true })),
      ...created.map((name) => rm(join(target, name), { force: true })),
    ]);
    throw error;
  }
  return { target, manifest };
}

export function parseRecords(text) {
  if (!text.trim()) return { format: 'empty', records: [] };
  try {
    const value = JSON.parse(text);
    if (Array.isArray(value)) return { format: 'json-array', records: value };
    return { format: 'json-value', records: [value] };
  } catch {
    const records = text.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Source trace line ${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    return { format: 'jsonl', records };
  }
}

export function collectReceipts(records) {
  const byId = new Map();
  const receipts = [];
  const visit = (value, pointer) => {
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value) && receiptShaped(value)) {
      const serialized = JSON.stringify(value);
      const prior = byId.get(value.receiptId);
      if (prior && prior.serialized !== serialized) throw new Error(`Conflicting receipt objects share receiptId ${value.receiptId}.`);
      if (!prior) {
        const item = { value, pointer };
        byId.set(value.receiptId, { serialized, item });
        receipts.push(item);
      }
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${pointer}/${index}`));
    } else {
      for (const [key, item] of Object.entries(value)) visit(item, `${pointer}/${escapePointer(key)}`);
    }
  };
  records.forEach((record, index) => visit(record, `/${index}`));
  return { receipts };
}

function receiptShaped(value) {
  return stableString(value.receiptId)
    && stableString(value.status)
    && [value.target, value.operation, value.executionId].some(stableString);
}

function escapePointer(value) {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function safeOutputName(value) {
  if (!stableString(value) || value.includes('/') || value.includes('\\') || value === '.' || value === '..') {
    throw new Error(`Output name must be one plain file name: ${String(value)}`);
  }
  return value;
}

function stableString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function requireAbsolute(value, label) {
  if (!value || !isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
}

async function requireMissing(path) {
  try {
    await access(path);
    throw new Error(`Refusing to overwrite existing export: ${path}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function inside(candidate, parent) {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

if (import.meta.url === pathToFileURL(process.argv[1] ? resolve(process.argv[1]) : '').href) {
  const args = process.argv.slice(2);
  const positional = args.filter((value, index) => !value.startsWith('--') && (index === 0 || !['--trace-name', '--receipts-name', '--manifest-name'].includes(args[index - 1])));
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  try {
    const result = await exportTraceAndReceipts(positional[0], positional[1], {
      traceName: option('--trace-name', 'trace.jsonl'),
      receiptsName: option('--receipts-name', 'receipts.export.jsonl'),
      manifestName: option('--manifest-name', 'trace-export.json'),
      receipts: !args.includes('--no-receipts'),
      allowNoReceipts: args.includes('--allow-no-receipts'),
    });
    console.log(`Exported ${result.manifest.source.recordCount} trace records and ${result.manifest.receiptExtraction.receiptIds.length} existing receipts to ${result.target}.`);
    console.log('This is supporting provenance, not proof of host behavior.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
