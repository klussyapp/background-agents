// Shim for node:async_hooks — AsyncLocalStorage is used by the agents package.
// With nodejs_compat, AsyncLocalStorage is available globally. This shim avoids
// the bare node:async_hooks import that fails Cloudflare upload validation.
export const AsyncLocalStorage =
  (globalThis as Record<string, unknown>).AsyncLocalStorage ??
  class AsyncLocalStorage<T = unknown> {
    private _store: T | undefined;
    run<R>(store: T, fn: (...args: unknown[]) => R, ...args: unknown[]): R {
      const prev = this._store;
      this._store = store;
      try {
        return fn(...args);
      } finally {
        this._store = prev;
      }
    }
    getStore(): T | undefined {
      return this._store;
    }
  };
