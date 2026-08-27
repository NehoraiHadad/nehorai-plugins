/**
 * Promise-chaining mutex keyed by an arbitrary string.
 *
 * The in-memory repository has no database to serialise it, but its critical
 * sections still span `await` points — and every `await` is a scheduling point
 * where another caller can interleave. Without a lock, "read balance, then
 * write balance" in one method is exactly the lost update the SQL adapter uses
 * row locks to prevent, so contract tests would pass in memory and fail in
 * production. This models those row locks.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  /**
   * Run `fn` with exclusive access to `key`.
   *
   * Callers queue in arrival order. The stored tail settles either way, so one
   * caller throwing does not wedge the queue behind it.
   */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(key, tail);

    try {
      return await result;
    } finally {
      // Drop the entry once we are the last waiter, so the map does not grow
      // one permanent entry per user id ever seen.
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}
