/** Service worker: owns the tokens, the cache and every network call. The content script asks it questions
 *  (read-only views of GitHub plus Jev's opinion) and, on a writable board, to apply an accepted action. */
import { Cache, MemoryStore } from "../core/cache";
import { GitHubClient } from "../core/github";
import { JevClient } from "../core/jev";
import { knownBoard } from "../core/boards";
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
import { judgeDraNew } from "../core/dranew";
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
import { ChromeLocalStore, loadSettings, saveSettings } from "./storage";

/** Broken Prow commands in the thread and their fixes (core/prowcmds.ts); a failure here never fails the judge. */
async function fixes(detail: ItemDetail, jev: JevClient, refresh?: boolean): Promise<ProwFix[]> {
  try {
    return (
      await prowFixes(
        detail,
        detail.labels.map((l) => l.name),
        jev,
        refresh,
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
      return (await jev.askCached<{ duplicate: JevNoul; survivor: JevChoice }>(s, DUPLICATE_QUESTIONS))
        .answers;
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
      return (await jev.askCached<{ duplicate: JevNoul; survivor: JevChoice }>(s, BUG_DUPLICATE_QUESTIONS))
        .answers;
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

const store = new ChromeLocalStore();
const cache = new Cache(store);
/** TestGrid tables are tens of KB each and only good for 30 minutes: kept in the worker's memory, never in
 *  chrome.storage.local, whose 10 MB quota (overflow clears the whole cache, Jev answers too) they would eat. */
const tgCache = new Cache(new MemoryStore());

async function clients() {
  const s = await loadSettings();
  if (!s.githubToken) throw new Error("GitHub token not set: open the extension options");
  const gh = new GitHubClient(s.githubToken, cache);
  const jev = s.typesafeApiKey
    ? new JevClient({ apiKey: s.typesafeApiKey, model: s.typesafeModel }, cache)
    : null;
  return { gh, jev, settings: s };
}

async function handle<R extends Request>(req: R): Promise<ResponseMap[R["type"]]> {
  type Out = ResponseMap[R["type"]];
  switch (req.type) {
    case "settings.get": {
      const s = await loadSettings();
      return {
        settings: s,
        configured: { github: Boolean(s.githubToken), typesafe: Boolean(s.typesafeApiKey) },
      } as Out;
    }
    case "settings.set":
      await saveSettings(req.settings);
      return { ok: true } as Out;
    case "settings.test": {
      const s = await loadSettings();
      const github = await new GitHubClient(s.githubToken, cache)
        .viewer()
        .then((u) => ({ ok: true, detail: `authenticated as ${u.login}` }))
        .catch((e: Error) => ({ ok: false, detail: e.message }));
      let typesafe: { ok: boolean; detail: string };
      try {
        const jev = new JevClient({ apiKey: s.typesafeApiKey, model: s.typesafeModel }, cache);
        const r = await jev.ask<{ ping: { noul: number } }>(
          { text: "ping" },
          { ping: { type: "noul", instructions: { question: "Is the `text` exactly 'ping'?" } } },
        );
        typesafe = { ok: true, detail: `ok (${r.usage.input_tokens} input tokens)` };
      } catch (e) {
        typesafe = { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
      return { github, typesafe } as Out;
    }
    case "options.open":
      await chrome.runtime.openOptionsPage();
      return { ok: true } as Out;
    case "cache.clear":
      return { removed: await store.clearAll() } as Out;
    case "board.fields": {
      const { gh } = await clients();
      return (await gh.fields(req.board)) as Out;
    }
    case "column.items": {
      const { gh } = await clients();
      return (await gh.itemsIn(req.board, req.column, req.refresh)) as Out;
    }
    case "item.lookup": {
      const { gh } = await clients();
      return (await findOnBoards(gh, req.repo, req.number)) as Out;
    }
    case "item.judge": {
      const { gh, jev } = await clients();
      if (!jev) throw new Error("TypeSafe API key not set: open the extension options");
      const detail = await gh.itemDetail(req.item.repository, req.item.type, req.item.number, req.refresh);
      const r = await judge(req.item, detail, jev, req.refresh);
      r.prow_fixes = await fixes(detail, jev, req.refresh);
      return r as Out;
    }
    case "todo.judge": {
      const { gh, jev } = await clients();
      if (!jev) throw new Error("TypeSafe API key not set: open the extension options");
      const { repository: repo, number: num } = req.item;
      const [detail, prs] = await Promise.all([
        gh.itemDetail(repo, "Issue", num, req.refresh),
        gh.linkedPrs(repo, num, req.refresh),
      ]);
      const r = await judgeTodo(req.item, detail, prs, new TestGridClient(tgCache), jev, req.refresh);
      r.prow_fixes = await fixes(detail, jev, req.refresh);
      return r as Out;
    }
    case "progress.judge": {
      const { gh, jev } = await clients();
      if (!jev) throw new Error("TypeSafe API key not set: open the extension options");
      const { repository: repo, number: num } = req.item;
      const detail = await gh.itemDetail(repo, "Issue", num, req.refresh);
      const f = {
        timeline: (r: string, n: number) => gh.timeline(r, n, req.refresh),
        prLastCommit: (r: string, n: number) => gh.prLastCommit(r, n, req.refresh),
      };
      const r = await judgeProgress(req.item, detail, f, jev, req.refresh);
      r.prow_fixes = await fixes(detail, jev, req.refresh);
      return r as Out;
    }
    case "review.judge": {
      const { gh, jev } = await clients();
      if (!jev) throw new Error("TypeSafe API key not set: open the extension options");
      const { repository: repo, number: num } = req.item;
      const [detail, ps, tl] = await Promise.all([
        gh.itemDetail(repo, "PullRequest", num, req.refresh),
        gh.pullState(repo, num, req.refresh),
        gh.timeline(repo, num, req.refresh),
      ]);
      const base = await judgeReview(req.item, detail, ps, tl, (r, n) => gh.refState(r, n), jev, req.refresh);
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
            req.refresh,
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
        prow_fixes: await fixes(detail, jev, req.refresh),
      };
      return out as Out;
    }
    case "approve.judge": {
      const { gh, jev } = await clients();
      if (!jev) throw new Error("TypeSafe API key not set: open the extension options");
      const { repository: repo, number: num } = req.item;
      const [detail, ps, tl] = await Promise.all([
        gh.itemDetail(repo, "PullRequest", num, req.refresh),
        gh.pullState(repo, num, req.refresh),
        gh.timeline(repo, num, req.refresh),
      ]);
      const r = await judgeReview(req.item, detail, ps, tl, (x, n) => gh.refState(x, n), jev, req.refresh);
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
        prow_fixes: await fixes(detail, jev, req.refresh),
      };
      return out as Out;
    }
    case "author.judge": {
      const { gh, jev } = await clients();
      if (!jev) throw new Error("TypeSafe API key not set: open the extension options");
      const { repository: repo, number: num } = req.item;
      const [detail, ps, tl] = await Promise.all([
        gh.itemDetail(repo, "PullRequest", num, req.refresh),
        gh.pullState(repo, num, req.refresh),
        gh.timeline(repo, num, req.refresh),
      ]);
      // Triage's verdict on whether the PR belongs on the board at all.
      const [r, scope] = await Promise.all([
        judgeReview(req.item, detail, ps, tl, (x, n) => gh.refState(x, n), jev, req.refresh, Date.now(), {
          authorCheckins: true,
        }),
        judge(req.item, detail, jev, req.refresh),
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
        prow_fixes: await fixes(detail, jev, req.refresh),
      };
      return out as Out;
    }
    case "bugs.judge": {
      const { gh, jev } = await clients();
      if (!jev) throw new Error("TypeSafe API key not set: open the extension options");
      const detail = await gh.itemDetail(req.item.repository, "Issue", req.item.number, req.refresh);
      const r = await judgeBug(req.item, detail, jev, req.refresh);
      r.prow_fixes = await fixes(detail, jev, req.refresh);
      return r as Out;
    }
    case "info.judge": {
      const { gh, jev } = await clients();
      if (!jev) throw new Error("TypeSafe API key not set: open the extension options");
      const { repository: repo, number: num } = req.item;
      const [detail, tl] = await Promise.all([
        gh.itemDetail(repo, "Issue", num, req.refresh),
        gh.timeline(repo, num, req.refresh),
      ]);
      const r = await judgeInfo(req.item, detail, tl, jev, req.refresh);
      r.prow_fixes = await fixes(detail, jev, req.refresh);
      return r as Out;
    }
    case "dranew.judge": {
      const { gh, jev } = await clients();
      if (!jev) throw new Error("TypeSafe API key not set: open the extension options");
      const { repository: repo, number: num } = req.item;
      return (await judgeDraNew(
        req.item,
        jev,
        {
          detail: () => gh.itemDetail(repo, "Issue", num, req.refresh),
          linkedPrs: () => gh.linkedPrs(repo, num, req.refresh),
        },
        req.refresh,
      )) as Out;
    }
    case "backlog.judge": {
      const { gh, jev } = await clients();
      if (!jev) throw new Error("TypeSafe API key not set: open the extension options");
      const { repository: repo, number: num } = req.item;
      const [detail, prs] = await Promise.all([
        gh.itemDetail(repo, "Issue", num, req.refresh),
        gh.linkedPrs(repo, num, req.refresh),
      ]);
      const f = {
        timeline: (r: string, n: number) => gh.timeline(r, n, req.refresh),
        prLastCommit: (r: string, n: number) => gh.prLastCommit(r, n, req.refresh),
      };
      const r = await judgeBacklog(req.item, detail, prs, f, jev, req.refresh);
      r.prow_fixes = await fixes(detail, jev, req.refresh);
      return r as Out;
    }
    case "backlog.duplicates": {
      const { gh, jev } = await clients();
      if (!jev) throw new Error("TypeSafe API key not set: open the extension options");
      return (await bugDuplicates(gh, jev, req.board, req.targets)) as Out;
    }
    case "todo.duplicates": {
      const { gh, jev } = await clients();
      if (!jev) throw new Error("TypeSafe API key not set: open the extension options");
      return (await duplicates(gh, jev, req.board, req.targets)) as Out;
    }
    case "item.apply": {
      // The only write path. Refused unless the board is registered as writable (the test board), and every step
      // must touch only the one item named: a Status move of that project item, or a Prow triage comment on the
      // issue / PR that GitHub says is behind it.
      const b = knownBoard(req.board);
      if (!b?.writable)
        throw new Error(`${req.board.owner}/${req.board.number} is read-only in this extension`);
      const { gh } = await clients();
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

chrome.runtime.onMessage.addListener(
  (req: Request, _sender, sendResponse: (e: Envelope<unknown>) => void) => {
    track(handle(req))
      .then((value) => sendResponse({ ok: true, value }))
      .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return true; // async response
  },
);

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});
