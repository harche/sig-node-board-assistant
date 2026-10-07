/** Service worker: owns the tokens and every network call. Nothing is cached: every message reads what it needs
 *  fresh, through clients made for that message. The content script asks it questions
 *  (read-only views of GitHub plus Jev's opinion) and, on a writable board, to apply an accepted action. */
import { GitHubClient } from "../core/github";
import { JevClient, type JevCall } from "../core/jev";
import {
  feedbackHead,
  FEEDBACK_REPO,
  gistFiles,
  prefilled,
  renderFeedback,
  type FeedbackEnv,
  type FeedbackReport,
} from "../core/feedback";
import { knownBoard, writesTo } from "../core/boards";
import { findOnBoards } from "../core/lookup";
import { DUPLICATE_QUESTIONS } from "../core/prompts/todo";
import { TestGridClient } from "../core/testgrid";
import { judge } from "../core/triage";
import { isDraftedComment } from "../core/comments";
import { prowFixes, type ProwFix } from "../core/prowcmds";
import { decideApprove, type ApproveResult } from "../core/approver";
import type { AuthorResult } from "../core/author";
import { judgeBug } from "../core/bugs";
import { judgeInfo } from "../core/needsinfo";
import { judgeDra } from "../core/dra";
import { judgeTg } from "../core/tgjudge";
import { judgeCi, prChecks, type CiDeps } from "../core/prcijudge";
import { inScope, judgeIssueCi } from "../core/issuecheck";
import { judgeRelated } from "../core/related";
import {
  isTgDraft,
  mirrorTitle,
  namesWhole,
  prowLabels,
  TG_LIVE_REPOS,
  TG_TEST_REPO,
  titleQuery,
} from "../core/tgreview";
import { judgeBacklog, shortlist } from "../core/backlog";
import { BUG_DUPLICATE_QUESTIONS } from "../core/prompts/backlog";
import { noulReading } from "../core/readings";
import {
  blend,
  blendApprovers,
  coverApprovers,
  nearestOwners,
  ownersChain,
  pickReviewers,
  reviewHistory,
  unapprovedOwners,
} from "../core/candidates";
import { judgeProgress } from "../core/inprogress";
import { decideReview, judgeReview, type Candidate, type ReviewResult } from "../core/reviewer";
import { closeDuplicates, dupFacets, dupState, judgeTodo, type DuplicateOf } from "../core/todo";
import type { BoardItem, BoardRef, ItemDetail, JevChoice, JevNoul } from "../core/types";
import type { Envelope, Request, ResponseMap } from "../shared/messages";
import { BATCH_PORT, jevSettings, TRACED, type Settings } from "../shared/messages";
import { dropOldCache, loadSettings, saveSettings, TraceStore } from "./storage";

/** Broken Prow commands in the thread and their fixes (core/prowcmds.ts); a failure here never fails the judge. */
async function fixes(detail: ItemDetail, jev: JevClient): Promise<ProwFix[]> {
  try {
    return (
      await prowFixes(
        detail,
        detail.labels.map((l) => l.name),
        jev,
      )
    ).fixes;
  } catch {
    return [];
  }
}

const dirOf = (f: string) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "");

/** The directories with the most changed files, at most three. */
function topDirs(files: string[]): string[] {
  const count = new Map<string, number>();
  for (const f of files) count.set(dirOf(f), (count.get(dirOf(f)) ?? 0) + 1);
  return [...count]
    .sort((a, b) => b[1] - a[1])
    .map(([d]) => d)
    .filter(Boolean)
    .slice(0, 3);
}

/** At most `n` of `jobs` at once, in order. */
async function pool<T>(n: number, jobs: (() => Promise<T>)[]): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, jobs.length) }, async () => {
      while (i < jobs.length) {
        const k = i++;
        out[k] = await jobs[k]!();
      }
    }),
  );
  return out;
}

/** The duplicate pass for To do: each target against every other open issue in To do and In progress; which
 *  cards close, and in favour of what, is core/todo.ts closeDuplicates. */
