import { describe, expect, it } from "vitest";
import { Cache, MemoryStore } from "../src/core/cache";
import { GitHubClient, GitHubError } from "../src/core/github";

function fakeFetch(
  routes: Record<string, unknown | ((url: URL) => unknown)>,
): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    const hit = routes[url.pathname];
    if (hit === undefined) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    const body = typeof hit === "function" ? (hit as (u: URL) => unknown)(url) : hit;
    return new Response(JSON.stringify(body), { status: 200 });
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
    expect(f.calls.some((c) => c.includes("q=status%3A%22Triage%22"))).toBe(true);
  });

  it("surfaces GitHub errors with the message", async () => {
    const gh = new GitHubClient("tok", new Cache(new MemoryStore()), fakeFetch({}));
    await expect(gh.viewer()).rejects.toThrow(GitHubError);
    await expect(gh.viewer()).rejects.toThrow(/404 for \/user: Not Found/);
  });
});
