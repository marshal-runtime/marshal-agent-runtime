export class WorkerProcess {
  #pending = [];
  enqueue(job) { this.#pending.push(job); }
  finishNext(value) { this.#pending.shift()?.complete(value); }
}
