import { waitForWork } from './queue.mjs';

export function runQueuedJob(workerProcess, options = {}) {
  const signal = options.signal ?? new AbortController().signal;
  return waitForWork(signal, (complete) => workerProcess.enqueue({ complete, signal }));
}
