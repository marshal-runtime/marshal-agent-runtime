export async function waitForWork(signal, registerWorker) {
  if (signal.aborted) throw signal.reason;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort);
    registerWorker((value) => resolve(value));
  });
}
