import { describe, expect, it } from "vitest";
import { Cache, MemoryStore } from "../src/core/cache";
import { GitHubClient, GitHubError, slim } from "../src/core/github";

function fakeFetch(
  routes: Record<string, unknown | ((url: URL) => unknown)>,
): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    const hit = routes[url.pathname];
    const headers = { "content-type": "application/json" };
    if (hit === undefined)
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers });
    const body = typeof hit === "function" ? (hit as (u: URL) => unknown)(url) : hit;
    return new Response(JSON.stringify(body), { status: 200, headers });
  }) as typeof fetch & { calls: string[] };
  f.calls = calls;
  return f;
}

describe("GitHubClient", () => {
  it("only ever issues GET requests", async () => {
    const f = fakeFetch({
      "/users/kubernetes": { type: "Organization" },
      "/orgs/kubernetes/projectsV2/151": { title: "B", node_id: "PVT_1" },
      "/orgs/kubernetes/projectsV2/151/fields": [
        { name: "Status", node_id: "PVTSSF_1", id: 5, options: [{ name: { raw: "Triage" }, id: "o1" }] },
      ],
      "/orgs/kubernetes/projectsV2/151/items": [
        {
          id: 1,
          node_id: "PVTI_1",
          content: {
            number: 7,
            url: "https://api.github.com/repos/kubernetes/kubernetes/pulls/7",
            html_url: "https://github.com/kubernetes/kubernetes/pull/7",
            title: "t",
            state: "open",
            labels: [{ name: "lgtm" }],
            assignees: [],
            updated_at: "2026-01-01T00:00:00Z",
          },
        },
        { id: 2, node_id: "PVTI_2", content: { number: null } },
      ],
      "/repos/kubernetes/kubernetes/issues/7": {
        title: "t",
        body: null,
        labels: [],
        state: "open",
        user: { login: "a" },
        created_at: "2026-01-01T00:00:00Z",
        html_url: "https://github.com/kubernetes/kubernetes/pull/7",
      },
      "/repos/kubernetes/kubernetes/issues/7/comments": [],
      "/repos/kubernetes/kubernetes/pulls/7": { draft: false, additions: 1, deletions: 2 },
      "/repos/kubernetes/kubernetes/pulls/7/files": [
        { filename: "test/e2e/x.go", additions: 1, deletions: 2 },
      ],
      "/repos/kubernetes/kubernetes/pulls/7/reviews": [
        { state: "APPROVED", user: { login: "r1" } },
        { state: "CHANGES_REQUESTED", user: { login: "r1" } },
        { state: "APPROVED", user: { login: "r2" } },
      ],
      "/repos/kubernetes/kubernetes/pulls/7/comments": [],
    });
    const gh = new GitHubClient("tok", new Cache(new MemoryStore()), f);
    const board = { owner: "kubernetes", number: 151 };
    const fields = await gh.fields(board);
    expect(fields.options).toEqual({ Triage: "o1" });
    const items = await gh.itemsIn(board, "Triage");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      restId: 1,
      type: "PullRequest",
      repository: "kubernetes/kubernetes",
      labels: ["lgtm"],
    });
    const d = await gh.itemDetail("kubernetes/kubernetes", "PullRequest", 7);
    expect(d.reviewDecision).toBe("CHANGES_REQUESTED"); // r1's latest review wins
    expect(d.files).toEqual([{ path: "test/e2e/x.go", additions: 1, deletions: 2 }]);
    expect(f.calls.every((c) => c.startsWith("GET "))).toBe(true);
    expect(f.calls.some((c) => /q=status(%3A|:)(%22|")Triage(%22|")/.test(c))).toBe(true);
  });

  it("retries a 5xx, but not a 429 or a network failure", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    const json = { "content-type": "application/json" };

    let calls = 0;
    const flaky = (async () =>
      ++calls < 3
        ? new Response(JSON.stringify({ message: "Bad Gateway" }), { status: 502, headers: json })
        : new Response(JSON.stringify({ login: "a" }), { status: 200, headers: json })) as typeof fetch;
    const gh = new GitHubClient("tok", new Cache(new MemoryStore()), flaky, sleep);
    await expect(gh.viewer()).resolves.toEqual({ login: "a" });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([500, 1000]);

    calls = 0;
    const limited = (async () => {
      calls++;
      return new Response(JSON.stringify({ message: "rate limited" }), {
        status: 429,
        headers: { ...json, "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" },
      });
    }) as typeof fetch;
    const rl = new GitHubClient("tok", new Cache(new MemoryStore()), limited, sleep);
    await expect(rl.viewer()).rejects.toThrow(/429 for \/user: rate limited \(rate limit resets/);
    expect(calls).toBe(1);

    // A secondary limit (no reset given) is backed off and retried: 2s, 4s … with jitter.
    calls = 0;
    sleeps.length = 0;
    const burst = (async () =>
      ++calls < 4
        ? new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit" }), {
            status: 403,
            headers: json,
          })
        : new Response(JSON.stringify({ login: "b" }), { status: 200, headers: json })) as typeof fetch;
    const sec = new GitHubClient("tok", new Cache(new MemoryStore()), burst, sleep);
    await expect(sec.viewer()).resolves.toEqual({ login: "b" });
    expect(calls).toBe(4);
    expect(sleeps.map((ms, i) => ms >= 2000 * 2 ** i && ms <= 3000 * 2 ** i)).toEqual([true, true, true]);

    calls = 0;
    const offline = (async () => {
      calls++;
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    const off = new GitHubClient("tok", new Cache(new MemoryStore()), offline, sleep);
    await expect(off.viewer()).rejects.toThrow(/GitHub unreachable for \/user: Failed to fetch/);
    expect(calls).toBe(1);
  });

  it("surfaces GitHub errors with the message", async () => {
    const gh = new GitHubClient("tok", new Cache(new MemoryStore()), fakeFetch({}));
    await expect(gh.viewer()).rejects.toThrow(GitHubError);
    await expect(gh.viewer()).rejects.toThrow(/404 for \/user: Not Found/);
  });
});

