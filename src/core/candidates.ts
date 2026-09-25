/** Who to /cc on a PR nobody is reviewing. Measured on 662 PRs merged on kubernetes/151 since 2025-10 (hit = the
 *  person actually reviewed): OWNERS membership alone put a reviewer in its top 3 for about half of them; who
 *  reviewed recent PRs touching the same files, directories, or by the same author did better (a blend of those,
 *  68%); Jev picking from the blend's top 8, given each candidate's counts and the titles they reviewed lately,
 *  did best (50% for its first pick, 71% in its top 3). So code gathers history and OWNERS, and Jev picks. */
import { isBot } from "./boards";
import type { GitHubClient } from "./github";
import type { JevClient } from "./jev";
import type { JevChoice, JevUsage } from "./types";
import type { Candidate } from "./reviewer";

const DAY_MS = 86_400_000;
const lower = (s: string) => s.toLowerCase();

interface HistPr {
  number: number;
  title: string;
  author: string;
  created: string;
  reviewers: string[];
}

interface RawPr {
  number: number;
  title: string;
  createdAt: string;
  mergedAt: string | null;
  author: { login: string } | null;
  reviews: { nodes: { author: { login: string } | null }[] };
  comments: { nodes: { author: { login: string } | null; body: string }[] };
}

const PR_FIELDS = `number title createdAt mergedAt author{login}
  reviews(first:20){nodes{author{login}}}
  comments(last:25){nodes{author{login} body}}`;

function toHist(p: RawPr | null | undefined): HistPr | null {
  if (!p?.mergedAt || !p.author) return null;
  const a = lower(p.author.login);
  const who = new Set<string>();
  for (const r of p.reviews.nodes) if (r.author) who.add(r.author.login);
  for (const c of p.comments.nodes)
    if (c.author && /^\s*\/lgtm(?!\s+cancel)/im.test(c.body)) who.add(c.author.login);
  return {
    number: p.number,
    title: p.title,
    author: p.author.login,
    created: p.createdAt,
    reviewers: [...who].filter((u) => lower(u) !== a && !isBot(u)),
  };
}

/** Merged PRs that touched each path in the last year, and the author's own recent merged PRs, with who reviewed
 *  them: one GraphQL query. */
export async function reviewHistory(
  gh: Pick<GitHubClient, "graphql">,
  repo: string,
  author: string,
  files: string[],
  dirs: string[],
  now: number,
): Promise<{ byPath: Record<string, HistPr[]>; byAuthor: HistPr[] }> {
  const [owner, name] = repo.split("/");
  const since = new Date(now - 365 * DAY_MS).toISOString();
  const paths = [...files.slice(0, 5), ...dirs.slice(0, 3)];
  const repoArgs = `owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}`;
  type H = { nodes: { associatedPullRequests: { nodes: RawPr[] } }[] };
  // One small query per path: GitHub times out (502) on one query that asks for all of them.
  const perPath = await Promise.all(
    paths.map((p) =>
      gh
        .graphql<{ repository: { object: { history: H } | null } }>(
          `query { repository(${repoArgs}) { object(expression: "HEAD") { ... on Commit {
            history(path: ${JSON.stringify(p)}, first: 15, since: ${JSON.stringify(since)}) {
              nodes { associatedPullRequests(first: 1) { nodes { ${PR_FIELDS} } } } } } } } }`,
        )
        .catch(() => null),
    ),
  );
  const data = await gh
    .graphql<{ authored: { nodes: RawPr[] } }>(
      `query { authored: search(query: ${JSON.stringify(`repo:${repo} is:pr is:merged author:${author}`)}, type: ISSUE, first: 15) {
        nodes { ... on PullRequest { ${PR_FIELDS} } } } }`,
    )
    .catch(() => ({ authored: { nodes: [] as RawPr[] } }));
  const byPath: Record<string, HistPr[]> = {};
  paths.forEach((p, i) => {
    const seen = new Map<number, HistPr>();
    for (const n of perPath[i]?.repository.object?.history.nodes ?? []) {
      const h = toHist(n.associatedPullRequests.nodes[0]);
      if (h) seen.set(h.number, h);
    }
    byPath[p] = [...seen.values()];
  });
  const byAuthor = (data.authored?.nodes ?? []).map(toHist).filter((h): h is HistPr => h !== null);
  return { byPath, byAuthor };
}

// ---------------------------------------------------------------------------------------------------------------
// OWNERS: a small bonus, since the lists are long and many names on them do not review.

