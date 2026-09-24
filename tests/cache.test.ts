import { describe, expect, it } from "vitest";
import { Cache, MemoryStore } from "../src/core/cache";

describe("Cache", () => {
  it("serves within TTL, refetches after", async () => {
    let now = 1000;
    const c = new Cache(new MemoryStore(), () => now);
    let n = 0;
    const fn = async () => ++n;
    expect(await c.cached("k", 100, fn)).toBe(1);
    expect(await c.cached("k", 100, fn)).toBe(1);
    now += 101;
    expect(await c.cached("k", 100, fn)).toBe(2);
  });
  it("joins an in-flight fetch instead of fetching twice", async () => {
    const c = new Cache(new MemoryStore());
    let n = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fn = async () => {
      n++;
      await gate;
      return n;
    };
    const a = c.cached("k", 1000, fn);
    const b = c.cached("k", 1000, fn);
    release();
    expect(await Promise.all([a, b])).toEqual([1, 1]);
    expect(n).toBe(1);
  });
  it("refresh bypasses the stored value", async () => {
    const c = new Cache(new MemoryStore());
    let n = 0;
    const fn = async () => ++n;
    await c.cached("k", 1000, fn);
    expect(await c.cached("k", 1000, fn, true)).toBe(2);
  });
});
