import { describe, expect, it } from "vitest";
import { GitHubClient, GitHubError, slim } from "../src/core/github";

/** Routes by path; "/graphql" may be a function of the request's query and variables. */
function fakeFetch(
  routes: Record<
    string,
    unknown | ((url: URL, body?: { query: string; variables: Record<string, unknown> }) => unknown)
  >,
): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    const route = routes[url.pathname];
    const hit =
      typeof route === "function"
        ? (route as (u: URL, b?: unknown) => unknown)(
            url,
            init?.body ? JSON.parse(String(init.body)) : undefined,
          )
        : route;
    const headers = { "content-type": "application/json" };
    if (hit === undefined)
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers });
    return new Response(JSON.stringify(hit), { status: 200, headers });
  }) as typeof fetch & { calls: string[] };
  f.calls = calls;
  return f;
}

describe("GitHubClient", () => {
  it("reads boards with GETs and an item with one GraphQL query", async () => {
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
      "/graphql": {
        data: {
          repository: {
            issueOrPullRequest: pr({
              files: page([{ path: "test/e2e/x.go", additions: 1, deletions: 2 }]),
              reviews: page([
                review("r1", "APPROVED"),
                review("r1", "CHANGES_REQUESTED"),
                review("r2", "APPROVED"),
              ]),
            }),
          },
        },
      },
    });
    const gh = new GitHubClient("tok", f);
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
    expect(f.calls.filter((c) => !c.startsWith("GET "))).toEqual(["POST /graphql"]);
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
    const gh = new GitHubClient("tok", flaky, sleep);
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
    const rl = new GitHubClient("tok", limited, sleep);
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
    const sec = new GitHubClient("tok", burst, sleep);
    await expect(sec.viewer()).resolves.toEqual({ login: "b" });
    expect(calls).toBe(4);
    expect(sleeps.map((ms, i) => ms >= 2000 * 2 ** i && ms <= 3000 * 2 ** i)).toEqual([true, true, true]);

    calls = 0;
    const offline = (async () => {
      calls++;
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    const off = new GitHubClient("tok", offline, sleep);
    await expect(off.viewer()).rejects.toThrow(/GitHub unreachable for \/user: Failed to fetch/);
    expect(calls).toBe(1);
  });

  it("surfaces GitHub errors with the message", async () => {
    const gh = new GitHubClient("tok", fakeFetch({}));
    await expect(gh.viewer()).rejects.toThrow(GitHubError);
    await expect(gh.viewer()).rejects.toThrow(/404 for \/user: Not Found/);
  });
});

describe("slim", () => {
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
      "/graphql": {
        data: {
          repository: {
            issueOrPullRequest: pr({
              reviews: page([
                {
                  author: { login: "r" },
                  state: "COMMENTED",
                  submittedAt: "2026-09-02T00:00:00Z",
                  body: "nit",
                },
                { author: { login: "me" }, state: "PENDING", submittedAt: null, body: "draft" },
              ]),
              head: {
                nodes: [
                  {
                    commit: {
                      status: {
                        contexts: [
                          { context: "tide", state: "PENDING", description: "Needs lgtm", targetUrl: null },
                        ],
                      },
                    },
                  },
                ],
              },
            }),
          },
        },
      },
    });
    const ps = await new GitHubClient("tok", f).pullState("o/r", 1);
    expect(ps.reviews.map((r) => r.author)).toEqual(["r"]);
    expect(ps.tide).toEqual({ state: "pending", description: "Needs lgtm" });
  });
});

