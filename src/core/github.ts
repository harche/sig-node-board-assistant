/** GitHub client on Octokit. An issue or pull request is read with one GraphQL query (its fields, labels,
 *  assignees, every comment and timeline event, and on a PR its files, review threads, commits and the head's
 *  statuses: about a point of the 5,000 an hour, where REST took up to eighteen requests). Project boards, files' text,
 *  PR diffs and the writes use REST. Nothing that can change is cached: the background makes a client per message
 *  (or per click's batch), and the client makes each read once and shares it, so judging a card reads it once, fresh.
 *  What cannot change (a PR's diff at a commit, an owner's type) is kept in memory (reads.ts `forever`). Octokit adds
 *  Link-header pagination; this class adds a short retry on 5xx and rate limits, and the board shapes. */
import { Octokit } from "@octokit/core";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { forever, Reads } from "./reads";
import type {
  Comment,
  LinkedPr,
  BoardFields,
  BoardItem,
  BoardRef,
  ItemDetail,
  ItemKind,
  ReviewDecision,
} from "./types";

export class GitHubError extends Error {
  constructor(
    message: string,
    public status: number,
    public rateLimitReset?: Date,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export const GITHUB_API_VERSION = "2026-03-10";

const Client = Octokit.plugin(paginateRest);
type Params = Record<string, string | number>;

/** Waits between attempts on a 5xx (reads only). Short on purpose: Chrome stops the extension's service worker
 *  after ~30s idle unless a request is in flight. Network failures are not retried. */
const RETRY_DELAYS_MS = [500, 1000];
/** Rate limits (429, or a 403 that says so) are retried for reads and writes alike: GitHub rejected the request,
 *  so repeating it cannot double a write. Callers fan out freely (a whole column, forty candidates at once) with no
 *  cap on requests in flight; a burst GitHub pushes back on is waited out: Retry-After or the limit's reset when
 *  GitHub says, else 2s, 4s … backing off, each wait up to this long, for up to RATE_LIMIT_RETRIES. The service
 *  worker stays alive while a request is in flight (background keepalive). */
const RATE_LIMIT_RETRIES = 8;
const RATE_LIMIT_MAX_WAIT_MS = 60_000;

export class GitHubClient {
  readonly octokit: InstanceType<typeof Client>;
  /** Reads this client made: each is fetched once for the client's life, never kept after. */
  private reads = new Reads();
  private sleep: (ms: number) => Promise<void>;

  constructor(
    token: string,
    // "no-cache": GitHub's reads say max-age=60, so the browser would otherwise answer a read from its HTTP cache,
    // and a thread read just before a comment was posted would come back without it. Revalidating costs a 304.
    fetchFn: typeof fetch = (input, init) => fetch(input, { ...init, cache: "no-cache" }),
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.sleep = sleep;
    this.octokit = new Client({
      auth: token || undefined,
      userAgent: "sig-node-board-assistant",
      request: { fetch: fetchFn },
      headers: { "X-GitHub-Api-Version": GITHUB_API_VERSION },
    });
    // Wraps every request, including each page octokit.paginate fetches. A 5xx is retried only for reads: a
    // write that answers 5xx may still have happened, and repeating it would post a second comment.
    this.octokit.hook.wrap("request", async (request, options) => {
      let serverErrors = 0;
      let rateLimited = 0;
      for (;;) {
        try {
          return await request(options);
        } catch (e) {
          const wait = rateLimitWait(e, rateLimited);
          if (wait !== null && rateLimited < RATE_LIMIT_RETRIES) {
            rateLimited++;
            await sleep(wait);
            continue;
          }
          const delay = RETRY_DELAYS_MS[serverErrors];
          if (options.method !== "GET" || delay === undefined || !isServerError(e)) throw e;
          serverErrors++;
          await sleep(delay);
        }
      }
    });
  }

  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.reads.once(key, fn);
  }

  /** After a write every read is made again: a thread read before a comment must not stand for after it. */
  private wrote(): void {
    this.reads.clear();
  }

  async api<T = unknown>(path: string, params: Params = {}): Promise<T> {
    try {
      return (await this.octokit.request(`GET ${path}`, params)).data as T;
    } catch (e) {
      throw toGitHubError(e, path);
    }
  }

  /** Every page of a list endpoint, following the Link header (also covers projectsV2's cursor pagination). */
  async paged<T = unknown>(path: string, params: Params = {}): Promise<T[]> {
    try {
      return (await this.octokit.paginate(`GET ${path}`, { ...params, per_page: 100 })) as T[];
    } catch (e) {
      throw toGitHubError(e, path);
    }
  }

  /** A GraphQL query (reads only). Any error fails it, unless `partial`: then what GitHub could answer comes back
   *  beside the errors (a search alias that failed, a project the token cannot read), and the caller checks for
   *  nulls. GitHub reports its GraphQL rate limit as a 200 with a RATE_LIMITED error: that is waited out like a REST
   *  limit. A 502 or 504 is GitHub timing out a heavy query: retried twice, since a read is safe to repeat (the
   *  request hook never retries a POST). */
  async graphql<T = unknown>(
    query: string,
    variables: Record<string, unknown> = {},
    partial = false,
  ): Promise<T> {
    let limited = 0;
    for (let attempt = 0; ; attempt++) {
      let r: { data: unknown; headers: Record<string, string | number | undefined> };
      try {
        r = await this.octokit.request("POST /graphql", { query, variables });
      } catch (e) {
        const status = (e as { status?: number }).status;
        if ((status === 502 || status === 504) && attempt < 2) continue;
        throw toGitHubError(e, "/graphql");
      }
      const body = r.data as { data?: T | null; errors?: { type?: string; message: string }[] };
      const errors = body.errors ?? [];
      if (errors.some((e) => e.type === "RATE_LIMITED")) {
        const reset = Number(r.headers["x-ratelimit-reset"]) || 0;
        const wait = reset
          ? reset * 1000 - Date.now() + 1000
          : Math.min(RATE_LIMIT_MAX_WAIT_MS, 2000 * 2 ** limited);
        if (limited < RATE_LIMIT_RETRIES && wait <= RATE_LIMIT_MAX_WAIT_MS) {
          limited++;
          await this.sleep(Math.max(wait, 1000));
          continue;
        }
        throw new GitHubError(
          `GitHub GraphQL rate limit${reset ? ` (resets ${new Date(reset * 1000).toLocaleTimeString()})` : ""}`,
          429,
          reset ? new Date(reset * 1000) : undefined,
        );
      }
      if (errors.length && (!partial || !body.data)) {
        const type = errors[0]?.type;
        throw new GitHubError(
          `GitHub GraphQL: ${errors.map((e) => e.message).join("; ")}`,
          type === "NOT_FOUND" ? 404 : type === "FORBIDDEN" ? 403 : 502,
        );
      }
      return body.data as T;
    }
  }

  /** An issue or pull request with everything the extension reads about it, in one GraphQL query (more pages of
   *  the timeline, files or review threads only when a long one has them). */
  item(repo: string, num: number): Promise<ItemRead> {
    return this.once(`item:${repo}#${num}`, async (): Promise<ItemRead> => {
      const [owner, name] = repo.split("/");
      const data = await this.graphql<{ repository: { issueOrPullRequest: RawItem | null } | null }>(
        ITEM_QUERY,
        {
          owner,
          name,
          number: num,
        },
      );
      const x = data.repository?.issueOrPullRequest;
      if (!x) throw new GitHubError(`GitHub 404 for ${repo}#${num}: no such issue or pull request`, 404);
      const pr = x.__typename === "PullRequest";
      // Every page, as REST read every page.
      const pages = async <N>(c: Connection<N>, field: string, args: string, fields: string) => {
        const out = [...c.nodes];
        for (let at = c.pageInfo; at.hasNextPage;) {
          const q = `query($id: ID!, $after: String!) { node(id: $id) { ... on ${x.__typename} { ${field}(first: 100, after: $after${args}) { pageInfo { hasNextPage endCursor } nodes { ${fields} } } } } }`;
          const more = await this.graphql<{ node: Record<string, Connection<N>> }>(q, {
            id: x.id,
            after: at.endCursor,
          });
          const next = more.node[field]!;
          out.push(...next.nodes);
          at = next.pageInfo;
        }
        return out;
      };
      const events = await pages(
        x.timelineItems,
        "timelineItems",
        `, itemTypes: [${pr ? PR_EVENTS : ISSUE_EVENTS}]`,
        pr ? PR_TIMELINE : ISSUE_TIMELINE,
      );
      const comments: Comment[] = events
        .filter((e): e is RawTimeline & { __typename: "IssueComment" } => e.__typename === "IssueComment")
        .map((e) => ({ author: { login: login(e.author) }, body: e.body ?? "", createdAt: e.createdAt }));
      const detail: ItemDetail = {
        title: x.title,
        body: x.body ?? "",
        labels: x.labels.nodes.map((l) => ({ name: l.name })),
        state: x.state === "OPEN" ? "open" : "closed",
        author: { login: login(x.author) },
        createdAt: x.createdAt,
        url: x.url,
        milestone: x.milestone?.title ?? null,
        closedAt: x.closedAt ?? null,
        assignees: x.assignees.nodes.map((a) => a.login),
        comments: [...comments],
      };
      const timeline = slim(events.map(restEvent).filter((e): e is TimelineEvent => e !== null));
      // As REST's issue endpoint has it: what an issue workflow reads about a PR on its column.
      const conversation: ItemDetail = { ...detail, comments: [...comments] };
      if (!pr) return { kind: "Issue", detail, conversation, timeline, comments };
      const p = x as RawPullRequest;
      // The reviews connection, not the timeline: the timeline leaves out the author's replies in review threads.
      const [files, threads, allReviews] = await Promise.all([
        pages(p.files, "files", "", FILE_FIELDS),
        pages(p.reviewThreads, "reviewThreads", "", THREAD_FIELDS),
        pages(p.reviews, "reviews", "", REVIEW_FIELDS),
      ]);
      const reviews = allReviews
        // A pending (unsubmitted) review of the token's owner has no date and is nobody's move yet.
        .filter((r) => r.author && r.state !== "PENDING" && r.submittedAt)
        .map((r) => ({ author: login(r.author), state: r.state, at: r.submittedAt!, body: r.body ?? "" }));
      detail.isDraft = p.isDraft;
      detail.additions = p.additions;
      detail.deletions = p.deletions;
      detail.files = files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions }));
      detail.reviewDecision = decision(reviews);
      detail.comments.push(
        ...threads.flatMap((t) =>
          t.comments.nodes.map((c) => ({
            author: { login: login(c.author) },
            body: c.body ?? "",
            createdAt: c.createdAt,
          })),
        ),
      );
      detail.comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const head = p.head.nodes[0]?.commit;
      const dates = p.commits.nodes
        .map((c) => c.commit.committedDate)
        .filter(Boolean)
        .sort();
      return {
        kind: "PullRequest",
        detail,
        conversation,
        timeline,
        comments,
        pull: {
          state: p.mergedAt ? "merged" : p.state === "OPEN" ? "open" : "closed",
          sha: p.headRefOid,
          changedFiles: p.changedFiles,
          lastCommit: dates.at(-1) ?? null,
          reviews,
          // By context: GraphQL and REST list them in different orders.
          statuses: statuses(head?.status),
        },
      };
    });
  }

  /** The pull request read, or an error naming what it is instead. */
  private async pull(repo: string, num: number): Promise<ItemRead & { pull: PullRead }> {
    const r = await this.item(repo, num);
    if (!r.pull) throw new GitHubError(`${repo}#${num} is an issue, not a pull request`, 404);
    return r as ItemRead & { pull: PullRead };
  }

  /** A pull request's state for the Needs Reviewer checks: the PR, its reviews, and Prow's tide status on the
   *  head commit (tide's description says what still blocks the merge). */
  async pullState(repo: string, num: number): Promise<PullState> {
    const { detail: d, pull: p } = await this.pull(repo, num);
    const tide = p.statuses.find((x) => x.context === "tide");
    return {
      state: p.state,
      draft: Boolean(d.isDraft),
      author: d.author.login,
      created_at: d.createdAt,
      labels: d.labels.map((l) => l.name),
      tide: tide ? { state: tide.state, description: tide.description } : null,
      failing: p.statuses
        .filter((x) => x.context !== "tide" && (x.state === "failure" || x.state === "error"))
        .map((x) => x.context),
      reviews: p.reviews.map((r) => ({ ...r, body: r.body.slice(0, 600) })),
    };
  }

  /** The pull request's diff file by file, each patch cut at PATCH_MAX (null for a binary file or one GitHub will not
   *  diff). null when the head is no longer `sha`: a diff read after a push is not the one the run tested. REST: the
   *  GraphQL API has no patches. */
  pullDiff(repo: string, num: number, sha: string): Promise<ChangedFile[] | null> {
    // A diff at a commit never changes: kept, unless the head had moved on (null).
    return forever(
      `diff:${repo}#${num}@${sha}`,
      async () => {
        const [pr, files] = await Promise.all([
          this.api<{ head: { sha: string } }>(`/repos/${repo}/pulls/${num}`),
          this.paged<{ filename: string; status: string; patch?: string }>(
            `/repos/${repo}/pulls/${num}/files`,
          ),
        ]);
        if (pr.head.sha !== sha) return null;
        return files.map((f) => ({
          file: f.filename,
          status: f.status,
          patch:
            f.patch === undefined
              ? null
              : f.patch.length > PATCH_MAX
                ? `${f.patch.slice(0, PATCH_MAX)}\n…cut`
                : f.patch,
        }));
      },
      (v) => v !== null,
    );
  }

  /** What the PR page's CI check reads about a pull request: its head commit, title and changed paths, and every
   *  status on the head commit (the newest per context). */
  async pullChecks(repo: string, num: number): Promise<PullChecks> {
    if (this.reads.has(`item:${repo}#${num}`)) {
      const { detail: d, pull: p } = await this.pull(repo, num);
      return {
        sha: p.sha,
        title: d.title,
        state: p.state,
        files: (d.files ?? []).map((f) => f.path).slice(0, 300),
        files_total: p.changedFiles,
        statuses: p.statuses,
      };
    }
    // Only what the check needs: no timeline, no review threads.
    return this.once(`checks:${repo}#${num}`, async () => {
      const [owner, name] = repo.split("/");
      const data = await this.graphql<{ repository: { pullRequest: RawChecks | null } | null }>(
        CHECKS_QUERY,
        {
          owner,
          name,
          number: num,
        },
      );
      const x = data.repository?.pullRequest;
      if (!x) throw new GitHubError(`GitHub 404 for ${repo}#${num}: no such pull request`, 404);
      const files = [...x.files.nodes];
      for (let at = x.files.pageInfo; at.hasNextPage && files.length < 300;) {
        const more = await this.graphql<{ node: { files: Connection<{ path: string }> } }>(
          CHECKS_FILES_QUERY,
          {
            id: x.id,
            after: at.endCursor,
          },
        );
        files.push(...more.node.files.nodes);
        at = more.node.files.pageInfo;
      }
      return {
        sha: x.headRefOid,
        title: x.title,
        state: x.mergedAt ? "merged" : x.state === "OPEN" ? "open" : "closed",
        files: files.map((f) => f.path).slice(0, 300),
        files_total: x.changedFiles,
        statuses: statuses(x.head.nodes[0]?.commit.status),
      };
    });
  }

  /** An issue's or PR's labels: what the issue page's checks look at before offering themselves. */
  labels(repo: string, num: number): Promise<string[]> {
    return this.once(`labels:${repo}#${num}`, async () => {
      const [owner, name] = repo.split("/");
      const data = await this.graphql<{
        repository: { issueOrPullRequest: { labels: { nodes: { name: string }[] } } | null } | null;
      }>(LABELS_QUERY, { owner, name, number: num });
      const x = data.repository?.issueOrPullRequest;
      if (!x) throw new GitHubError(`GitHub 404 for ${repo}#${num}: no such issue or pull request`, 404);
      return x.labels.nodes.map((l) => l.name);
    });
  }

  /** A file's text on the default branch (OWNERS, OWNERS_ALIASES); null when it does not exist. */
  rawFile(repo: string, path: string): Promise<string | null> {
    return this.once(`raw:${repo}:${path}`, async () => {
      try {
        const r = await this.octokit.request(`GET /repos/${repo}/contents/${path}`, {
          headers: { accept: "application/vnd.github.raw" },
        });
        return String(r.data);
      } catch (e) {
        if ((e as { status?: number }).status === 404) return null;
        throw toGitHubError(e, path);
      }
    });
  }

  /** open / closed / merged for an issue or PR another item refers to. */
  refState(repo: string, num: number): Promise<"open" | "closed" | "merged" | "missing"> {
    return this.once(`ref:${repo}#${num}`, async () => {
      const x = await this.api<{ state: string; pull_request?: { merged_at: string | null } }>(
        `/repos/${repo}/issues/${num}`,
      ).catch(() => null);
      if (!x) return "missing";
      return x.pull_request?.merged_at ? "merged" : x.state === "closed" ? "closed" : "open";
    });
  }

  /** Who the token belongs to; the options page's "test" button, and who a comment would come from. */
  viewer(): Promise<{ login: string }> {
    return this.once("viewer", () => this.api<{ login: string }>("/user"));
  }

  /** 'orgs' or 'users' for the REST projectsV2 routes. */
  ownerType(owner: string): Promise<"orgs" | "users"> {
    // An account does not turn from an org into a user: kept.
    return forever(`ownertype:${owner}`, async () => {
      const u = await this.api<{ type: string }>(`/users/${owner}`);
      return u.type === "Organization" ? "orgs" : "users";
    });
  }

  async projectPath(board: BoardRef): Promise<string> {
    return `/${await this.ownerType(board.owner)}/${board.owner}/projectsV2/${board.number}`;
  }

  /** Project node id, Status field ids and option ids: what a Status move needs, and what the proposed `gh`
   *  command shows. */
  fields(board: BoardRef): Promise<BoardFields> {
    return this.once(`fields:${board.owner}/${board.number}`, async () => {
      const base = await this.projectPath(board);
      const proj = await this.api<{ title: string; node_id: string }>(base);
      const fl = await this.paged<{
        name: string;
        node_id: string;
        id: number;
        options?: { name: { raw: string }; id: string }[];
      }>(`${base}/fields`);
      const st = fl.find((f) => f.name === "Status");
      if (!st) throw new GitHubError("board has no Status field", 404);
      return {
        title: proj.title,
        project_id: proj.node_id,
        status_field_id: st.node_id,
        status_field_rest_id: st.id,
        options: Object.fromEntries((st.options ?? []).map((o) => [o.name.raw, o.id])),
      };
    });
  }

  /** Moves a project item to the Status column `lane` (REST: PATCH the item's Status field to the option id). */
  async moveItem(board: BoardRef, restId: number, lane: string): Promise<void> {
    const f = await this.fields(board);
    const option = f.options[lane];
    if (!option) throw new GitHubError(`board has no Status column named '${lane}'`, 404);
    const path = `${await this.projectPath(board)}/items/${restId}`;
    try {
      await this.octokit.request(`PATCH ${path}`, {
        fields: [{ id: f.status_field_rest_id, value: option }],
      });
    } catch (e) {
      throw toGitHubError(e, path);
    } finally {
      this.wrote();
    }
  }

  /** The issue or PR behind one project item: what a write is checked against. */
  async projectItem(board: BoardRef, restId: number): Promise<{ repository: string; number: number } | null> {
    const it = await this.api<RawProjectItem>(`${await this.projectPath(board)}/items/${restId}`);
    const c = it.content;
    if (!c?.number) return null;
    return { repository: c.html_url.split("/").slice(3, 5).join("/"), number: c.number };
  }

  /** Issues matching each search query, at most `n` each. A plain query is a keyword search, newest-updated first;
   *  `{ q, type }` asks GitHub's semantic or hybrid (semantic and keyword) search, best match first. One GraphQL
   *  request carries every query (aliased searches cost about one point of the 5,000 an hour, and do not count
   *  against REST search's 30 a minute). */
  async searchIssues(queries: SearchQuery[], n = 10): Promise<RawSearchIssue[][]> {
    const norm = (x: SearchQuery) => (typeof x === "string" ? { q: x, type: "ISSUE" as const } : x);
    const id = (x: SearchQuery) => {
      const { q, type } = norm(x);
      return type === "ISSUE" ? q : `${type}|${q}`;
    };
    const out = new Map<string, RawSearchIssue[]>();
    const todo = [...new Map(queries.map((x) => [id(x), norm(x)])).values()];
    if (todo.length) {
      const fields =
        "nodes { ... on Issue { number title state closedAt createdAt updatedAt url body author { login } assignees(first: 5) { nodes { login } } } }";
      const query = `query(${todo.map((_, i) => `$q${i}: String!`).join(", ")}) { ${todo
        .map((x, i) => `s${i}: search(query: $q${i}, type: ${x.type}, first: ${n}) { ${fields} }`)
        .join(" ")} }`;
      type Node = {
        number?: number;
        title: string;
        state: string;
        closedAt: string | null;
        createdAt: string;
        updatedAt: string;
        url: string;
        body: string;
        author: { login: string } | null;
        assignees: { nodes: { login: string }[] } | null;
      };
      const data = await this.graphql<Record<string, { nodes: Node[] }>>(
        query,
        // Keyword searches newest first; semantic and hybrid keep their own ranking.
        Object.fromEntries(
          todo.map((x, i) => [`q${i}`, x.type === "ISSUE" ? `${x.q} sort:updated-desc` : x.q]),
        ),
        // A failed alias comes back null beside the others: partial, and checked below.
        true,
      );
      for (const [i, x] of todo.entries()) {
        // A failed alias comes back null beside the others' data: an error, not "nothing found".
        const hit = data[`s${i}`];
        if (!hit) throw new Error(`GitHub search failed for: ${x.q}`);
        out.set(
          id(x),
          hit.nodes
            .filter((y) => y.number)
            .map((y) => ({
              number: y.number!,
              title: y.title,
              state: y.state.toLowerCase() as "open" | "closed",
              closed_at: y.closedAt,
              html_url: y.url,
              body: (y.body ?? "").slice(0, 3000),
              created_at: y.createdAt,
              updated_at: y.updatedAt,
              author: y.author?.login ?? "ghost",
              assignees: (y.assignees?.nodes ?? []).map((a) => a.login),
            })),
        );
      }
    }
    return queries.map((x) => out.get(id(x)) ?? []);
  }

  /** Issues with their recent thread, by number, in one GraphQL request (pull requests and missing numbers come back
   *  null). For the duplicates check: each candidate's title, body, labels and last 15 comments. */
  async issueThreads(repo: string, numbers: number[]): Promise<Map<number, ThreadIssue | null>> {
    const out = new Map<number, ThreadIssue | null>();
    const todo = [...new Set(numbers)];
    const [owner, name] = repo.split("/");
    for (let i = 0; i < todo.length; i += 25) {
      const chunk = todo.slice(i, i + 25);
      const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${chunk
        .map(
          (n) =>
            `i${n}: issueOrPullRequest(number: ${n}) { __typename ... on Issue { number title body state createdAt closedAt url author { login } labels(first: 20) { nodes { name } } comments(last: 15) { nodes { author { login } body createdAt } } } }`,
        )
        .join(" ")} } }`;
      type Node = {
        __typename: string;
        number: number;
        title: string;
        body: string;
        state: string;
        createdAt: string;
        closedAt: string | null;
        url: string;
        author: { login: string } | null;
        labels: { nodes: { name: string }[] };
        comments: { nodes: { author: { login: string } | null; body: string; createdAt: string }[] };
      };
      // A number that is no issue comes back null beside a NOT_FOUND error: partial.
      const data = await this.graphql<{ repository: Record<string, Node | null> }>(
        query,
        { owner, name },
        true,
      );
      for (const n of chunk) {
        const x = data.repository?.[`i${n}`];
        out.set(
          n,
          x && x.__typename === "Issue"
            ? {
                number: x.number,
                title: x.title,
                body: (x.body ?? "").slice(0, 6000),
                state: x.state.toLowerCase() as "open" | "closed",
                created_at: x.createdAt,
                closed_at: x.closedAt,
                url: x.url,
                author: x.author?.login ?? "ghost",
                labels: x.labels.nodes.map((l) => l.name),
                comments: x.comments.nodes.map((c) => ({
                  author: c.author?.login ?? "ghost",
                  body: (c.body ?? "").slice(0, 2000),
                  created_at: c.createdAt,
                })),
              }
            : null,
        );
      }
    }
    return out;
  }

  /** An issue's whole body and every comment, as one text. With `mirrorRepo`, the comments on its
   *  "[mirror] <repo>#<n>" issue there too (where the TestGrid review writes while being tried out). */
  async issueText(repo: string, number: number, mirrorRepo?: string): Promise<string> {
    const { detail, comments } = await this.item(repo, number);
    const parts = [detail.body, ...comments.map((c) => c.body)];
    if (mirrorRepo) {
      const title = `[mirror] ${repo}#${number}`;
      const all = await this.paged<{ number: number; title: string }>(`/repos/${mirrorRepo}/issues`, {
        state: "all",
      });
      const m = all.find((x) => x.title === title);
      if (m) parts.push(...(await this.item(mirrorRepo, m.number)).comments.map((c) => c.body));
    }
    return parts.join("\n");
  }

  /** Creates a secret gist on the token's account (feedback's attachments); returns its URL. Needs the `gist` scope. */
  async createGist(description: string, files: Record<string, string>): Promise<string> {
    const path = "/gists";
    try {
      const r = await this.octokit.request(`POST ${path}`, {
        description,
        public: false,
        files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, { content }])),
      });
      return (r.data as { html_url: string }).html_url;
    } catch (e) {
      throw toGitHubError(e, path);
    } finally {
      this.wrote();
    }
  }

  /** Opens an issue; returns its number. */
  async createIssue(repo: string, title: string, body: string, labels: string[]): Promise<number> {
    const path = `/repos/${repo}/issues`;
    try {
      const r = await this.octokit.request(`POST ${path}`, { title, body, labels });
      return (r.data as { number: number }).number;
    } catch (e) {
      throw toGitHubError(e, path);
    } finally {
      this.wrote();
    }
  }

  /** Comments on an issue or PR (the issues comments route serves both); how Prow commands are sent. Skipped when
   *  the token's user already left the same comment, so a retry after a failed move does not post it twice. */
  async comment(repo: string, number: number, body: string): Promise<void> {
    const path = `/repos/${repo}/issues/${number}/comments`;
    const [me, existing] = await Promise.all([
      this.viewer(),
      this.paged<{ body?: string; user?: { login: string } | null }>(path),
    ]);
    if (existing.some((c) => c.user?.login === me.login && c.body?.trim() === body.trim())) return;
    try {
      await this.octokit.request(`POST ${path}`, { body });
    } catch (e) {
      throw toGitHubError(e, path);
    } finally {
      this.wrote();
    }
  }

  /** Items in one Status column via the server-side `q=status:` filter; draft issues (no content) are skipped. */
  itemsIn(board: BoardRef, status: string): Promise<BoardItem[]> {
    return this.once(`col:${board.owner}/${board.number}:${status}`, async () => {
      const base = await this.projectPath(board);
      const raw = await this.paged<RawProjectItem>(`${base}/items`, { q: `status:"${status}"` });
      const out: BoardItem[] = [];
      for (const it of raw) {
        const c = it.content;
        if (!c?.number) continue;
        const isPr = c.url.includes("/pulls/");
        out.push({
          id: it.node_id,
          restId: it.id,
          status,
          type: isPr ? "PullRequest" : "Issue",
          number: c.number,
          url: c.html_url,
          repository: c.html_url.split("/").slice(3, 5).join("/"),
          title: c.title,
          state: c.state,
          merged: Boolean(c.merged_at),
          draft: Boolean(c.draft),
          labels: (c.labels ?? []).map((l) => l.name),
          assignees: (c.assignees ?? []).map((a) => a.login),
          updatedAt: c.updated_at,
          closedAt: c.closed_at ?? null,
        });
      }
      return out;
    });
  }

  /** The board items an issue or PR has: each one's board, its Status column and the item as a column lists it, in
   *  one GraphQL query (archived items left out). A project the token cannot read comes back null beside an error;
   *  it is left out, as REST would not have listed it. */
  boardItems(repo: string, num: number): Promise<{ board: BoardRef; item: BoardItem }[]> {
    return this.once(`boarditems:${repo}#${num}`, async () => {
      const [owner, name] = repo.split("/");
      const data = await this.graphql<{ repository: { issueOrPullRequest: RawBoardContent | null } | null }>(
        BOARD_ITEMS_QUERY,
        { owner, name, number: num },
        true,
      );
      const x = data?.repository?.issueOrPullRequest;
      if (!x) return [];
      return (x.projectItems?.nodes ?? [])
        .filter((p): p is NonNullable<typeof p> =>
          Boolean(p && !p.isArchived && p.project?.owner?.login && p.status?.name),
        )
        .map((p) => ({
          board: { owner: p.project!.owner!.login!, number: p.project!.number },
          item: {
            id: p.id,
            restId: p.databaseId,
            status: p.status!.name!,
            type: x.__typename,
            number: x.number,
            url: x.url,
            repository: repo,
            title: x.title,
            state: x.state === "OPEN" ? "open" : "closed",
            merged: Boolean(x.merged),
            draft: Boolean(x.isDraft),
            labels: x.labels.nodes.map((l) => l.name),
            assignees: x.assignees.nodes.map((a) => a.login),
            updatedAt: x.updatedAt,
            closedAt: x.closedAt ?? null,
          },
        }));
    });
  }

  /** An issue's or PR's timeline, oldest first: assignments, comments, cross-references, labels, and on a PR its
   *  commits, reviews and force-pushes. Shaped like the REST timeline's events. */
  async timeline(repo: string, num: number): Promise<TimelineEvent[]> {
    return (await this.item(repo, num)).timeline;
  }

  /** When a PR's newest commit was committed, or null. */
  async prLastCommit(repo: string, num: number): Promise<string | null> {
    return (await this.pull(repo, num)).pull.lastCommit;
  }

  /** PRs that reference an issue (cross-referenced timeline events), newest reference last, deduped. */
  async linkedPrs(repo: string, num: number): Promise<LinkedPr[]> {
    const out = new Map<string, LinkedPr>();
    for (const e of await this.timeline(repo, num)) {
      const src = e.event === "cross-referenced" ? e.source?.issue : undefined;
      if (!src?.pull_request) continue;
      out.delete(src.html_url);
      out.set(src.html_url, {
        repository: src.html_url.split("/").slice(3, 5).join("/"),
        number: src.number,
        title: src.title,
        author: src.user?.login ?? "ghost",
        state: src.pull_request.merged_at ? "merged" : src.state === "closed" ? "closed" : "open",
        createdAt: src.created_at,
        mergedAt: src.pull_request.merged_at ?? null,
        body: src.body ?? "",
      });
    }
    return [...out.values()];
  }

  /** The issue or PR as the judges read it: fields, labels, assignees and comments; read as a PullRequest, also its
   *  review comments, draft flag, size, files and review decision. A PR on an issue workflow's column (DRA's, say)
   *  is read as an Issue: its conversation only, as before. */
  async itemDetail(repo: string, kind: ItemKind, num: number): Promise<ItemDetail> {
    const r = await this.item(repo, num);
    return kind === "PullRequest" ? r.detail : r.conversation;
  }
}

