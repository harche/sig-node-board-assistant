import { describe, expect, it } from "vitest";
import { Cache, MemoryStore } from "../src/core/cache";
import { JevClient, stableStringify } from "../src/core/jev";

const okResponse = (answers: unknown) =>
  new Response(JSON.stringify({ answers, usage: { input_tokens: 100, output_tokens: 5 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const noBackoff = { backoffInitialMs: 0, backoffMaxMs: 0 };

describe("JevClient", () => {
  it("escapes slashes in the request body and prices usage", async () => {
    let body = "";
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      body = String(init?.body);
      return okResponse({ q: { type: "noul", noul: 0.5 } });
    }) as typeof fetch;
    const jev = new JevClient({ apiKey: "k" }, new Cache(new MemoryStore()), fetchFn);
    const r = await jev.ask({ path: "/etc/hosts" }, { q: { type: "noul", instructions: { question: "?" } } });
    expect(body).toContain("\\/etc\\/hosts");
    expect(body).not.toContain('"/etc');
    expect(r.usage.cost).toBeCloseTo((100 * 0.042) / 1e6);
  });

  it("askCached hits the cache on the second call and reports zero cost", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return okResponse({ q: { type: "noul", noul: 0.9 } });
    }) as typeof fetch;
    const jev = new JevClient({ apiKey: "k" }, new Cache(new MemoryStore()), fetchFn);
    const a = await jev.askCached({ b: 1, a: 2 }, { q: {} });
    const b = await jev.askCached({ a: 2, b: 1 }, { q: {} }); // same state, different key order
    expect(calls).toBe(1);
    expect(a.usage.cached).toBeUndefined();
    expect(b.usage).toMatchObject({ cached: true, cost: 0 });
    expect(jev.ledger).toMatchObject({ calls: 2, cached: 1 });
  });

  it("retries with backoff on server errors and gives up with a clear message", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response("boom", { status: 502 });
    }) as typeof fetch;
    const jev = new JevClient({ apiKey: "k", retry: noBackoff }, new Cache(new MemoryStore()), fetchFn);
    await expect(jev.askCached({}, { q: {} }, 3)).rejects.toThrow(/Jev failed after 3 attempts/);
    expect(calls).toBe(3);
  });

  it("keeps the body of a non-JSON error response", async () => {
    const fetchFn = (async () =>
      new Response("<html>Just a moment...</html>", { status: 403 })) as typeof fetch;
    const jev = new JevClient({ apiKey: "k", retry: noBackoff }, new Cache(new MemoryStore()), fetchFn);
    await expect(jev.ask({}, { q: {} })).rejects.toThrow(/403: <html>Just a moment/);
  });

  it("refresh bypasses the cached answer and stores the new one", async () => {
    let n = 0;
    const fetchFn = (async () => okResponse({ q: { type: "noul", noul: ++n / 10 } })) as typeof fetch;
    const jev = new JevClient({ apiKey: "k" }, new Cache(new MemoryStore()), fetchFn);
    await jev.askCached<{ q: { noul: number } }>({}, { q: {} });
    const b = await jev.askCached<{ q: { noul: number } }>({}, { q: {} }, 4, true);
    const c = await jev.askCached<{ q: { noul: number } }>({}, { q: {} });
    expect(n).toBe(2);
    expect(b.answers.q.noul).toBe(0.2);
    expect(c.usage.cached).toBe(true);
  });

  it("stops after the last failed attempt", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response("boom", { status: 502 });
    }) as typeof fetch;
    const jev = new JevClient({ apiKey: "k", retry: noBackoff }, new Cache(new MemoryStore()), fetchFn);
    await expect(jev.askCached({}, { q: {} }, 2)).rejects.toThrow(
      /after 2 attempts: TypeSafe HTTP 502: boom/,
    );
    expect(calls).toBe(2);
  });

  it("does not retry a 401", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: "bad key" }), { status: 401 });
    }) as typeof fetch;
    const jev = new JevClient({ apiKey: "k", retry: noBackoff }, new Cache(new MemoryStore()), fetchFn);
    await expect(jev.askCached({}, { q: {} })).rejects.toThrow(/401/);
    expect(calls).toBe(1);
  });

  it("refuses to construct without a key", () => {
    expect(() => new JevClient({ apiKey: "" }, new Cache(new MemoryStore()))).toThrow(/no TypeSafe key/);
  });

  it("stableStringify sorts keys at every level", () => {
    expect(stableStringify({ b: [{ z: 1, y: 2 }], a: null })).toBe('{"a":null,"b":[{"y":2,"z":1}]}');
  });
});
