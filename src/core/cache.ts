/** TTL cache over a pluggable key-value store (chrome.storage.local in the extension, a Map in tests).
 *  One in-flight promise per key: a second caller for the same key waits for the first fetch instead of
 *  fetching twice, the same guarantee the CLI's per-key lock gives its background prefetch. */

export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

interface Envelope<T> {
  t: number;
  v: T;
}

export class MemoryStore implements KeyValueStore {
  private m = new Map<string, unknown>();
  async get(key: string) {
    return this.m.get(key);
  }
  async set(key: string, value: unknown) {
    this.m.set(key, value);
  }
  async remove(key: string) {
    this.m.delete(key);
  }
  async keys() {
    return [...this.m.keys()];
  }
}

export class Cache {
  private inflight = new Map<string, Promise<unknown>>();
  constructor(
    private store: KeyValueStore,
    private now: () => number = Date.now,
  ) {}

  async get<T>(key: string, ttlMs: number): Promise<T | undefined> {
    const e = (await this.store.get(key)) as Envelope<T> | undefined;
    if (!e || typeof e.t !== "number") return undefined;
    return this.now() - e.t < ttlMs ? e.v : undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.store.set(key, { t: this.now(), v: value } satisfies Envelope<T>);
  }

  /** `fn()` once per key per TTL. `refresh` bypasses the stored value but still joins an in-flight fetch. */
  async cached<T>(key: string, ttlMs: number, fn: () => Promise<T>, refresh = false): Promise<T> {
    if (!refresh) {
      const hit = await this.get<T>(key, ttlMs);
      if (hit !== undefined) return hit;
    }
    const running = this.inflight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const p = fn()
      .then(async (v) => {
        await this.set(key, v);
        return v;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
