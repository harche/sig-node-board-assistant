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
import {
  closeDuplicates,
  dupFacets,
  dupState,
  isTodoComment,
  judgeTodo,
  type DuplicateOf,
} from "../core/todo";
import type { BoardItem, BoardRef, JevChoice, JevNoul } from "../core/types";
import type { Envelope, Request, ResponseMap } from "../shared/messages";
import { ChromeLocalStore, loadSettings, saveSettings } from "./storage";

/** Comments a write may post: Triage's acceptance with a priority (replacing a different one if set), or one of
 *  the To-do comments (core/todo.ts isTodoComment). */
const PROW_TRIAGE = /^\/triage accepted\n(\/remove-priority [a-z-]+\n)?\/priority [a-z-]+$/;

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
      return (await judge(req.item, detail, jev, req.refresh)) as Out;
    }
    case "todo.judge": {
      const { gh, jev } = await clients();
      if (!jev) throw new Error("TypeSafe API key not set: open the extension options");
      const { repository: repo, number: num } = req.item;
      const [detail, prs] = await Promise.all([
        gh.itemDetail(repo, "Issue", num, req.refresh),
        gh.linkedPrs(repo, num, req.refresh),
      ]);
      return (await judgeTodo(req.item, detail, prs, new TestGridClient(tgCache), jev, req.refresh)) as Out;
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
              (PROW_TRIAGE.test(st.body) || isTodoComment(st.body));
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