/** approvers, reviewers and emeritus from an OWNERS file: every "- name" under a key with that name, at any
 *  depth (so `filters:` blocks count too). Enough for OWNERS; not a YAML parser. */
export function parseOwners(text: string): { approvers: string[]; reviewers: string[]; emeritus: string[] } {
  const out = { approvers: [] as string[], reviewers: [] as string[], emeritus: [] as string[] };
  let key: keyof typeof out | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "");
    const k = /^\s*([\w-]+)\s*:\s*$/.exec(line);
    if (k) {
      const name = k[1]!;
      key =
        name === "approvers"
          ? "approvers"
          : name === "reviewers"
            ? "reviewers"
            : name.startsWith("emeritus")
              ? "emeritus"
              : null;
      continue;
    }
    const item = /^\s*-\s*([\w-]+)\s*$/.exec(line);
    if (item && key) out[key].push(item[1]!);
    else if (line.trim() && !item) key = null;
  }
  return out;
}

/** OWNERS_ALIASES: alias name -> members. */
export function parseAliases(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let cur: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "");
    const k = /^\s{2,}([\w-]+)\s*:\s*$/.exec(line);
    if (k) {
      cur = k[1]!;
      out[cur] = [];
      continue;
    }
    const item = /^\s*-\s*([\w-]+)\s*$/.exec(line);
    if (item && cur) out[cur]!.push(item[1]!);
  }
  return out;
}

export interface OwnersReader {
  /** A file's text at HEAD, or null. */
  raw(repo: string, path: string): Promise<string | null>;
}