async function duplicates(
  gh: GitHubClient,
  jev: JevClient,
  board: BoardRef,
  targets: BoardItem[],
): Promise<Record<number, DuplicateOf | null>> {
  const open = (i: BoardItem) => i.type === "Issue" && i.state === "open";
  const pool0 = [
    ...(await gh.itemsIn(board, "Issues - To do")),
    ...(await gh.itemsIn(board, "Issues - In progress")),
  ].filter(open);
  const facets = new Map<number, ReturnType<typeof dupFacets>>();
  const facetOf = async (i: BoardItem) => {
    if (!facets.has(i.restId))
      facets.set(i.restId, dupFacets(i, await gh.itemDetail(i.repository, "Issue", i.number)));
    return facets.get(i.restId)!;
  };
  const seen = new Set<string>();
  const pairs: [BoardItem, BoardItem][] = [];
  for (const t of targets.filter(open))
    for (const o of pool0) {
      const k = [t.restId, o.restId].sort().join("-");
      if (o.restId === t.restId || seen.has(k)) continue;
      seen.add(k);
      pairs.push([t, o]);
    }
  const answers = await pool(
    8,
    pairs.map(([a, b]) => async () => {
      const s = dupState(await facetOf(a), await facetOf(b));
      return (await jev.ask<{ duplicate: JevNoul; survivor: JevChoice }>(s, DUPLICATE_QUESTIONS)).answers;
    }),
  );
  const closing = closeDuplicates(
    pairs.map(([a, b], k) => ({
      a,
      b,
      p: answers[k]!.duplicate.noul,
      survivor: answers[k]!.survivor.choice === "A" ? "A" : "B",
    })),
    new Set(targets.map((t) => t.restId)),
  );
  const out: Record<number, DuplicateOf | null> = {};
  for (const t of targets) out[t.restId] = closing.get(t.restId) ?? null;
  return out;
}

/** The duplicate pass for the SIG Node Bugs backlog: each target against the open cards in Triaged and High
 *  Priority, only for the pairs whose words overlap most (backlog.ts shortlist). */
async function bugDuplicates(
  gh: GitHubClient,
  jev: JevClient,
  board: BoardRef,
  targets: BoardItem[],
): Promise<Record<number, DuplicateOf | null>> {
  const open = (i: BoardItem) => i.type === "Issue" && i.state === "open";
  const cols = ["Triaged", "High Priority"];
  const pool0 = (await Promise.all(cols.map((c) => gh.itemsIn(board, c)))).flat().filter(open);
  const pairs = shortlist(targets.filter(open), pool0, (i) => i.title);
  const facet = async (i: BoardItem) => {
    const d = await gh.itemDetail(i.repository, "Issue", i.number);
    return {
      number: i.number,
      repository: i.repository,
      created: d.createdAt.slice(0, 10),
      title: d.title,
      author: d.author.login,
      assignees: i.assignees,
      body: d.body.slice(0, 3000),
    };
  };
  const answers = await pool(
    8,
    pairs.map(([a, b]) => async () => {
      const [fa, fb] = await Promise.all([facet(a), facet(b)]);
      const s = {
        issue_A: fa,
        issue_B: fb,
        "precomputed (use as given)": {
          same_author: fa.author === fb.author,
          shared_assignee: fa.assignees.some((x) => fb.assignees.includes(x)),
        },
      };
      return (await jev.ask<{ duplicate: JevNoul; survivor: JevChoice }>(s, BUG_DUPLICATE_QUESTIONS)).answers;
    }),
  );
  const closing = closeDuplicates(
    pairs.map(([a, b], k) => ({
      a,
      b,
      p: answers[k]!.duplicate.noul,
      survivor: answers[k]!.survivor.choice === "A" ? "A" : "B",
    })),
    new Set(targets.map((t) => t.restId)),
    { working: "", closable: cols },
  );
  const out: Record<number, DuplicateOf | null> = {};
  for (const t of targets) out[t.restId] = closing.get(t.restId) ?? null;
  return out;
}

// The keys are for the worker and the settings page only: content scripts, which run inside web pages, cannot read
// chrome.storage.local (they ask the worker, which never hands them the keys).
chrome.storage.local
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch((e: unknown) => console.error("could not keep chrome.storage.local from content scripts:", e));
const traces = new TraceStore();

/** The GitHub and TestGrid clients one message reads through, or one batch of messages from one click (sendEach):
 *  each read is made once and shared among them, and dropped with them. */
interface Shared {
  gh?: GitHubClient;
  tg?: TestGridClient;
}

/** `trace` collects the request's Jev calls (feedback); each request has its own Jev client for that. */
async function clients(trace?: JevCall[], shared: Shared = {}) {
  const s = await loadSettings();
  if (!s.githubToken) throw new Error("GitHub token not set: open the extension options");
  const gh = (shared.gh ??= new GitHubClient(s.githubToken));
  const tg = (shared.tg ??= new TestGridClient());
  const j = jevSettings(s);
  const jev = j.apiKey ? new JevClient(j) : null;
  if (jev) jev.trace = trace;
  return { gh, tg, jev, settings: s };
}

