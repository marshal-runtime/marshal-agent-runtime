// Exports the canonical form of the runner temp directory to later CI steps.
// macOS places os.tmpdir() behind a symlink and Windows exposes an 8.3 short name, and several suites reject a root whose canonical path differs.
import { appendFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

const canonical = realpathSync.native(tmpdir());
const variables = ['TMPDIR', 'TMP', 'TEMP'];
appendFileSync(process.env.GITHUB_ENV, `${variables.map((name) => `${name}=${canonical}`).join('\n')}\n`);
console.log(`temp directory: ${canonical}`);
