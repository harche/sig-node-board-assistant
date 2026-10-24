import { describe, expect, it } from "vitest";
import { MAX_REQUEST_CHARS, shrink, size } from "../src/core/fit";
import { JevClient } from "../src/core/jev";

describe("shrink", () => {
  it("leaves what fits alone", () => {
    const x = { a: "short", b: [1, 2, 3] };
    expect(shrink(x, 1000)).toBe(x);
  });
  it("cuts the biggest parts until it fits: a long text keeps its ends, a long list its first and newest", () => {
    const x = {
      title: "t",
      pr: { events: Array.from({ length: 400 }, (_, i) => ({ n: i, body: "r".repeat(2000) })) },
      description: `start ${"d".repeat(300_000)} end`,
    };
    const out = shrink(x, 200_000);
    expect(size(out)).toBeLessThanOrEqual(200_000);
    expect(out.title).toBe("t");
    expect(out.description.startsWith("start")).toBe(true);
    expect(out.description.endsWith("end")).toBe(true);
    const ev = out.pr.events as unknown[];
    expect(ev[0]).toEqual({ n: 0, body: "r".repeat(2000) });
    expect(ev.at(-1)).toEqual({ n: 399, body: "r".repeat(2000) });
    expect(ev).toContainEqual(expect.stringMatching(/left out here/));
    expect(size(x.description)).toBeGreaterThan(300_000); // the input is untouched
  });
});

describe("JevClient request guard", () => {
  it("sends a state that leaves room for the questions within MAX_REQUEST_CHARS", async () => {
    let sent = 0;
    const fetchFn = (async (_u: unknown, init?: RequestInit) => {
      sent = String(init?.body ?? "").length;
      return new Response(
        JSON.stringify({ answers: { q: { type: "noul", noul: 0.5 } }, usage: { input_tokens: 1 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const jev = new JevClient({ apiKey: "k", provider: "openrouter", backoffMs: 0 }, fetchFn);
    const questions = { q: { type: "noul", instructions: { question: "x".repeat(100_000) } } };
    await jev.ask({ thread: Array.from({ length: 1000 }, () => "c".repeat(1000)) }, questions);
    expect(sent).toBeGreaterThan(MAX_REQUEST_CHARS * 0.8);
    expect(sent).toBeLessThanOrEqual(MAX_REQUEST_CHARS + 1000);
  });
});
