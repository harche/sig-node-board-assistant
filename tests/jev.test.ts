import { describe, expect, it } from "vitest";
import { JevClient, retryAfter } from "../src/core/jev";

const okResponse = (answers: unknown) =>
  new Response(JSON.stringify({ answers, usage: { input_tokens: 100, output_tokens: 5 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("JevClient", () => {
  it("escapes slashes in the request body and prices usage", async () => {
    let body = "";
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      body = String(init?.body);
      return okResponse({ q: { type: "noul", noul: 0.5 } });
    }) as typeof fetch;
    const jev = new JevClient({ apiKey: "k" }, fetchFn);
    const r = await jev.ask({ path: "/etc/hosts" }, { q: { type: "noul", instructions: { question: "?" } } });
    expect(body).toContain("\\/etc\\/hosts");
    expect(body).not.toContain('"/etc');
    expect(r.usage.cost).toBeCloseTo((100 * 0.042) / 1e6);
  });

  it("calls OpenRouter's System One endpoint unescaped, with its model, and takes its reported cost", async () => {
    let url = "";
    let body = "";
    const fetchFn = (async (u: unknown, init?: RequestInit) => {
      url = String(u);
      body = String(init?.body);
      return new Response(
        JSON.stringify({
          answers: { q: { type: "noul", noul: 0.5 } },
          usage: { input_tokens: 100, output_tokens: 5, cost: 0.00001 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const jev = new JevClient({ apiKey: "k", provider: "openrouter" }, fetchFn);
    const r = await jev.ask({ path: "/etc/hosts" }, { q: { type: "noul", instructions: { question: "?" } } });
    expect(url).toBe("https://openrouter.ai/api/v1/systemone");
    expect(body).toContain('"/etc/hosts"');
    expect(body).toContain("~typesafe/jev-latest");
    expect(r.usage.cost).toBe(0.00001);
  });

  it("asks Jev every time: the same question twice is two calls", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return okResponse({ q: { type: "noul", noul: 0.9 } });
    }) as typeof fetch;
    const jev = new JevClient({ apiKey: "k" }, fetchFn);
    await jev.ask({ a: 1 }, { q: {} });
    const b = await jev.ask({ a: 1 }, { q: {} });
    expect(calls).toBe(2);
    expect(b.usage.cost).toBeGreaterThan(0);
    expect(jev.ledger).toMatchObject({ calls: 2, input_tokens: 200 });
  });

  it("retries with backoff on server errors and gives up with a clear message", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response("boom", { status: 502 });
    }) as typeof fetch;
    const jev = new JevClient({ apiKey: "k", backoffMs: 0 }, fetchFn);
    await expect(jev.ask({}, { q: {} }, 3)).rejects.toThrow(/Jev failed after 3 attempts/);
    expect(calls).toBe(3);
  });

  it("waits out a rate limit longer, honouring Retry-After", async () => {
    let calls = 0;
    const fetchFn = (async () =>
      ++calls < 6
        ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } })
        : okResponse({ q: { type: "noul", noul: 0.5 } })) as typeof fetch;
    const jev = new JevClient({ apiKey: "k", backoffMs: 0 }, fetchFn);
    // Five 429s would exhaust the 4 attempts other failures get; a rate limit gets RATE_LIMIT_ATTEMPTS.
    await expect(jev.ask({}, { q: {} }, 4)).resolves.toMatchObject({ answers: { q: { noul: 0.5 } } });
    expect(calls).toBe(6);
    expect(retryAfter("2")).toBe(2000);
    expect(retryAfter("600")).toBe(60_000);
    expect(retryAfter(null)).toBeUndefined();
  });

  it("keeps the body of a non-JSON error response", async () => {
    const fetchFn = (async () =>
      new Response("<html>Just a moment...</html>", { status: 403 })) as typeof fetch;
    const jev = new JevClient({ apiKey: "k", backoffMs: 0 }, fetchFn);
    await expect(jev.ask({}, { q: {} })).rejects.toThrow(/403: <html>Just a moment/);
  });

  it("stops after the last failed attempt", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response("boom", { status: 502 });
    }) as typeof fetch;
    const jev = new JevClient({ apiKey: "k", backoffMs: 0 }, fetchFn);
    await expect(jev.ask({}, { q: {} }, 2)).rejects.toThrow(/after 2 attempts: TypeSafe HTTP 502: boom/);
    expect(calls).toBe(2);
  });

  it("does not retry a 401", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: "bad key" }), { status: 401 });
    }) as typeof fetch;
    const jev = new JevClient({ apiKey: "k", backoffMs: 0 }, fetchFn);
    await expect(jev.ask({}, { q: {} })).rejects.toThrow(/401/);
    expect(calls).toBe(1);
  });

  it("retries a malformed 200 and counts only the attempts actually made", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response("<html>proxy</html>", { status: 200 });
    }) as typeof fetch;
    const jev = new JevClient({ apiKey: "k", backoffMs: 0 }, fetchFn);
    await expect(jev.ask({}, { q: {} }, 3)).rejects.toThrow(/after 3 attempts: TypeSafe: malformed/);
    expect(calls).toBe(3);
  });

  it("does not retry or claim retries for a request the SDK rejects before sending", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return okResponse({});
    }) as typeof fetch;
    const jev = new JevClient({ apiKey: "k", backoffMs: 0 }, fetchFn);
    const err = jev.ask({}, {});
    await expect(err).rejects.toThrow(/^TypeSafe: /);
    await expect(err).rejects.not.toThrow(/attempts/);
    expect(calls).toBe(0);
  });

  it("waits the Retry-After a 429 asks for", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return calls === 1
        ? new Response("slow down", { status: 429, headers: { "retry-after": "1" } })
        : okResponse({ q: { type: "noul", noul: 0.5 } });
    }) as typeof fetch;
    const jev = new JevClient({ apiKey: "k", backoffMs: 0 }, fetchFn);
    const started = Date.now();
    await jev.ask({}, { q: {} });
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
  });

  it("refuses to construct without a key", () => {
    expect(() => new JevClient({ apiKey: "" })).toThrow(/no TypeSafe key/);
  });
});