/** One item read: the detail, its timeline, and for a PR what the PR checks read. */
export interface ItemRead {
  kind: ItemKind;
  detail: ItemDetail;
  /** The detail as REST's issue endpoint had it: on a PR, without the review comments and PR fields. */
  conversation: ItemDetail;
  timeline: TimelineEvent[];
  /** The conversation's comments, without a PR's review comments. */
  comments: Comment[];
  pull?: PullRead;
}
interface PullRead {
  state: "open" | "closed" | "merged";
  sha: string;
  changedFiles: number;
  lastCommit: string | null;
  reviews: { author: string; state: string; at: string; body: string }[];
  statuses: CommitStatus[];
}

/** A commit's statuses, as REST's names them, by context: GraphQL and REST list them in different orders. */
function statuses(s: RawStatus | null | undefined): CommitStatus[] {
  return (s?.contexts ?? [])
    .map((c) => ({
      context: c.context,
      state: c.state.toLowerCase(),
      description: c.description ?? "",
      target_url: c.targetUrl ?? "",
    }))
    .sort((a, b) => a.context.localeCompare(b.context));
}

/** Last approve/reject per reviewer wins; any CHANGES_REQUESTED outranks approvals. */
function decision(reviews: { author: string; state: string }[]): ReviewDecision {
  const latest = new Map<string, string>();
  for (const r of reviews)
    if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") latest.set(r.author, r.state);
  const s = new Set(latest.values());
  return s.has("CHANGES_REQUESTED") ? "CHANGES_REQUESTED" : s.has("APPROVED") ? "APPROVED" : null;
}