describe("slim (cached timelines)", () => {
  it("keeps only the events and fields the extension reads, with bodies cut", () => {
    const raw = [
      { event: "subscribed", created_at: "t", actor: { login: "a", id: 1, avatar_url: "x" } },
      {
        event: "cross-referenced",
        created_at: "t",
        actor: { login: "a", id: 1 },
        source: {
          issue: {
            number: 5,
            title: "fix",
            state: "closed",
            html_url: "https://github.com/o/r/pull/5",
            created_at: "c",
            body: "b".repeat(5000),
            user: { login: "u", id: 2 },
            pull_request: { merged_at: "m", url: "x" },
            labels: [{ name: "big" }],
          },
        },
      },
      { event: "commented", created_at: "t", user: { login: "u", site_admin: false }, body: "c".repeat(900) },
    ];
    const s = slim(raw as never);
    expect(s.map((e) => e.event)).toEqual(["cross-referenced", "commented"]);
    expect(s[0]!.source!.issue!.body).toHaveLength(1000);
    expect(s[0]!.source!.issue).not.toHaveProperty("labels");
    expect(s[0]!.actor).toEqual({ login: "a" });
    expect(s[1]!.body).toHaveLength(300);
  });
});

describe("pullState", () => {
  it("leaves out a pending review, which has no date", async () => {
    const f = fakeFetch({
      "/repos/o/r/pulls/1": {
        state: "open",
        merged_at: null,
        draft: false,
        created_at: "2026-09-01T00:00:00Z",
        user: { login: "a" },
        labels: [],
        head: { sha: "abc" },
      },
      "/repos/o/r/pulls/1/reviews": [
        { user: { login: "r" }, state: "COMMENTED", submitted_at: "2026-09-02T00:00:00Z", body: "nit" },
        { user: { login: "me" }, state: "PENDING", body: "draft" },
      ],
      "/repos/o/r/commits/abc/status": {
        statuses: [{ context: "tide", state: "pending", description: "Needs lgtm" }],
      },
    });
    const ps = await new GitHubClient("tok", new Cache(new MemoryStore()), f).pullState("o/r", 1);
    expect(ps.reviews.map((r) => r.author)).toEqual(["r"]);
    expect(ps.tide).toEqual({ state: "pending", description: "Needs lgtm" });
  });
});
