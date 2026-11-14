// An in-process lock per file path, for the read-modify-write stores (the agreement ledger and the
// cross-game player record): two tool calls in this process that read, change and write the same
// file run one after the other, so neither write loses the other's change. It serialises this
// process only; another process sharing the data directory is not covered (writes stay atomic, so a
// file is never torn, but the later writer wins).

const tails = new Map<string, Promise<void>>();

/** Run `fn` once every earlier section on `path` in this process has finished (thrown or not). */
export async function withPathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(path) ?? Promise.resolve();
  let release!: () => void;
  const tail = previous.then(() => new Promise<void>((resolve) => (release = resolve)));
  tails.set(path, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(path) === tail) tails.delete(path);
  }
}
