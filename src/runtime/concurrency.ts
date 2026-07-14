/**
 * Concurrency primitives for bounded parallel execution.
 * Small focused module. No deps. Works with Bun.
 *
 * Use Semaphore or withBoundedConcurrency for deliberate / council / autonomy.
 */

export class Semaphore {
  private permits: number;
  private waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = Math.max(1, permits | 0);
  }

  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits--;
      return this._makeRelease();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.permits--;
        resolve(this._makeRelease());
      });
    });
  }

  /** Non-blocking acquire for gate/skip patterns (used by autonomy). Returns release or null if no permit. */
  tryAcquire(): (() => void) | null {
    if (this.permits > 0) {
      this.permits--;
      return this._makeRelease();
    }
    return null;
  }

  _makeRelease() {
    return () => {
      this.permits++;
      const next = this.waiters.shift();
      if (next) next();
    };
  }

  async withPermit<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * Run mapper over items with bounded concurrency (replaces raw Promise.all + slice hacks).
 */
export async function withBoundedConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const sem = new Semaphore(limit);
  return Promise.all(items.map((item, i) => sem.withPermit(() => fn(item, i))));
}

/**
 * p-limit style concurrency limiter (preferred for ad-hoc single-fn queuing).
 * Usage:
 *   const limit = createLimiter(3);
 *   await limit(() => someAsync());
 * Prevents unbounded fanouts in autonomy, deliberate calls, etc.
 */
export function createLimiter(limit: number) {
  const sem = new Semaphore(limit);
  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return sem.withPermit(fn);
  };
}