/** REST's login for an actor: an app's bot account is `name[bot]` there, `name` in GraphQL. A deleted user is ghost. */
function login(a: RawActor | null | undefined): string {
  if (!a?.login) return "ghost";
  return a.__typename === "Bot" ? `${a.login}[bot]` : a.login;
}
const actor = (a: RawActor | null | undefined) => (a ? { login: login(a) } : null);

/** An ISO time in UTC, to the second, as REST writes it. */
const utc = (t: string) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");

/** A GraphQL timeline item as the REST timeline event the judges read (null for one they do not). */
function restEvent(e: RawTimeline): TimelineEvent | null {
  switch (e.__typename) {
    case "IssueComment":
      return {
        event: "commented",
        created_at: e.createdAt,
        actor: actor(e.author),
        user: actor(e.author),
        body: e.body,
      };
    case "AssignedEvent":
    case "UnassignedEvent":
      return {
        event: e.__typename === "AssignedEvent" ? "assigned" : "unassigned",
        created_at: e.createdAt,
        actor: actor(e.actor),
        assignee: actor(e.assignee),
      };
    case "LabeledEvent":
    case "UnlabeledEvent":
      return {
        event: e.__typename === "LabeledEvent" ? "labeled" : "unlabeled",
        created_at: e.createdAt,
        actor: actor(e.actor),
        label: e.label ? { name: e.label.name } : undefined,
      };
    case "ReviewRequestedEvent":
      return {
        event: "review_requested",
        created_at: e.createdAt,
        actor: actor(e.actor),
        // A team asked has no login: REST names it requested_team, which nothing reads.
        requested_reviewer: e.requestedReviewer?.login ? actor(e.requestedReviewer) : undefined,
      };
    case "HeadRefForcePushedEvent":
      return { event: "head_ref_force_pushed", created_at: e.createdAt, actor: actor(e.actor) };
    case "PullRequestCommit":
      return {
        event: "committed",
        // A git timestamp keeps the committer's offset; REST gives UTC.
        committer: e.commit?.committer?.date ? { date: utc(e.commit.committer.date) } : null,
      };
    case "PullRequestReview":
      return {
        event: "reviewed",
        submitted_at: e.submittedAt ?? undefined,
        state: e.state?.toLowerCase(),
        user: actor(e.author),
        // REST has no body for a review without a summary.
        body: e.body || null,
      };
    case "CrossReferencedEvent": {
      const s = e.source;
      if (!s?.number) return { event: "cross-referenced", created_at: e.createdAt, actor: actor(e.actor) };
      return {
        event: "cross-referenced",
        created_at: e.createdAt,
        actor: actor(e.actor),
        source: {
          issue: {
            number: s.number,
            title: s.title ?? "",
            state: s.state === "OPEN" ? "open" : "closed",
            html_url: s.url ?? "",
            created_at: s.createdAt ?? "",
            body: s.body ?? null,
            user: { login: login(s.author) },
            pull_request: s.__typename === "PullRequest" ? { merged_at: s.mergedAt ?? null } : undefined,
          },
        },
      };
    }
    default:
      return null;
  }
}