/** The nearest OWNERS at or above `dir`, aliases expanded. */
export async function nearestOwners(
  r: OwnersReader,
  repo: string,
  dir: string,
): Promise<{ dir: string; approvers: string[]; reviewers: string[]; emeritus: string[] }> {
  const aliases = parseAliases((await r.raw(repo, "OWNERS_ALIASES")) ?? "");
  const exp = (xs: string[]) => [...new Set(xs.flatMap((x) => aliases[x] ?? [x]))];
  let cur = dir;
  for (;;) {
    const text = await r.raw(repo, cur ? `${cur}/OWNERS` : "OWNERS");
    if (text !== null) {
      const o = parseOwners(text);
      return {
        dir: cur,
        approvers: exp(o.approvers),
        reviewers: exp(o.reviewers),
        emeritus: exp(o.emeritus),
      };
    }
    if (!cur) return { dir: "", approvers: [], reviewers: [], emeritus: [] };
    cur = cur.includes("/") ? cur.slice(0, cur.lastIndexOf("/")) : "";
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The blend and Jev's pick.

export interface CandidateEvidence {
  login: string;
  reviewed_prs_touching_same_files: number;
  reviewed_prs_in_same_directories: number;
  reviewed_this_authors_prs: number;
  days_since_last_review_seen: number | null;
  owners_approver_for_touched_files: boolean;
  owners_reviewer_for_touched_files: boolean;
  recently_reviewed_pr_titles: string[];
  /** For the /cc reason: the strongest piece of evidence, in words. */
  best: string;
}

const W = { file: 3, dir: 2, author: 2, owners: 1.5 };

export function blend(
  author: string,
  files: string[],
  dirs: string[],
  hist: { byPath: Record<string, HistPr[]>; byAuthor: HistPr[] },
  owners: { dir: string; approvers: string[]; reviewers: string[]; emeritus: string[] }[],
  exclude: string[],
  now: number,
): CandidateEvidence[] {
  const out = new Map<
    string,
    {
      file: Set<number>;
      dir: Set<number>;
      author: Set<number>;
      files: Map<string, number>;
      dirs: Map<string, number>;
      last: number;
      titles: Map<number, [string, string]>;
    }
  >();
  const get = (u: string) => {
    let x = out.get(u);
    if (!x)
      out.set(
        u,
        (x = {
          file: new Set(),
          dir: new Set(),
          author: new Set(),
          files: new Map(),
          dirs: new Map(),
          last: 0,
          titles: new Map(),
        }),
      );
    return x;
  };
  const see = (u: string, p: HistPr) => {
    const x = get(u);
    x.last = Math.max(x.last, Date.parse(p.created));
    x.titles.set(p.number, [p.created, p.title]);
    return x;
  };
  for (const f of files)
    for (const p of hist.byPath[f] ?? [])
      for (const u of p.reviewers) {
        const x = see(u, p);
        x.file.add(p.number);
        x.files.set(f, (x.files.get(f) ?? 0) + 1);
      }
  for (const d of dirs)
    for (const p of hist.byPath[d] ?? [])
      for (const u of p.reviewers) {
        const x = see(u, p);
        x.dir.add(p.number);
        x.dirs.set(d, (x.dirs.get(d) ?? 0) + 1);
      }
  for (const p of hist.byAuthor) for (const u of p.reviewers) see(u, p).author.add(p.number);
  const appr = new Set(owners.flatMap((o) => o.approvers.map(lower)));
  const rev = new Set(owners.flatMap((o) => o.reviewers.map(lower)));
  const emer = new Set(owners.flatMap((o) => o.emeritus.map(lower)));
  const skip = new Set([author, ...exclude].map(lower));
  const rows = [...out].filter(([u]) => !skip.has(lower(u)) && !emer.has(lower(u)) && !isBot(u));
  const max = (k: "file" | "dir" | "author") => Math.max(1, ...rows.map(([, x]) => x[k].size));
  const [mf, md, ma] = [max("file"), max("dir"), max("author")];
  const scored = rows.map(([u, x]) => {
    // OWNERS only counts for someone who reviews here at all (the history above): membership alone predicts little.
    const own = appr.has(lower(u)) || rev.has(lower(u)) ? 1 : 0;
    const score =
      (W.file * x.file.size) / mf +
      (W.dir * x.dir.size) / md +
      (W.author * x.author.size) / ma +
      W.owners * own;
    const topFile = [...x.files].sort((a, b) => b[1] - a[1])[0];
    const topDir = [...x.dirs].sort((a, b) => b[1] - a[1])[0];
    const ownDir = owners.find(
      (o) => o.approvers.map(lower).includes(lower(u)) || o.reviewers.map(lower).includes(lower(u)),
    );
    const n = (k: number) => `${k} recent PR${k === 1 ? "" : "s"}`;
    const best = topFile
      ? `you reviewed ${n(topFile[1])} touching \`${topFile[0]}\``
      : topDir
        ? `you reviewed ${n(topDir[1])} in \`${topDir[0]}/\``
        : x.author.size
          ? `you reviewed ${n(x.author.size)} by the same author`
          : ownDir
            ? `you are in OWNERS for \`${ownDir.dir || "/"}\``
            : "you review in this area";
    return {
      score,
      ev: {
        login: u,
        reviewed_prs_touching_same_files: x.file.size,
        reviewed_prs_in_same_directories: x.dir.size,
        reviewed_this_authors_prs: x.author.size,
        days_since_last_review_seen: x.last ? Math.floor((now - x.last) / DAY_MS) : null,
        owners_approver_for_touched_files: appr.has(lower(u)),
        owners_reviewer_for_touched_files: rev.has(lower(u)),
        recently_reviewed_pr_titles: [...x.titles.values()]
          .sort((a, b) => b[0].localeCompare(a[0]))
          .slice(0, 5)
          .map((t) => t[1]),
        best,
      } satisfies CandidateEvidence,
    };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((s) => s.ev);
}

/** Jev's pick among the blend's candidates: the top 3 by P(reviews if asked). */
export async function pickReviewers(
  jev: JevClient,
  pr: { repository: string; title: string; author: string; changed_files: string[] },
  pool: CandidateEvidence[],
  refresh = false,
): Promise<{ picks: Candidate[]; usage: JevUsage | null }> {
  if (!pool.length) return { picks: [], usage: null };
  if (pool.length === 1)
    return { picks: [{ login: pool[0]!.login, reason: pool[0]!.best, p: 1 }], usage: null };
  const state = { pr, candidates: pool.map(({ best: _b, ...e }) => e) };
  const q = {
    reviewer: {
      type: "choice",
      instructions: {
        question: "Which candidate is most likely to review this pull request if asked?",
        focus:
          "Prefer people who review this code today: recent reviews of the same files or directories, and of this author's PRs, weigh more than OWNERS membership. Match the topics in recently_reviewed_pr_titles to this PR.",
        evidence: ["pr", "candidates"],
      },
      criteria: Object.fromEntries(pool.map((c, i) => [`c${i}`, { login: c.login }])),
    },
  };
  const r = await jev.askCached<{ reviewer: JevChoice }>(state, q, 4, refresh);
  const ranked = Object.entries(r.answers.reviewer.probabilities)
    .sort((a, b) => b[1] - a[1])
    .map(([k, p]) => ({ c: pool[Number(k.slice(1))]!, p }))
    .filter((x) => x.c);
  return {
    picks: ranked.slice(0, 3).map(({ c, p }) => ({ login: c.login, reason: c.best, p })),
    usage: r.usage,
  };
}