describe("item reads", () => {
  const one = (x: unknown) => fakeFetch({ "/graphql": { data: { repository: { issueOrPullRequest: x } } } });

  it("are made once per client and shared by everything read from them, and never kept past the client", async () => {
    const f = one(pr());
    const gh = new GitHubClient("tok", f);
    await Promise.all([
      gh.itemDetail("o/r", "PullRequest", 1),
      gh.pullState("o/r", 1),
      gh.timeline("o/r", 1),
      gh.linkedPrs("o/r", 1),
    ]);
    expect(f.calls).toEqual(["POST /graphql"]);
    await new GitHubClient("tok", f).itemDetail("o/r", "PullRequest", 1);
    expect(f.calls).toHaveLength(2);
  });

  it("are made again after a write", async () => {
    const f = fakeFetch({
      "/graphql": { data: { repository: { issueOrPullRequest: pr() } } },
      "/user": { login: "me" },
      "/repos/o/r/issues/1/comments": () => [],
    });
    const gh = new GitHubClient("tok", f);
    await gh.itemDetail("o/r", "PullRequest", 1);
    await gh.comment("o/r", 1, "/lgtm").catch(() => undefined);
    await gh.itemDetail("o/r", "PullRequest", 1);
    expect(f.calls.filter((c) => c === "POST /graphql")).toHaveLength(2);
  });

  it("shape the timeline like REST's: app logins with [bot], UTC commit times, no body on a bare review", async () => {
    const gh = new GitHubClient(
      "tok",
      one(
        pr({
          timelineItems: page([
            {
              __typename: "IssueComment",
              author: { __typename: "Bot", login: "kubernetes-prow" },
              body: "/lgtm",
              createdAt: "2026-09-01T00:00:00Z",
            },
            { __typename: "PullRequestCommit", commit: { committer: { date: "2026-09-02T05:30:00+05:30" } } },
            {
              __typename: "PullRequestReview",
              author: { __typename: "User", login: "r" },
              state: "APPROVED",
              submittedAt: "2026-09-03T00:00:00Z",
              body: "",
            },
            {
              __typename: "CrossReferencedEvent",
              actor: { login: "a" },
              createdAt: "2026-09-04T00:00:00Z",
              source: {
                __typename: "PullRequest",
                number: 9,
                title: "fix",
                state: "MERGED",
                url: "https://github.com/o/r/pull/9",
                createdAt: "c",
                body: "b",
                author: { login: "u" },
                mergedAt: "m",
              },
            },
          ]),
        }),
      ),
    );
    const tl = await gh.timeline("o/r", 1);
    expect(tl.map((e) => e.event)).toEqual(["commented", "committed", "reviewed", "cross-referenced"]);
    expect(tl[0]!.actor).toEqual({ login: "kubernetes-prow[bot]" });
    expect(tl[1]!.committer).toEqual({ date: "2026-09-02T00:00:00Z" });
    expect(tl[2]).toMatchObject({
      state: "approved",
      user: { login: "r" },
      submitted_at: "2026-09-03T00:00:00Z",
    });
    expect(tl[2]!.body).toBeUndefined();
    expect(await gh.linkedPrs("o/r", 1)).toEqual([
      {
        repository: "o/r",
        number: 9,
        title: "fix",
        author: "u",
        state: "merged",
        createdAt: "c",
        mergedAt: "m",
        body: "b",
      },
    ]);
    expect((await gh.itemDetail("o/r", "PullRequest", 1)).comments.map((c) => c.author.login)).toEqual([
      "kubernetes-prow[bot]",
    ]);
  });

  it("follow a long timeline onto its next pages", async () => {
    const queries: string[] = [];
    const f = fakeFetch({
      "/graphql": (_u: URL, b?: { query: string; variables: Record<string, unknown> }) => {
        queries.push(b!.query.trim().slice(0, 30));
        if (b!.variables.after) return { data: { node: { timelineItems: page([comment("second")]) } } };
        return {
          data: {
            repository: {
              issueOrPullRequest: issue({
                timelineItems: {
                  pageInfo: { hasNextPage: true, endCursor: "c1" },
                  nodes: [comment("first")],
                },
              }),
            },
          },
        };
      },
    });
    const d = await new GitHubClient("tok", f).itemDetail("o/r", "Issue", 2);
    expect(d.comments.map((c) => c.body)).toEqual(["first", "second"]);
    expect(queries).toHaveLength(2);
  });

  it("place an item on its boards from its project items, archived ones left out", async () => {
    const gh = new GitHubClient(
      "tok",
      one({
        __typename: "Issue",
        number: 3,
        title: "t",
        state: "OPEN",
        url: "https://github.com/o/r/issues/3",
        updatedAt: "u",
        closedAt: null,
        labels: { nodes: [{ name: "kind/bug" }] },
        assignees: { nodes: [] },
        projectItems: {
          nodes: [
            {
              id: "PVTI_1",
              databaseId: 11,
              isArchived: false,
              project: { number: 185, owner: { login: "kubernetes" } },
              status: { name: "Triage" },
            },
            {
              id: "PVTI_2",
              databaseId: 12,
              isArchived: true,
              project: { number: 151, owner: { login: "kubernetes" } },
              status: { name: "Triage" },
            },
          ],
        },
      }),
    );
    expect(await gh.boardItems("o/r", 3)).toEqual([
      {
        board: { owner: "kubernetes", number: 185 },
        item: expect.objectContaining({
          id: "PVTI_1",
          restId: 11,
          status: "Triage",
          type: "Issue",
          labels: ["kind/bug"],
        }),
      },
    ]);
  });
});