const ACTOR = "__typename login";
const ISSUE_EVENTS =
  "ISSUE_COMMENT, ASSIGNED_EVENT, UNASSIGNED_EVENT, CROSS_REFERENCED_EVENT, LABELED_EVENT, UNLABELED_EVENT";
const PR_EVENTS = `${ISSUE_EVENTS}, REVIEW_REQUESTED_EVENT, PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT, PULL_REQUEST_REVIEW`;
const USER_LIKE = `... on User { ${ACTOR} } ... on Bot { ${ACTOR} } ... on Mannequin { ${ACTOR} }`;
const ISSUE_TIMELINE = `__typename
  ... on IssueComment { author { ${ACTOR} } body createdAt }
  ... on AssignedEvent { actor { ${ACTOR} } createdAt assignee { ${USER_LIKE} } }
  ... on UnassignedEvent { actor { ${ACTOR} } createdAt assignee { ${USER_LIKE} } }
  ... on LabeledEvent { actor { ${ACTOR} } createdAt label { name } }
  ... on UnlabeledEvent { actor { ${ACTOR} } createdAt label { name } }
  ... on CrossReferencedEvent { actor { ${ACTOR} } createdAt source { __typename
    ... on Issue { number title state url createdAt body author { ${ACTOR} } }
    ... on PullRequest { number title state url createdAt body author { ${ACTOR} } mergedAt } } }`;