function feedbackEnv(s: Settings): FeedbackEnv {
  const j = jevSettings(s);
  return {
    version: chrome.runtime.getManifest().version,
    commit: __BUILD_COMMIT__,
    provider: j.provider,
    model: j.model,
    testMode: s.testMode,
    time: new Date().toISOString(),
  };
}

/** The trace a card's result names, if the worker still has it. */
async function traceOf(report: FeedbackReport) {
  const id = (report.result as { trace_id?: unknown } | null)?.trace_id;
  return typeof id === "string" ? traces.get(id).catch(() => null) : null;
}

/** A judge request's result gets a `trace_id`, and its Jev calls are kept under it. */
async function handle<R extends Request>(
  req: R,
  trusted: boolean,
  shared: Shared = {},
): Promise<ResponseMap[R["type"]]> {
  if (!TRACED.has(req.type)) return handleOne(req, trusted, undefined, shared);
  const calls: JevCall[] = [];
  const value = await handleOne(req, trusted, calls, shared);
  if (value && typeof value === "object" && calls.length) {
    const id = crypto.randomUUID();
    try {
      await traces.put(id, { at: new Date().toISOString(), request: req, calls });
      (value as { trace_id?: string }).trace_id = id;
    } catch (e) {
      // Feedback then goes without the calls; the card itself is unaffected.
      console.warn("could not keep the Jev trace:", e);
    }
  }
  return value;
}

/** Messages only the extension's own pages (the settings page) may send: they read the keys or change settings
 *  (test mode among them). Content scripts run inside github.com and testgrid.k8s.io pages. */
const TRUSTED_ONLY = new Set<Request["type"]>(["settings.set", "settings.test"]);

