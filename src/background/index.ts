/** Service worker: owns the tokens, the cache and every network call. The content script asks it questions
 *  (read-only views of GitHub plus Jev's opinion) and, on a writable board, to apply an accepted action. */
import { Cache } from "../core/cache";
import { GitHubClient } from "../core/github";
import { JevClient } from "../core/jev";
import { knownBoard } from "../core/boards";
import { findOnBoards } from "../core/lookup";
import { judge } from "../core/triage";
import type { Envelope, Request, ResponseMap } from "../shared/messages";
import { ChromeLocalStore, loadSettings, saveSettings } from "./storage";

/** The only comment Accept may post: the triage acceptance and a priority, replacing a different one if set. */
const PROW_TRIAGE = /^\/triage accepted\n(\/remove-priority [a-z-]+\n)?\/priority [a-z-]+$/;

const store = new ChromeLocalStore();
const cache = new Cache(store);

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
              PROW_TRIAGE.test(st.body);
        if (!ok) throw new Error(`refusing a step outside ${target.repository}#${target.number}`);
      }
      // In order: the Prow comment first, then the move, as the CLI runs them.
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