const PR_TIMELINE = `${ISSUE_TIMELINE}
  ... on ReviewRequestedEvent { actor { ${ACTOR} } createdAt requestedReviewer { ${USER_LIKE} } }
  ... on HeadRefForcePushedEvent { actor { ${ACTOR} } createdAt }
  ... on PullRequestCommit { commit { committer { date } } }
  ... on PullRequestReview { author { ${ACTOR} } state submittedAt body }`;
const FILE_FIELDS = "path additions deletions";
const REVIEW_FIELDS = `author { ${ACTOR} } state submittedAt body`;
const THREAD_FIELDS = `comments(first: 100) { nodes { author { ${ACTOR} } body createdAt } }`;
const PAGE = "pageInfo { hasNextPage endCursor }";
const STATUS_FIELDS = "status { contexts { context state description targetUrl } }";
const COMMON = `id number title body state url createdAt closedAt author { ${ACTOR} } milestone { title }
  labels(first: 100) { nodes { name } } assignees(first: 50) { nodes { login } }`;
const ITEM_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issueOrPullRequest(number: $number) { __typename
    ... on Issue { ${COMMON} timelineItems(first: 100, itemTypes: [${ISSUE_EVENTS}]) { ${PAGE} nodes { ${ISSUE_TIMELINE} } } }
    ... on PullRequest { ${COMMON} isDraft additions deletions mergedAt changedFiles headRefOid
      timelineItems(first: 100, itemTypes: [${PR_EVENTS}]) { ${PAGE} nodes { ${PR_TIMELINE} } }
      files(first: 100) { ${PAGE} nodes { ${FILE_FIELDS} } }
      reviewThreads(first: 100) { ${PAGE} nodes { ${THREAD_FIELDS} } }
      reviews(first: 100) { ${PAGE} nodes { ${REVIEW_FIELDS} } }
      commits(last: 100) { nodes { commit { committedDate } } }
      head: commits(last: 1) { nodes { commit { ${STATUS_FIELDS} } } } } } } }`;

const CHECKS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    id title state mergedAt headRefOid changedFiles files(first: 100) { ${PAGE} nodes { path } }
    head: commits(last: 1) { nodes { commit { ${STATUS_FIELDS} } } } } } }`;
