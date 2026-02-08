/**
 * Deferred execution abstraction - framework agnostic
 *
 * Provides a way to schedule work to run after the current operation completes.
 * Different frameworks can provide their own implementations:
 * - Next.js: uses `after()` from `next/server`
 * - Generic: uses `setImmediate()` or `setTimeout()`
 * - Testing: can use synchronous execution
 */

/**
 * Interface for deferred execution
 *
 * Implementations should schedule the function to run asynchronously
 * without blocking the current operation.
 */
export interface DeferredExecutor {
  /**
   * Schedule a function to run asynchronously
   *
   * The function should be executed after the current operation completes.
   * Errors should be caught and logged, not propagated.
   *
   * @param fn - Async function to execute
   */
  defer(fn: () => Promise<void>): void;
}

/**
 * Generic deferred executor using setImmediate/setTimeout
 *
 * Works in Node.js and browser environments.
 * Suitable for non-framework environments or testing.
 */
export const genericDeferred: DeferredExecutor = {
  defer(fn: () => Promise<void>): void {
    // Use setImmediate in Node.js, setTimeout as fallback
    const scheduler = typeof setImmediate !== "undefined" ? setImmediate : setTimeout;
    scheduler(() => {
      fn().catch((error) => {
        console.error("[Credits] Deferred task error:", error);
      });
    });
  },
};

/**
 * Synchronous deferred executor
 *
 * Executes the function immediately (fire-and-forget).
 * Useful for testing or when deferred execution isn't needed.
 */
export const synchronousDeferred: DeferredExecutor = {
  defer(fn: () => Promise<void>): void {
    fn().catch((error) => {
      console.error("[Credits] Deferred task error:", error);
    });
  },
};

/**
 * Create a custom deferred executor
 *
 * Allows frameworks to provide their own scheduling mechanism.
 *
 * @example
 * ```typescript
 * // Next.js adapter
 * import { after } from 'next/server';
 *
 * const nextJsDeferred = createDeferredExecutor((fn) => after(fn));
 * ```
 *
 * @param schedule - Function that schedules async work
 * @returns DeferredExecutor instance
 */
export function createDeferredExecutor(
  schedule: (fn: () => Promise<void>) => void
): DeferredExecutor {
  return {
    defer: schedule,
  };
}

/**
 * No-op deferred executor
 *
 * Discards deferred work. Useful when you want to disable
 * background tasks (e.g., in certain test scenarios).
 */
export const noopDeferred: DeferredExecutor = {
  defer(_fn: () => Promise<void>): void {
    // Intentionally do nothing
  },
};
