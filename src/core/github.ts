/** GitHub REST client on Octokit (no GraphQL: the hourly GraphQL point budget is never touched). Octokit adds
 *  Link-header pagination; this class adds a short retry on 5xx, the cache and the board shapes.
 *  Reads are GETs; the two writes are a Status move and an issue / PR comment (for Prow commands). */
import { Octokit } from "@octokit/core";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { DAY, MINUTE, type Cache } from "./cache";
import type {
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
 *  so repeating it cannot double a write. Waits follow Retry-After / the reset time, up to this long. */
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_MAX_WAIT_MS = 60_000;

/** GitHub's documented ceiling on concurrent requests. Callers fan out freely (a whole column at once); this keeps
 *  the requests actually on the wire at or under it. Module-level because the worker builds a client per message. */
const MAX_IN_FLIGHT = 100;
let inFlight = 0;
const waiting: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  // A freed place is handed straight to the next waiter (the count stays up), so nothing can slip in between.
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((r) => waiting.push(r));
  else inFlight++;
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else inFlight--;
  }
}

export class GitHubClient {
  readonly octokit: InstanceType<typeof Client>;

  constructor(
    token: string,
    private cache: Cache,
    fetchFn: typeof fetch = (...a) => fetch(...a),
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
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
          return await limited(async () => request(options));
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

  /** Who the token belongs to; the options page's "test" button. */
  async viewer(): Promise<{ login: string }> {
    return this.api<{ login: string }>("/user");
  }

  /** 'orgs' or 'users' for the REST projectsV2 routes; resolved once and cached for a month. */
  ownerType(owner: string): Promise<"orgs" | "users"> {
    return this.cache.cached(`ownertype:${owner}`, 30 * DAY, async () => {
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
    return this.cache.cached(`fields:${board.owner}/${board.number}`, DAY, async () => {
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
    }
  }

  /** The issue or PR behind one project item, read fresh (never cached): what a write is checked against. */
  async projectItem(board: BoardRef, restId: number): Promise<{ repository: string; number: number } | null> {
    const it = await this.api<RawProjectItem>(`${await this.projectPath(board)}/items/${restId}`);
    const c = it.content;
    if (!c?.number) return null;
    return { repository: c.html_url.split("/").slice(3, 5).join("/"), number: c.number };
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
    }
  }

  /** Items in one Status column via the server-side `q=status:` filter; draft issues (no content) are skipped. */
  itemsIn(board: BoardRef, status: string, refresh = false): Promise<BoardItem[]> {
    const key = `col:${board.owner}/${board.number}:${status}`;
    return this.cache.cached(
      key,
      10 * MINUTE,
      async () => {
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
      },
      refresh,
    );
  }

  /** Last approve/reject per reviewer wins; any CHANGES_REQUESTED outranks approvals. */
  async reviewDecision(repo: string, num: number): Promise<ReviewDecision> {
    const latest = new Map<string, string>();
    for (const r of await this.paged<{ state: string; user: { login: string } }>(
      `/repos/${repo}/pulls/${num}/reviews`,
    )) {
      if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") latest.set(r.user.login, r.state);
    }
    const s = new Set(latest.values());
    return s.has("CHANGES_REQUESTED") ? "CHANGES_REQUESTED" : s.has("APPROVED") ? "APPROVED" : null;
  }

  /** PRs that reference an issue (cross-referenced timeline events), newest reference last, deduped. */
  linkedPrs(repo: string, num: number, refresh = false): Promise<LinkedPr[]> {
    return this.cache.cached(
      `linked:${repo}#${num}`,
      30 * MINUTE,
      async () => {
        const out = new Map<string, LinkedPr>();
        for (const e of await this.paged<RawTimelineEvent>(`/repos/${repo}/issues/${num}/timeline`)) {
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
      },
      refresh,
    );
  }

  itemDetail(repo: string, kind: ItemKind, num: number, refresh = false): Promise<ItemDetail> {
    return this.cache.cached(
      `item:${repo}#${num}`,
      30 * MINUTE,
      async () => {
        const iss = await this.api<RawIssue>(`/repos/${repo}/issues/${num}`);
        const cm = (c: RawComment) => ({
          author: { login: c.user.login },
          body: c.body ?? "",
          createdAt: c.created_at,
        });
        const d: ItemDetail = {
          title: iss.title,
          body: iss.body ?? "",
          labels: iss.labels.map((l) => ({ name: l.name })),
          state: iss.state,
          author: { login: iss.user.login },
          createdAt: iss.created_at,
          url: iss.html_url,
          comments: (await this.paged<RawComment>(`/repos/${repo}/issues/${num}/comments`)).map(cm),
        };
        if (kind === "PullRequest") {
          const pr = await this.api<RawPull>(`/repos/${repo}/pulls/${num}`);
          d.isDraft = pr.draft;
          d.additions = pr.additions;
          d.deletions = pr.deletions;
          d.files = (await this.paged<RawFile>(`/repos/${repo}/pulls/${num}/files`)).map((f) => ({
            path: f.filename,
            additions: f.additions,
            deletions: f.deletions,
          }));
          d.reviewDecision = await this.reviewDecision(repo, num);
          d.comments.push(...(await this.paged<RawComment>(`/repos/${repo}/pulls/${num}/comments`)).map(cm));
          d.comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        }
        return d;
      },
      refresh,
    );
  }
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
 *  be too long to hold the service worker for. Primary limit: until x-ratelimit-reset. Secondary limit: Retry-After
 *  if given, else GitHub's advice of a minute's wait, shortened here to an exponential 5s, 10s, 20s. Each wait is
 *  stretched by up to half again at random. */
function rateLimitWait(e: unknown, attempt: number): number | null {
  const err = e as RequestErrorLike;
  if (!err?.response || (err.status !== 429 && err.status !== 403)) return null;
  const h = err.response.headers ?? {};
  const message = (err.response.data as { message?: string } | undefined)?.message ?? "";
  const backoff = 5000 * 2 ** attempt;
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
interface RawIssue {
  title: string;
  body: string | null;
  labels: { name: string }[];
  state: string;
  user: { login: string };
  created_at: string;
  html_url: string;
}
interface RawTimelineEvent {
  event: string;
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
    };
  };
}
interface RawComment {
  user: { login: string };
  body: string | null;
  created_at: string;
}
interface RawPull {
  draft: boolean;
  additions: number;
  deletions: number;
}
interface RawFile {
  filename: string;
  additions: number;
  deletions: number;
}