const CHECKS_FILES_QUERY = `query($id: ID!, $after: String!) { node(id: $id) { ... on PullRequest {
  files(first: 100, after: $after) { ${PAGE} nodes { path } } } } }`;
const LABELS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issueOrPullRequest(number: $number) {
    ... on Issue { labels(first: 100) { nodes { name } } } ... on PullRequest { labels(first: 100) { nodes { name } } } } } }`;
const BOARD_FIELDS = `number title state url updatedAt closedAt labels(first: 100) { nodes { name } }
  assignees(first: 50) { nodes { login } }
  projectItems(first: 50) { nodes { id databaseId isArchived
    project { number owner { ... on Organization { login } ... on User { login } } }
    status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } }`;
const BOARD_ITEMS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issueOrPullRequest(number: $number) { __typename
    ... on Issue { ${BOARD_FIELDS} }
    ... on PullRequest { ${BOARD_FIELDS} isDraft merged } } } }`;

// GraphQL payload shapes (only the fields read above)
interface RawActor {
  __typename?: string;
  login?: string;
}
interface Connection<N> {
  pageInfo: { hasNextPage: boolean; endCursor: string };
  nodes: N[];
}
interface RawTimeline {
  __typename: string;
  author?: RawActor | null;
  actor?: RawActor | null;
  assignee?: RawActor | null;
  requestedReviewer?: RawActor | null;
  body?: string | null;
  createdAt: string;
  submittedAt?: string | null;
  state?: string;
  label?: { name: string } | null;
  commit?: { committer: { date: string | null } | null } | null;
  source?: {
    __typename: string;
    number?: number;
    title?: string;
    state?: string;
    url?: string;
    createdAt?: string;
    body?: string | null;
    author?: RawActor | null;
    mergedAt?: string | null;
  } | null;
}
interface RawStatus {
  contexts: { context: string; state: string; description: string | null; targetUrl: string | null }[];
}
interface RawChecks {
  id: string;
  title: string;
  state: string;
  mergedAt: string | null;
  headRefOid: string;
  changedFiles: number;
  files: Connection<{ path: string }>;
  head: { nodes: { commit: { status: RawStatus | null } }[] };
}
interface RawBoardContent {
  __typename: ItemKind;
  number: number;
  title: string;
  state: string;
  url: string;
  updatedAt: string;
  closedAt: string | null;
  isDraft?: boolean;
  merged?: boolean;
  labels: { nodes: { name: string }[] };
  assignees: { nodes: { login: string }[] };
  projectItems: {
    nodes: ({
      id: string;
      databaseId: number;
      isArchived: boolean;
      project: { number: number; owner: { login?: string } | null } | null;
      status: { name?: string } | null;
    } | null)[];
  } | null;
}
interface RawItem {
  __typename: "Issue" | "PullRequest";
  id: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  url: string;
  createdAt: string;
  closedAt: string | null;
  author: RawActor | null;
  milestone: { title: string } | null;
  labels: { nodes: { name: string }[] };
  assignees: { nodes: { login: string }[] };
  timelineItems: Connection<RawTimeline>;
}
interface RawPullRequest extends RawItem {
  isDraft: boolean;
  additions: number;
  deletions: number;
  mergedAt: string | null;
  changedFiles: number;
  headRefOid: string;
  files: Connection<{ path: string; additions: number; deletions: number }>;
  reviews: Connection<{
    author: RawActor | null;
    state: string;
    submittedAt: string | null;
    body: string | null;
  }>;
  reviewThreads: Connection<{
    comments: { nodes: { author: RawActor | null; body: string | null; createdAt: string }[] };
  }>;
  commits: { nodes: { commit: { committedDate: string } }[] };
  head: { nodes: { commit: { status: RawStatus | null } }[] };
}

