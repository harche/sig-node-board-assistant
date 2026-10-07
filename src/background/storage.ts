/** The settings record in chrome.storage.local, and the Jev traces in chrome.storage.session. Tokens live in
 *  storage.local (never storage.sync), so they stay on this machine. */
import type { Trace } from "../core/feedback";
import { DEFAULT_SETTINGS, type Settings } from "../shared/messages";

const OLD_CACHE_PREFIX = "cache:";
const SETTINGS_KEY = "settings";

/** Removes what versions before 0.1.3 cached in chrome.storage.local (GitHub reads and Jev answers, up to 10 MB):
 *  nothing reads it any more. */
export async function dropOldCache(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const old = Object.keys(all).filter((k) => k.startsWith(OLD_CACHE_PREFIX));
  if (old.length) await chrome.storage.local.remove(old);
}

export async function loadSettings(): Promise<Settings> {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  const s = { ...DEFAULT_SETTINGS, ...((r[SETTINGS_KEY] as Partial<Settings> | undefined) ?? {}) };
  // A normal build has no test boards or test repo, so test mode saved by a test build must not steer its writes.
  return __TEST_BUILD__ ? s : { ...s, testMode: false };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

const TRACE_PREFIX = "trace:";
const TRACE_INDEX = "trace-index";
/** Traces kept: a column or two of cards. Each holds the states sent to Jev, tens of KB for a long thread. */
const TRACE_KEEP = 200;

/** The Jev calls behind each judged card, for feedback (core/feedback.ts), in chrome.storage.session: it outlives
 *  the service worker but not the browser session, and content scripts cannot read it. Oldest go first. */
export class TraceStore {
  private chain: Promise<unknown> = Promise.resolve();

  async get(id: string): Promise<Trace | null> {
    const r = await chrome.storage.session.get(TRACE_PREFIX + id);
    return (r[TRACE_PREFIX + id] as Trace | undefined) ?? null;
  }

  /** Writes are queued: each one rewrites the index. */
  put(id: string, t: Trace): Promise<void> {
    const run = this.chain.then(() => this.write(id, t));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async write(id: string, t: Trace): Promise<void> {
    const r = await chrome.storage.session.get(TRACE_INDEX);
    let index = [...((r[TRACE_INDEX] as string[] | undefined) ?? []), id];
    for (let attempt = 0; ; attempt++) {
      const drop = index.length > TRACE_KEEP ? index.slice(0, index.length - TRACE_KEEP) : [];
      index = index.slice(drop.length);
      if (drop.length) await chrome.storage.session.remove(drop.map((k) => TRACE_PREFIX + k));
      try {
        await chrome.storage.session.set({ [TRACE_PREFIX + id]: t, [TRACE_INDEX]: index });
        return;
      } catch (e) {
        // Over the session quota: drop the older half and try again; a trace too big on its own is not kept.
        if (attempt >= 2 || index.length <= 1) throw e;
        // At least one: with two kept, the older goes.
        const half = index.slice(0, Math.max(1, Math.floor((index.length - 1) / 2)));
        await chrome.storage.session.remove(half.map((k) => TRACE_PREFIX + k));
        index = index.slice(half.length);
      }
    }
  }
}