async function handleOne<R extends Request>(
  req: R,
  trusted: boolean,
  trace?: JevCall[],
  shared: Shared = {},
): Promise<ResponseMap[R["type"]]> {
  type Out = ResponseMap[R["type"]];
  if (!trusted && TRUSTED_ONLY.has(req.type)) throw new Error(`${req.type} is only for the settings page`);
  switch (req.type) {
    case "settings.get": {
      const s = await loadSettings();
      return {
        // A content script learns whether keys are set (configured), never the keys.
        settings: trusted ? s : { ...s, githubToken: "", typesafeApiKey: "", openrouterApiKey: "" },
        configured: { github: Boolean(s.githubToken), jev: Boolean(jevSettings(s).apiKey) },
      } as Out;
    }
    case "settings.set":
      await saveSettings(req.settings);
      return { ok: true } as Out;
    case "settings.test": {
      const s = await loadSettings();
      const github = await new GitHubClient(s.githubToken)
        .viewer()
        .then((u) => ({ ok: true, detail: `authenticated as ${u.login}` }))
        .catch((e: Error) => ({ ok: false, detail: e.message }));
      let jevCheck: { ok: boolean; detail: string };
      try {
        const jev = new JevClient(jevSettings(s));
        const r = await jev.ask<{ ping: { noul: number } }>(
          { text: "ping" },
          { ping: { type: "noul", instructions: { question: "Is the `text` exactly 'ping'?" } } },
        );
        jevCheck = { ok: true, detail: `ok (${r.usage.input_tokens} input tokens)` };
      } catch (e) {
        jevCheck = { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
      return { github, jev: jevCheck } as Out;
    }
    case "options.open":
      await chrome.runtime.openOptionsPage();
      return { ok: true } as Out;
    case "board.fields": {
      const { gh } = await clients(trace, shared);
      return (await gh.fields(req.board)) as Out;
    }
    case "column.items": {
      const { gh } = await clients(trace, shared);
      return (await gh.itemsIn(req.board, req.column)) as Out;
    }
    case "item.lookup": {
      const { gh } = await clients(trace, shared);
      return (await findOnBoards(gh, req.repo, req.number)) as Out;
    }
    case "item.judge": {
      const { gh, jev } = await clients(trace, shared);
      if (!jev) throw new Error("Jev key not set: open the extension options");
      const detail = await gh.itemDetail(req.item.repository, req.item.type, req.item.number);
      const r = await judge(req.item, detail, jev);
      r.prow_fixes = await fixes(detail, jev);
      return r as Out;
    }
    case "todo.judge": {
      const { gh, tg, jev } = await clients(trace, shared);
      if (!jev) throw new Error("Jev key not set: open the extension options");
      const { repository: repo, number: num } = req.item;
      const [detail, prs] = await Promise.all([gh.itemDetail(repo, "Issue", num), gh.linkedPrs(repo, num)]);
      const r = await judgeTodo(req.item, detail, prs, tg, jev);
      r.prow_fixes = await fixes(detail, jev);
      return r as Out;
    }
    case "progress.judge": {
      const { gh, jev } = await clients(trace, shared);
      if (!jev) throw new Error("Jev key not set: open the extension options");
      const { repository: repo, number: num } = req.item;
      const detail = await gh.itemDetail(repo, "Issue", num);
      const f = {
        timeline: (r: string, n: number) => gh.timeline(r, n),
        prLastCommit: (r: string, n: number) => gh.prLastCommit(r, n),
      };
      const r = await judgeProgress(req.item, detail, f, jev);
      r.prow_fixes = await fixes(detail, jev);
      return r as Out;
    }
    case "review.judge": {
      const { gh, jev } = await clients(trace, shared);
      if (!jev) throw new Error("Jev key not set: open the extension options");
      const { repository: repo, number: num } = req.item;
      const [detail, ps, tl] = await Promise.all([
        gh.itemDetail(repo, "PullRequest", num),
        gh.pullState(repo, num),
        gh.timeline(repo, num),
      ]);
      const base = await judgeReview(req.item, detail, ps, tl, (r, n) => gh.refState(r, n), jev);
      let candidates: Candidate[] = [];
      let note = "";
      if (decideReview(base).action === "new_ask") {
        try {
          const files = (detail.files ?? []).map((f) => f.path);
          const count = new Map<string, number>();
          for (const f of files) {
            const d = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
            count.set(d, (count.get(d) ?? 0) + 1);
          }
          const dirs = [...count]
            .sort((a, b) => b[1] - a[1])
            .map(([d]) => d)
            .filter(Boolean)
            .slice(0, 3);
          const now = Date.now();
          const [hist, owners] = await Promise.all([
            reviewHistory(gh, repo, ps.author, files, dirs, now),
            Promise.all(dirs.map((d) => nearestOwners({ raw: (r, p) => gh.rawFile(r, p) }, repo, d))),
          ]);
          const exclude = [
            ...base.engaged.map((e) => e.login),
            ...base.declined,
            ...base.asked.map((a) => a.login),
          ];
          const pool = blend(ps.author, files.slice(0, 5), dirs, hist, owners, exclude, now);
          const pick = await pickReviewers(
            jev,
            { repository: repo, title: detail.title, author: ps.author, changed_files: files.slice(0, 30) },
            pool,
          );
          candidates = pick.picks;
          note = pool.length
            ? `${pool.length} candidates from review history and OWNERS; Jev picked ${candidates.length}`
            : "no one with review history on these files";
        } catch (e) {
          note = `reviewer search failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      const out: ReviewResult = {
        ...base,
        candidates,
        candidates_note: note,
        prow_fixes: await fixes(detail, jev),
      };
      return out as Out;
    }
    case "approve.judge": {
      const { gh, jev } = await clients(trace, shared);
      if (!jev) throw new Error("Jev key not set: open the extension options");
      const { repository: repo, number: num } = req.item;
      const [detail, ps, tl] = await Promise.all([
        gh.itemDetail(repo, "PullRequest", num),
        gh.pullState(repo, num),
        gh.timeline(repo, num),
      ]);
      const r = await judgeReview(req.item, detail, ps, tl, (x, n) => gh.refState(x, n), jev);
      const base = { ...r, kind: "approve" as const };
      let candidates: Candidate[] = [];
      let note = "";
      if (decideApprove(base).action === "new_ask") {
        try {
          const files = (detail.files ?? []).map((f) => f.path);
          const dirs = topDirs(files);
          const reader = { raw: (x: string, p: string) => gh.rawFile(x, p) };
          // Prow's notifier says which OWNERS files still need an approver; without it, every changed file's.
          const required = unapprovedOwners(detail.comments) ?? [...new Set(files.map(dirOf))].slice(0, 6);
          const [hist, chains] = await Promise.all([
            reviewHistory(gh, repo, ps.author, files, dirs, Date.now()),
            Promise.all(required.map((d) => ownersChain(reader, repo, d))),
          ]);
          const eligible = new Map<string, string>();
          const emeritus = new Set<string>();
          const canApprove = new Map<string, Set<string>>();
          chains.forEach((c, i) => {
            canApprove.set(required[i]!, new Set(c.approvers.keys()));
            for (const [u, d] of c.approvers) if (!eligible.has(u)) eligible.set(u, d);
            c.emeritus.forEach((u) => emeritus.add(u));
          });
          const exclude = [
            ...base.declined,
            ...base.asked_all.map((a) => a.login),
            ...base.engaged.map((e) => e.login),
          ];
          const ranked = blendApprovers(
            ps.author,
            files.slice(0, 5),
            dirs,
            hist,
            eligible,
            emeritus,
            exclude,
          );
          const cover = coverApprovers(ranked, canApprove);
          candidates = cover.picks;
          const owners = (x: string) => (x ? `${x}/OWNERS` : "/OWNERS");
          note = candidates.length
            ? `${eligible.size} approvers can approve ${required.length ? required.map(owners).join(", ") : "these files"}; ranked by who approved this code lately` +
              (cover.uncovered.length
                ? `; the /cc does not cover ${cover.uncovered.map(owners).join(", ")}`
                : "")
            : "no OWNERS approver found for these files";
        } catch (e) {
          note = `approver search failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      const out: ApproveResult = {
        ...base,
        candidates,
        candidates_note: note,
        prow_fixes: await fixes(detail, jev),
      };
      return out as Out;
    }
    case "author.judge": {
      const { gh, jev } = await clients(trace, shared);
      if (!jev) throw new Error("Jev key not set: open the extension options");
      const { repository: repo, number: num } = req.item;
      const [detail, ps, tl] = await Promise.all([
        gh.itemDetail(repo, "PullRequest", num),
        gh.pullState(repo, num),
        gh.timeline(repo, num),
      ]);
      // Triage's verdict on whether the PR belongs on the board at all.
      const [r, scope] = await Promise.all([
        judgeReview(req.item, detail, ps, tl, (x, n) => gh.refState(x, n), jev, Date.now(), {
          authorCheckins: true,
        }),
        judge(req.item, detail, jev),
      ]);
      const out: AuthorResult = {
        ...r,
        kind: "author",
        scope: { verdict: scope.verdict, why: scope.why },
        readings: [
          ...noulReading(
            "SIG Node CI work (belongs on the board)",
            scope.answers.in_scope,
            scope.verdict === "REMOVE",
          ),
          ...(r.readings ?? []),
        ],
        candidates: [],
        candidates_note: "",
        prow_fixes: await fixes(detail, jev),
      };
      return out as Out;
    }
    case "bugs.judge": {
      const { gh, jev } = await clients(trace, shared);
      if (!jev) throw new Error("Jev key not set: open the extension options");
      const detail = await gh.itemDetail(req.item.repository, "Issue", req.item.number);
      const r = await judgeBug(req.item, detail, jev);
      r.prow_fixes = await fixes(detail, jev);
      return r as Out;
    }
    case "info.judge": {
      const { gh, jev } = await clients(trace, shared);
      if (!jev) throw new Error("Jev key not set: open the extension options");
      const { repository: repo, number: num } = req.item;
      const [detail, tl] = await Promise.all([gh.itemDetail(repo, "Issue", num), gh.timeline(repo, num)]);
      const r = await judgeInfo(req.item, detail, tl, jev);
      r.prow_fixes = await fixes(detail, jev);
      return r as Out;
    }
    case "dra.judge": {
      const { gh, jev } = await clients(trace, shared);
      if (!jev) throw new Error("Jev key not set: open the extension options");
      const { repository: repo, number: num } = req.item;
      return (await judgeDra(req.column, req.item, jev, {
        detail: () => gh.itemDetail(repo, "Issue", num),
        linkedPrs: () => gh.linkedPrs(repo, num),
      })) as Out;
    }
    case "backlog.judge": {
      const { gh, jev } = await clients(trace, shared);
      if (!jev) throw new Error("Jev key not set: open the extension options");
      const { repository: repo, number: num } = req.item;
      const [detail, prs] = await Promise.all([gh.itemDetail(repo, "Issue", num), gh.linkedPrs(repo, num)]);
      const f = {
        timeline: (r: string, n: number) => gh.timeline(r, n),
        prLastCommit: (r: string, n: number) => gh.prLastCommit(r, n),
      };
      const r = await judgeBacklog(req.item, detail, prs, f, jev);
      r.prow_fixes = await fixes(detail, jev);
      return r as Out;
    }
    case "backlog.duplicates": {
      const { gh, jev } = await clients(trace, shared);
      if (!jev) throw new Error("Jev key not set: open the extension options");
      return (await bugDuplicates(gh, jev, req.board, req.targets)) as Out;
    }
    case "todo.duplicates": {
      const { gh, jev } = await clients(trace, shared);
      if (!jev) throw new Error("Jev key not set: open the extension options");
      return (await duplicates(gh, jev, req.board, req.targets)) as Out;
    }
    case "tg.judge": {
      const { gh, tg, jev, settings } = await clients(trace, shared);
      if (!jev) throw new Error("Jev key not set: open the extension options");
      return (await judgeTg(
        {
          table: (ref) => tg.table(ref),
          search: (qs, n) => gh.searchIssues(qs, n),
          issueText: (repo, n) => gh.issueText(repo, n, settings.testMode ? TG_TEST_REPO : undefined),
          threads: (repo, ns) => gh.issueThreads(repo, ns),
          jev,
        },
        req.ref,
        req.status,
      )) as Out;
    }
    case "ci.checks": {
      const { gh } = await clients(trace, shared);
      return prChecks(await gh.pullChecks(req.repo, req.number)) as Out;
    }
    case "ci.judge": {
      const { gh, tg, jev } = await clients(trace, shared);
      if (!jev) throw new Error("Jev key not set: open the extension options");
      const deps: CiDeps = {
        pull: (repo, n) => gh.pullChecks(repo, n),
        diff: (repo, n, sha) => gh.pullDiff(repo, n, sha),
        resolvePresubmit: (job) => tg.resolvePresubmit(job),
        failedTable: (ref) => tg.failedTable(ref),
        search: (qs, n) => gh.searchIssues(qs, n),
        jev,
      };
      return (await judgeCi(deps, req.repo, req.number, req.check)) as Out;
    }
    case "issue.scope": {
      const { gh } = await clients(trace, shared);
      return inScope(await gh.labels(req.repo, req.number)) as Out;
    }
    case "issue.ci":
    case "issue.dups": {
      const { gh, tg, jev } = await clients(trace, shared);
      if (!jev) throw new Error("Jev key not set: open the extension options");
      const detail = await gh.itemDetail(req.repo, "Issue", req.number);
      if (!inScope(detail.labels.map((l) => l.name))) return null as Out;
      if (req.type === "issue.dups")
        return (await judgeRelated(
          {
            search: (qs, n) => gh.searchIssues(qs, n),
            threads: (repo, ns) => gh.issueThreads(repo, ns),
            jev,
          },
          req.repo,
          req.number,
          detail,
        )) as Out;
      const deps = { tg, jev };
      const prs = await gh.linkedPrs(req.repo, req.number);
      return (await judgeIssueCi(deps, req.repo, req.number, detail, prs)) as Out;
    }
    case "tg.apply": {
      // In test mode, TestGrid writes go to the test repo only (TG_TEST_REPO): a new issue is opened there, and a
      // comment meant for another repo's issue goes on that issue's mirror there. With test mode off they go to the
      // real issue, in TG_LIVE_REPOS only. Either way only bodies this extension drafted are written.
      const { gh, settings } = await clients(trace, shared);
      const wrote: string[] = [];
      for (const st of req.steps) {
        if (!isTgDraft(st.body)) throw new Error("refusing a body the extension did not draft");
        if (!settings.testMode && !TG_LIVE_REPOS.includes(st.repo))
          throw new Error(`refusing a write to ${st.repo}`);
      }
      // Where a comment for `repo#number` lands: the issue itself, or its mirror in test mode (null: no mirror yet).
      const commentTarget = async (repo: string, number: number): Promise<[string, number] | null> => {
        if (!settings.testMode) return [repo, number];
        const title = mirrorTitle(repo, number);
        const all = await gh.paged<{ number: number; title: string }>(`/repos/${TG_TEST_REPO}/issues`, {
          state: "all",
        });
        const m = all.find((x) => x.title === title);
        return m ? [TG_TEST_REPO, m.number] : null;
      };
      for (const st of req.steps) {
        // An earlier Apply (another tab, a retry) may have posted this job's comment since the judge read the thread.
        // Only this extension's own comments count, by whole job name: whether anyone else already reported the job
        // was Jev's call when judging, and a plain substring test would also match a longer job's name.
        if (st.kind === "comment" && st.names.length) {
          const at = await commentTarget(st.repo, st.number);
          const ours = at
            ? (await gh.paged<{ body?: string }>(`/repos/${at[0]}/issues/${at[1]}/comments`)).filter((c) =>
                isTgDraft(c.body ?? ""),
              )
            : [];
          if (ours.some((c) => st.names.some((n) => namesWhole(c.body ?? "", n)))) {
            wrote.push(`${st.repo}#${st.number} already has this job's comment: not commented again`);
            continue;
          }
        }
        if (st.kind === "issue") {
          const repo = settings.testMode ? TG_TEST_REPO : st.repo;
          const labels = st.labels.filter((l) => ["kind/failing-test", "kind/flake", "sig/node"].includes(l));
          // An open issue with the same title (an earlier Accept, or a create that timed out after GitHub made it)
          // is the one to keep, not a second copy. The test repo is small enough to list. On kubernetes/kubernetes,
          // search finds anyone's, and the user's own recent issues are listed too: search lags new issues.
          type Open = { number: number; title: string; pull_request?: unknown };
          const open: Open[] = settings.testMode
            ? await gh.paged<Open>(`/repos/${repo}/issues`, { state: "open" })
            : (
                await Promise.all([
                  gh.searchIssues([titleQuery(repo, st.title)], 20).then((r) => r[0] ?? []),
                  gh.viewer().then((me) =>
                    gh.paged<Open>(`/repos/${repo}/issues`, {
                      state: "open",
                      creator: me.login,
                      since: new Date(Date.now() - 7 * 86_400_000).toISOString(),
                    }),
                  ),
                ])
              ).flat();
          const same = open.find((x) => !x.pull_request && x.title === st.title);
          if (same) {
            wrote.push(`${repo}#${same.number}`);
            continue;
          }
          const n = await gh.createIssue(repo, st.title, st.body, labels);
          if (!settings.testMode && labels.length) await gh.comment(repo, n, prowLabels(labels));
          wrote.push(`${repo}#${n}`);
        } else if (!settings.testMode) {
          await gh.comment(st.repo, st.number, st.body);
          wrote.push(`${st.repo}#${st.number}`);
        } else {
          const title = mirrorTitle(st.repo, st.number);
          const all = await gh.paged<{ number: number; title: string }>(`/repos/${TG_TEST_REPO}/issues`, {
            state: "all",
          });
          const n =
            all.find((x) => x.title === title)?.number ??
            (await gh.createIssue(
              TG_TEST_REPO,
              title,
              // In backticks: a link from this repo would show up on the real issue's timeline.
              `Stands in for \`${st.repo}#${st.number}\` while the TestGrid review is in test mode.`,
              [],
            ));
          await gh.comment(TG_TEST_REPO, n, st.body);
          wrote.push(`${TG_TEST_REPO}#${n}`);
        }
      }
      return { wrote } as Out;
    }
    case "feedback.preview": {
      const s = await loadSettings();
      const trace = await traceOf(req.report);
      const env = feedbackEnv(s);
      const all = renderFeedback(req.report, env, trace, Number.POSITIVE_INFINITY);
      const head = feedbackHead(req.report, env, trace);
      return {
        repo: FEEDBACK_REPO,
        title: all.title,
        head,
        calls: trace?.calls.length ?? 0,
        attachedKb: Math.round((all.body.length - head.length) / 1024),
        gist: renderFeedback(req.report, env, trace).comments.length > 0,
      } as Out;
    }
    case "feedback.submit": {
      // The one write outside the boards and TestGrid: an issue on this extension's repo, in test mode too (it is
      // about the extension), built here from the report, never a body the page wrote.
      const s = await loadSettings();
      const repo = FEEDBACK_REPO;
      const trace = await traceOf(req.report);
      const env = feedbackEnv(s);
      let gist: string | undefined;
      const fallback = (e: unknown) =>
        ({
          opened: null,
          error: e instanceof Error ? e.message : String(e),
          prefill: prefilled(repo, req.report, env, trace, gist),
          ...(gist ? { gist } : {}),
        }) as Out;
      if (!s.githubToken) return fallback(new Error("GitHub token not set"));
      const gh = new GitHubClient(s.githubToken);
      let out = renderFeedback(req.report, env, trace);
      // Attachments too big for the issue body go to a secret gist on the reader's account, linked from the issue.
      // Without the gist scope they stay in comments on the issue (or on the clipboard, below).
      const makeGist = async () => {
        try {
          gist = await gh.createGist(out.title, gistFiles(req.report, env, trace));
        } catch (e) {
          console.warn("feedback gist failed:", e);
        }
      };
      if (out.comments.length) {
        await makeGist();
        if (gist) out = renderFeedback(req.report, env, trace, undefined, gist);
      }
      let n: number;
      try {
        n = await gh.createIssue(repo, out.title, out.body, ["feedback"]);
      } catch (e) {
        // A fine-grained token for the kubernetes org cannot open issues here: the reader files it by hand, linking
        // the gist when the token may make one, so there is nothing to paste.
        if (!gist) await makeGist();
        return fallback(e);
      }
      // The rest of the attachments; the issue stands even if one fails.
      for (const c of out.comments) {
        try {
          await gh.comment(repo, n, c);
        } catch (e) {
          console.warn("feedback attachment comment failed:", e);
          break;
        }
      }
      return { opened: `https://github.com/${repo}/issues/${n}`, ...(gist ? { gist } : {}) } as Out;
    }
    case "item.apply": {
      // The only board write path. Refused unless the board takes writes (a test copy, or any known board with test
      // mode off), and every step
      // must touch only the one item named: a Status move of that project item, or a Prow triage comment on the
      // issue / PR that GitHub says is behind it.
      const { gh, settings } = await clients(trace, shared);
      if (!writesTo(knownBoard(req.board), settings.testMode))
        throw new Error(
          `${req.board.owner}/${req.board.number} is read-only${settings.testMode ? " in test mode" : " in this extension"}`,
        );
      const target = await gh.projectItem(req.board, req.restId);
      if (!target) throw new Error(`project item ${req.restId} has no issue or PR behind it`);
      for (const st of req.steps) {
        const ok =
          st.kind === "move"
            ? st.restId === req.restId
            : st.kind === "comment" &&
              st.repo === target.repository &&
              st.number === target.number &&
              isDraftedComment(st.body);
        if (!ok) throw new Error(`refusing a step outside ${target.repository}#${target.number}`);
      }
      // In order: comments first, then the move, as the CLI runs them.
      for (const st of req.steps) {
        if (st.kind === "comment") await gh.comment(st.repo, st.number, st.body);
        else await gh.moveItem(req.board, st.restId, st.lane);
      }
      return { ok: true } as Out;
    }
  }
}

/** MV3 stops a service worker after ~30s without extension API activity; a slow Jev call plus retries can take
 *  longer. While any request is in flight, a cheap API call every 20s keeps the worker alive. */
let inFlight = 0;
let keepAlive: ReturnType<typeof setInterval> | null = null;
function track<T>(p: Promise<T>): Promise<T> {
  if (inFlight++ === 0) keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);
  return p.finally(() => {
    if (--inFlight === 0 && keepAlive) {
      clearInterval(keepAlive);
      keepAlive = null;
    }
  });
}

chrome.runtime.onMessage.addListener((req: Request, sender, sendResponse: (e: Envelope<unknown>) => void) => {
  // The extension's own pages are served from its origin; content scripts report the web page's URL.
  const trusted = sender.id === chrome.runtime.id && (sender.url ?? "").startsWith(chrome.runtime.getURL(""));
  track(handle(req, trusted))
    .then((value) => sendResponse({ ok: true, value }))
    .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  return true; // async response
});

/** A batch (shared/messages.ts sendEach): requests from one click, answered one by one over the port as each
 *  finishes, through one set of clients, at most BATCH_PARALLEL at once. */
const BATCH_PARALLEL = 3;
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== BATCH_PORT) return;
  const trusted =
    port.sender?.id === chrome.runtime.id && (port.sender?.url ?? "").startsWith(chrome.runtime.getURL(""));
  let open = true;
  port.onDisconnect.addListener(() => (open = false));
  port.onMessage.addListener((msg: { reqs: Request[] }) => {
    const shared: Shared = {};
    const post = (m: unknown) => open && port.postMessage(m);
    void track(
      pool(
        BATCH_PARALLEL,
        msg.reqs.map((req, i) => async () => {
          if (!open) return;
          try {
            post({ i, env: { ok: true, value: await handle(req, trusted, shared) } });
          } catch (e) {
            post({ i, env: { ok: false, error: e instanceof Error ? e.message : String(e) } });
          }
        }),
      ),
    ).then(() => post({ done: true }));
  });
});

chrome.runtime.onInstalled.addListener(() => {
  dropOldCache().catch((e: unknown) => console.warn("could not remove the old cache:", e));
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});