type RequestErrorLike = {
  status?: number;
  message?: string;
  response?: { headers?: Record<string, string | undefined>; data?: unknown };
};

/** A 5xx GitHub actually answered. Octokit also reports a failed fetch (offline, DNS) as status 500, but with
 *  no response; that is not retried. */
function isServerError(e: unknown): boolean {
  const err = e as RequestErrorLike;
  return Boolean(err?.response) && typeof err.status === "number" && err.status >= 500;
}

/** How long to wait before retrying a rate-limited request, or null when `e` is not a rate limit or the wait would
 *  be longer than a minute (a primary limit resetting later: the error says when). Primary limit: until
 *  x-ratelimit-reset. Secondary limit: Retry-After if given, else an exponential 2s, 4s … 60s. Each wait is
 *  stretched by up to half again at random. */
function rateLimitWait(e: unknown, attempt: number): number | null {
  const err = e as RequestErrorLike;
  if (!err?.response || (err.status !== 429 && err.status !== 403)) return null;
  const h = err.response.headers ?? {};
  const message = (err.response.data as { message?: string } | undefined)?.message ?? "";
  const backoff = Math.min(RATE_LIMIT_MAX_WAIT_MS, 2000 * 2 ** attempt);
  let wait: number | null = null;
  if (h["retry-after"]) wait = Number(h["retry-after"]) * 1000;
  else if (h["x-ratelimit-remaining"] === "0" && h["x-ratelimit-reset"])
    // A local clock ahead of GitHub's makes this zero or negative; back off instead of retrying at once.
    wait = Math.max(Number(h["x-ratelimit-reset"]) * 1000 - Date.now() + 1000, backoff);
  else if (err.status === 429 || /rate limit/i.test(message)) wait = backoff;
  if (wait === null || !Number.isFinite(wait) || wait > RATE_LIMIT_MAX_WAIT_MS) return null;
  // Jitter, so a burst of requests limited together does not come back together and trip the limit again.
  return Math.min(Math.max(wait, 0) * (1 + Math.random() / 2), RATE_LIMIT_MAX_WAIT_MS);
}

