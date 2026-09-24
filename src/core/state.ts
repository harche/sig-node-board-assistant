/** The JSON object Jev reads. Each question's `evidence` list names the fields it should weigh (advisory text for
 *  the model, not addressing the client enforces). Only what the
 *  questions need: bot comments and labels are noise. */
import { isBot } from "./boards";
import { signals, TEST_PATH } from "./signals";
import type { BoardItem, ItemDetail, ItemKind, TriageState } from "./types";

export const MAX_STATE_CHARS = 40_000;

/** Byte-comparable size measure. Python's json.dumps uses ", " and ": " separators and escapes non-ASCII; this
 *  reproduces that so the truncation thresholds match the reference implementation. */
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
    .filter((c) => !isBot(c.author.login) && c.body.trim())
    .map((c) => ({ author: c.author.login, text: c.body.slice(0, 1000) }))
    .slice(-10);
  const st: TriageState = {
    type: kind === "PullRequest" ? "pull request" : "issue",
    repository: item.repository,
    title: d.title,
    description: (d.body ?? "").slice(0, 8000),
    human_comments: human,
  };
  // Every human /sig or /area routing comment, however old: the last-10 window below would drop early ones, and
  // the owner question is told a human /sig comment is strong evidence.
  const routing = signals(d, kind).human_slash_routing_comments.map((r) => ({
    author: r.who,
    command: r.cmd,
  }));
  if (routing.length) st.human_routing = routing;
  if (kind === "PullRequest") {
    const files = (d.files ?? []).map((f) => f.path);
    st.changed_files = {
      test_or_ci: files.filter((f) => TEST_PATH.test(f)).slice(0, 40),
      other: files.filter((f) => !TEST_PATH.test(f)).slice(0, 40),
    };
  }
  if (pyJsonLength(st) > MAX_STATE_CHARS) st.human_comments = human.slice(-3); // 1) keep only the last 3 comments
  while (pyJsonLength(st) > MAX_STATE_CHARS && st.description) {
    // 2) trim the description from the tail; stop once it is gone (the rest is bounded: 3 comments x 1000, 80 paths)
    const cut = Math.max(0, st.description.length - (pyJsonLength(st) - MAX_STATE_CHARS) - 200);
    st.description = cut > 0 ? st.description.slice(0, cut) + "\n(truncated)" : "(truncated)";
    if (cut === 0) break;
  }
  return st;
}