describe("GraphQL errors and limits", () => {
  const json = { "content-type": "application/json" };
  const answer = (...bodies: unknown[]) => {
    let n = 0;
    const f = (async () => {
      const b = bodies[Math.min(n++, bodies.length - 1)];
      return new Response(JSON.stringify(b), { status: 200, headers: { ...json } });
    }) as unknown as typeof fetch & { n: () => number };
    f.n = () => n;
    return f;
  };

  it("fails an item read on any error, even beside partial data", async () => {
    const f = answer({
      data: { repository: { issueOrPullRequest: { ...pr(), reviewThreads: null } } },
      errors: [{ type: "SERVICE_UNAVAILABLE", message: "timed out reading reviewThreads" }],
    });
    await expect(new GitHubClient("tok", f).itemDetail("o/r", "PullRequest", 1)).rejects.toThrow(
      /GitHub GraphQL: timed out reading reviewThreads/,
    );
  });

  it("names a missing item as a 404", async () => {
    const f = answer({
      data: { repository: { issueOrPullRequest: null } },
      errors: [
        { type: "NOT_FOUND", message: "Could not resolve to an issue or pull request with the number of 9." },
      ],
    });
    await expect(new GitHubClient("tok", f).itemDetail("o/r", "Issue", 9)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("leaves out a project the token cannot read instead of failing the lookup", async () => {
    const f = answer({
      data: {
        repository: {
          issueOrPullRequest: {
            __typename: "Issue",
            number: 3,
            title: "t",
            state: "OPEN",
            url: "u",
            updatedAt: "u",
            closedAt: null,
            labels: { nodes: [] },
            assignees: { nodes: [] },
            projectItems: {
              nodes: [
                null,
                { id: "PVTI_2", databaseId: 2, isArchived: false, project: null, status: null },
                {
                  id: "PVTI_3",
                  databaseId: 3,
                  isArchived: false,
                  project: { number: 151, owner: { login: "kubernetes" } },
                  status: { name: "Triage" },
                },
              ],
            },
          },
        },
      },
      errors: [{ type: "FORBIDDEN", message: "Resource not accessible by personal access token" }],
    });
    const on = await new GitHubClient("tok", f).boardItems("o/r", 3);
    expect(on.map((x) => x.item.restId)).toEqual([3]);
  });

  it("waits out GraphQL's rate limit, which comes back as a 200", async () => {
    const sleeps: number[] = [];
    const f = answer(
      { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] },
      { data: { repository: { issueOrPullRequest: pr() } } },
    );
    const gh = new GitHubClient("tok", f, async (ms) => void sleeps.push(ms));
    await expect(gh.itemDetail("o/r", "PullRequest", 1)).resolves.toMatchObject({ title: "t" });
    expect(f.n()).toBe(2);
    expect(sleeps).toHaveLength(1);
  });
});

describe("what an item read gives each reader", () => {
  const one = (x: unknown) => fakeFetch({ "/graphql": { data: { repository: { issueOrPullRequest: x } } } });
  const withThread = pr({
    timelineItems: page([comment("conversation")]),
    reviewThreads: page([
      {
        comments: { nodes: [{ author: { login: "r" }, body: "inline", createdAt: "2026-09-02T00:00:00Z" }] },
      },
    ]),
    files: page([{ path: "a.go", additions: 1, deletions: 0 }]),
  });

  it("reads a PR on an issue column as REST's issue endpoint did: the conversation only", async () => {
    const gh = new GitHubClient("tok", one(withThread));
    const asIssue = await gh.itemDetail("o/r", "Issue", 1);
    expect(asIssue.comments.map((c) => c.body)).toEqual(["conversation"]);
    expect(asIssue.files).toBeUndefined();
    expect(asIssue.reviewDecision).toBeUndefined();
    const asPr = await gh.itemDetail("o/r", "PullRequest", 1);
    expect(asPr.comments.map((c) => c.body)).toEqual(["conversation", "inline"]);
    expect(asPr.files).toHaveLength(1);
  });

  it("reads a PR's checks and an issue's labels with small queries of their own", async () => {
    const bodies: string[] = [];
    const f = fakeFetch({
      "/graphql": (_u: URL, b?: { query: string; variables: Record<string, unknown> }) => {
        bodies.push(b!.query);
        return b!.query.includes("labels(first: 100) { nodes { name } } } ... on PullRequest { labels")
          ? { data: { repository: { issueOrPullRequest: { labels: { nodes: [{ name: "sig/node" }] } } } } }
          : {
              data: {
                repository: {
                  pullRequest: {
                    id: "PR_1",
                    title: "t",
                    state: "OPEN",
                    mergedAt: null,
                    headRefOid: "abc",
                    changedFiles: 1,
                    files: page([{ path: "a.go" }]),
                    head: {
                      nodes: [
                        {
                          commit: {
                            status: {
                              contexts: [
                                { context: "pull-x", state: "FAILURE", description: "d", targetUrl: "u" },
                              ],
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            };
      },
    });
    const gh = new GitHubClient("tok", f);
    expect(await gh.labels("o/r", 2)).toEqual(["sig/node"]);
    expect(await gh.pullChecks("o/r", 1)).toEqual({
      sha: "abc",
      title: "t",
      state: "open",
      files: ["a.go"],
      files_total: 1,
      statuses: [{ context: "pull-x", state: "failure", description: "d", target_url: "u" }],
    });
    expect(bodies.some((q) => q.includes("timelineItems"))).toBe(false);
  });

  it("keeps a PR's diff at a commit across clients, but not one read after the head moved", async () => {
    let reads = 0;
    const routes = (head: string) =>
      fakeFetch({
        "/repos/o/r/pulls/77": () => (reads++, { head: { sha: head } }),
        "/repos/o/r/pulls/77/files": [{ filename: "a.go", status: "modified", patch: "@@" }],
      });
    expect(await new GitHubClient("tok", routes("moved")).pullDiff("o/r", 77, "s1")).toBeNull();
    expect(await new GitHubClient("tok", routes("s1")).pullDiff("o/r", 77, "s1")).toHaveLength(1);
    expect(await new GitHubClient("tok", routes("s1")).pullDiff("o/r", 77, "s1")).toHaveLength(1);
    expect(reads).toBe(2);
  });
});

const page = <N>(nodes: N[]) => ({ pageInfo: { hasNextPage: false, endCursor: "" }, nodes });
const review = (login: string, state: string) => ({
  author: { login },
  state,
  submittedAt: "2026-09-01T00:00:00Z",
  body: "",
});
const comment = (body: string) => ({
  __typename: "IssueComment",
  author: { login: "a" },
  body,
  createdAt: "2026-09-01T00:00:00Z",
});
const issue = (over: Record<string, unknown> = {}) => ({
  __typename: "Issue",
  id: "I_1",
  number: 1,
  title: "t",
  body: null,
  state: "OPEN",
  url: "https://github.com/o/r/issues/1",
  createdAt: "2026-01-01T00:00:00Z",
  closedAt: null,
  author: { login: "a" },
  milestone: null,
  labels: { nodes: [] },
  assignees: { nodes: [] },
  timelineItems: page([]),
  ...over,
});
const pr = (over: Record<string, unknown> = {}) => ({
  ...issue(),
  __typename: "PullRequest",
  id: "PR_1",
  url: "https://github.com/o/r/pull/1",
  isDraft: false,
  additions: 1,
  deletions: 2,
  mergedAt: null,
  changedFiles: 1,
  headRefOid: "abc",
  files: page([]),
  reviewThreads: page([]),
  reviews: page([]),
  commits: { nodes: [] },
  head: { nodes: [{ commit: { status: null } }] },
  ...over,
});
