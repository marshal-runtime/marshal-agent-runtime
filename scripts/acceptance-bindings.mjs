import { join, resolve } from 'node:path';
import { createCodexRuntime } from '../packages/agent-runtime-codex/dist/index.js';

export default async function createAcceptanceBindings(options = {}) {
  const stateDirectory = process.env.MARSHAL_ACCEPTANCE_STATE_DIRECTORY;
  const worktreeRoot = process.env.MARSHAL_ACCEPTANCE_WORKTREE_ROOT;
  const protectedRoot = process.env.MARSHAL_ACCEPTANCE_PROTECTED_ROOT;
  if (!stateDirectory || !worktreeRoot || !protectedRoot) {
    throw new Error('Acceptance state, worktree, and protected roots must be supplied by the runner.');
  }
  return createCodexRuntime({
    workspacePath: options.workspacePath,
    stateDirectory,
    protectedLifecycleResultRoot: join(resolve(protectedRoot), 'lifecycle'),
    worktreeRoot,
    permissionProfile: 'trusted-local',
    permissionPatterns: ['runtime.effects.execute', 'runtime.jobs.*', 'code.index.*'],
  });
}