/** Octokit's RequestError -> GitHubError, keeping the message format and the rate-limit reset time. */
function toGitHubError(e: unknown, path: string): Error {
  const err = e as RequestErrorLike;
  if (typeof err?.status !== "number") return e instanceof Error ? e : new Error(String(e));
  if (!err.response)
    return new GitHubError(`GitHub unreachable for ${path.split("?")[0]}: ${err.message}`, 0);
  const h = err.response?.headers ?? {};
  const reset = h["x-ratelimit-reset"];
  const data = err.response?.data as { message?: string } | undefined;
  let msg = `GitHub ${err.status} for ${path.split("?")[0]}`;
  if (data?.message) msg += `: ${data.message}`;
  if (h["x-ratelimit-remaining"] === "0" && reset)
    msg += ` (rate limit resets ${new Date(Number(reset) * 1000).toLocaleTimeString()})`;
  return new GitHubError(msg, err.status, reset ? new Date(Number(reset) * 1000) : undefined);
}

// REST payload shapes (only the fields read above)
interface RawProjectItem {
  id: number;
  node_id: string;
  content?: {
    number?: number;
    url: string;
    html_url: string;
    title: string;
    state: string;
    merged_at?: string | null;
    draft?: boolean;
    labels?: { name: string }[];
    assignees?: { login: string }[];
    updated_at: string;
    closed_at?: string | null;
  };
}
export type SearchQuery = string | { q: string; type: "ISSUE" | "ISSUE_SEMANTIC" | "ISSUE_HYBRID" };

/** An issue and its recent thread, as the duplicates check reads a candidate. */
export interface ThreadIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  created_at: string;
  closed_at: string | null;
  url: string;
  author: string;
  labels: string[];
  comments: { author: string; body: string; created_at: string }[];
}

export interface RawSearchIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  closed_at?: string | null;
  html_url: string;
  body?: string | null;
  created_at?: string;
  updated_at?: string;
  author?: string;
  assignees?: string[];
}

/** Timeline events the extension reads, cut to the fields it reads, with long bodies cut: the judges see the
 *  thread's comments in full elsewhere. */
const KEPT_EVENTS = new Set([
  "review_requested",
  "assigned",
  "unassigned",
  "cross-referenced",
  "committed",
  "head_ref_force_pushed",
  "commented",
  "reviewed",
  "labeled",
  "unlabeled",
]);
const who = (u?: { login: string } | null) => (u ? { login: u.login } : u);
export function slim(events: TimelineEvent[]): TimelineEvent[] {
  return events
    .filter((e) => KEPT_EVENTS.has(e.event))
    .map((e) => {
      const i = e.source?.issue;
      return {
        event: e.event,
        created_at: e.created_at,
        submitted_at: e.submitted_at,
        state: e.state,
        actor: who(e.actor),
        user: who(e.user),
        assignee: who(e.assignee),
        requested_reviewer: who(e.requested_reviewer),
        label: e.label && { name: e.label.name },
        body: e.body?.slice(0, 300),
        committer: e.committer && { date: e.committer.date },
        source: i && {
          issue: {
            number: i.number,
            title: i.title,
            state: i.state,
            html_url: i.html_url,
            created_at: i.created_at,
            body: i.body?.slice(0, 1000) ?? null,
            user: who(i.user) ?? undefined,
            pull_request: i.pull_request && { merged_at: i.pull_request.merged_at },
          },
        },
      };
    });
}

/** A REST timeline event; only the fields the extension reads. */
export interface TimelineEvent {
  event: string;
  created_at?: string;
  submitted_at?: string;
  /** A review's state: APPROVED, CHANGES_REQUESTED, COMMENTED. */
  state?: string;
  actor?: { login: string } | null;
  user?: { login: string } | null;
  assignee?: { login: string } | null;
  requested_reviewer?: { login: string } | null;
  label?: { name: string };
  body?: string | null;
  committer?: { date: string } | null;
  source?: {
    issue?: {
      number: number;
      title: string;
      state: string;
      html_url: string;
      created_at: string;
      body: string | null;
      user?: { login: string };
      pull_request?: { merged_at: string | null };
      updated_at?: string;
    };
  };
}
/** What the Needs Reviewer checks read about a pull request. */
export interface PullState {
  state: "open" | "closed" | "merged";
  draft: boolean;
  author: string;
  created_at: string;
  labels: string[];
  tide: { state: string; description: string } | null;
  failing: string[];
  reviews: { author: string; state: string; at: string; body: string }[];
}
/** A commit status, as the PR page's CI check reads it. */
export interface CommitStatus {
  context: string;
  state: string;
  description: string;
  target_url: string;
}
/** A changed file's patch is cut here: one file of a huge change is judged from its first hunks. */
export const PATCH_MAX = 8000;
export interface ChangedFile {
  file: string;
  /** added, modified, removed, renamed… */
  status: string;
  patch: string | null;
}
export interface PullChecks {
  sha: string;
  title: string;
  state: "open" | "closed" | "merged";
  /** Changed paths, at most 300 of `files_total`. */
  files: string[];
  files_total: number;
  statuses: CommitStatus[];
}
