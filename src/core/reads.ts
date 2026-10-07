/** Reads made once and shared, never kept for data that can change.
 *
 *  `Reads` belongs to one client, and the background makes clients per message (or per batch of messages from one
 *  click): each read is fetched once for that client's life, an in-flight read is joined, a failed one is dropped so
 *  the next caller tries again.
 *
 *  `forever` keeps what cannot change once read (a finished CI run, a PR's diff at a given commit, whether an owner
 *  is an org or a user) for the worker's life, at most FOREVER_MAX entries, the oldest dropped first. It is in memory
 *  only: chrome.storage.local's 10 MB is not for fetched data. */
export class Reads {
  private reads = new Map<string, Promise<unknown>>();

  once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const known = this.reads.get(key) as Promise<T> | undefined;
    if (known) return known;
    const p = fn();
    this.reads.set(key, p);
    p.catch(() => this.reads.get(key) === p && this.reads.delete(key));
    return p;
  }

  has(key: string): boolean {
    return this.reads.has(key);
  }

  /** After a write every read is made again: a thread read before a comment must not stand for after it. */
  clear(): void {
    this.reads.clear();
  }
}

const FOREVER_MAX = 500;
const kept = new Map<string, unknown>();

/** `fn()`'s value for `key`, read once for the worker's life when `keep(value)` says it can no longer change (a
 *  read that came back incomplete is not kept). Only for data that never changes. */
export async function forever<T>(
  key: string,
  fn: () => Promise<T>,
  keep: (v: T) => boolean = () => true,
): Promise<T> {
  if (kept.has(key)) {
    const v = kept.get(key) as T;
    kept.delete(key); // most recently used last
    kept.set(key, v);
    return v;
  }
  const v = await fn();
  if (keep(v)) {
    kept.set(key, v);
    if (kept.size > FOREVER_MAX) kept.delete(kept.keys().next().value!);
  }
  return v;
}

/** Tests only: forget what `forever` kept. */
export function forgetForever(): void {
  kept.clear();
}
