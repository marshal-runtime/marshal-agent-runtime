import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Match a launched executable even when npm/pnpm reaches it through a symlink or junction. */
export function isDirectEntrypoint(moduleUrl: string, entry = process.argv[1]): boolean {
  if (!entry) return false;
  try {
    return normalize(realpathSync.native(fileURLToPath(moduleUrl)))
      === normalize(realpathSync.native(resolve(entry)));
  } catch {
    return false;
  }
}

function normalize(value: string): string {
  return process.platform === 'win32' ? value.toLocaleLowerCase() : value;
}
