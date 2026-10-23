/** Shared, abort-aware budget for channel metadata, covers and lazy previews. */
export class ContentRequestPool {
  private active = 0;
  private waiting: { resolve: () => void; signal: AbortSignal; abort: () => void }[] = [];
  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.active >= 4)
      await new Promise<void>((resolve, reject) => {
        const item = {
          resolve,
          signal,
          abort: () => {
            this.waiting = this.waiting.filter((v) => v !== item);
            reject(signal.reason);
          },
        };
        this.waiting.push(item);
        signal.addEventListener('abort', item.abort, { once: true });
      });
    else this.active++;
    try {
      signal.throwIfAborted();
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        next.signal.removeEventListener('abort', next.abort);
        next.resolve();
      } else this.active--;
    }
  }
}
