/** The JSON object Jev reads. Each question's `evidence` list names the fields it should weigh (advisory text for
 *  the model, not addressing the client enforces). Only what the questions need: bot comments, comments that are
 *  only Prow commands, and labels are noise. Everything else goes in whole: the description, every human comment
 *  (a PR's review-thread comments among them, in time order) and every changed file, with fit.ts's guard for a
 *  thread too long even for Jev's context. */
import { isBot, isProwOnly } from "./boards";
import { fitMiddle, fitText, MAX_STATE_CHARS, size } from "./fit";
import { signals, TEST_PATH } from "./signals";
import type { BoardItem, ItemDetail, ItemKind, TriageState } from "./types";

/** Python's json.dumps length (", " and ": " separators, non-ASCII escaped), the measure the reference reported
 *  as `state_chars`. */
export function pyJsonLength(v: unknown): number {
  return pyDumps(v).length;
}

function pyDumps(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === "string") return pyString(v);
  if (Array.isArray(v)) return `[${v.map(pyDumps).join(", ")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .map((k) => `${pyString(k)}: ${pyDumps(o[k])}`)
    .join(", ")}}`;
}

function pyString(s: string): string {
  // JSON.stringify escapes the same control characters; Python additionally escapes every non-ASCII code unit
  // as \uXXXX (ensure_ascii=True), i.e. 6 chars per UTF-16 code unit.
  const j = JSON.stringify(s);
  let extra = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7e) extra += 5;
  return j + " ".repeat(extra);
}

export function buildState(item: BoardItem, d: ItemDetail, kind: ItemKind): TriageState {
  const human = d.comments
    .filter((c) => !isBot(c.author.login) && c.body.trim() && !isProwOnly(c.body))
    .map((c) => ({ author: c.author.login, text: c.body }));
  const st: TriageState = {
    type: kind === "PullRequest" ? "pull request" : "issue",
    repository: item.repository,
    title: d.title,
    description: d.body ?? "",
    human_comments: human,
  };
  // Every human /sig or /area routing comment: the comments above leave out the ones that are only commands, and
  // the owner question is told a human /sig comment is strong evidence.
  const routing = signals(d, kind).human_slash_routing_comments.map((r) => ({
    author: r.who,
    command: r.cmd,
  }));
  if (routing.length) st.human_routing = routing;
  if (kind === "PullRequest") {
    const files = (d.files ?? []).map((f) => f.path);
    st.changed_files = {
      test_or_ci: files.filter((f) => TEST_PATH.test(f)),
      other: files.filter((f) => !TEST_PATH.test(f)),
    };
  }
  // 1) past the guard, comments go from the middle, oldest first: the first reply and the latest stay
  st.human_comments = fitMiddle(
    human,
    (kept) => size({ ...st, human_comments: kept }),
    MAX_STATE_CHARS,
    (n) => ({ author: "", text: `(${n} comments left out here: the thread is too long)` }),
  );
  // 2) then the bigger of the description (a pasted log: its middle) and the file lists (a vendor bump: halved)
  const files = st.changed_files ?? { test_or_ci: [], other: [] };
  for (let over = size(st) - MAX_STATE_CHARS; over > 0; over = size(st) - MAX_STATE_CHARS) {
    if (st.description.length > size(files) && st.description.length > over)
      st.description = fitText(st.description, st.description.length - over);
    else if (files.test_or_ci.length + files.other.length) {
      const k = files.other.length >= files.test_or_ci.length ? "other" : "test_or_ci";
      files[k] = files[k].slice(0, Math.floor(files[k].length / 2));
    } else if (st.description) st.description = "";
    else break;
  }
  return st;
}
