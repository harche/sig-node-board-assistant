/** Feedback on a card: the reader's words plus everything that produced the card, as a GitHub issue a person or a
 *  model can work from without asking. The issue carries what the card showed, the card's result as JSON, and every
 *  Jev call behind it (the exact state and questions sent, and the answers), with the build's version and commit so
 *  the policy code that turned answers into the verdict can be read at that commit.
 *  Everything this file writes into the issue is in code spans or fences: an item reference or URL in plain text
 *  would show up on the kubernetes issue's timeline, and an @login in a thread would notify that person. */
import type { JevCall } from "./jev";

/** Where feedback goes, from every page and in test mode too: it is about this extension, so it goes to its repo. */
export const FEEDBACK_REPO = "harche/sig-node-board-assistant";

/** What the page knows: the reader's words and the card as they saw it. */
export interface FeedbackReport {
  text: string;
  /** What the reader says the outcome should have been, picked from the card's own options. */
  expected?: string;
  /** Where the card was, e.g. "Board card · SIG Node Bugs · Triage". */
  surface: string;
  item?: { repo: string; number: number; url: string };
  /** What the card said, as the reader saw it (its decision text). */
  shown: string;
  /** The card's result as the worker returned it; its `trace_id` names the Jev calls behind it. */
  result: unknown;
  /** Anything else the page knows that shaped the card: board, column, the reader's picks, apply state. */
  context: Record<string, string>;
  page: string;
}

/** What the worker adds. */
export interface FeedbackEnv {
  version: string;
  commit: string;
  provider: string;
  model: string;
  testMode: boolean;
  time: string;
}

/** The Jev calls of one judge request, kept by the worker for a while (background traces). */
export interface Trace {
  at: string;
  request: unknown;
  calls: JevCall[];
}

/** GitHub refuses an issue body or comment over 65,536 characters. */
export const BODY_LIMIT = 60_000;
/** A prefilled new-issue URL past about 8 KB is refused; the body is kept under this once URL-encoded. */
export const URL_BODY_LIMIT = 6_000;

/** A fence longer than any run of backticks in `s`, so the content cannot close it. */
export function fence(s: string, lang = ""): string {
  const longest = Math.max(2, ...[...s.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${s}\n${f}`;
}

/** Inline code that `s` cannot break out of. */
export function code(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  const longest = Math.max(0, ...[...one.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return longest ? `${f} ${one} ${f}` : `${f}${one}${f}`;
}

export function feedbackTitle(r: FeedbackReport): string {
  const shown = r.shown.replace(/\s+/g, " ").trim();
  const head = `[feedback] ${r.surface}${r.item ? ` ${r.item.repo.split("/")[1]}#${r.item.number}` : ""}: `;
  const tail = r.expected ? ` → should be ${r.expected}` : "";
  const room = 140 - head.length - tail.length;
  // "#123" in a title links nothing (titles are not rendered as markdown).
  return head + (shown.length > room ? `${shown.slice(0, Math.max(0, room - 1))}…` : shown) + tail;
}

/** The part a reader skims: their words, what the card said, and where it ran. */
export function feedbackHead(r: FeedbackReport, env: FeedbackEnv, trace: Trace | null): string {
  const lines = ["### What the user says", ""];
  lines.push(r.text.trim() ? r.text.trim() : "_No comment._", "");
  if (r.expected) lines.push(`**Should have been:** ${code(r.expected)}`, "");
  lines.push("### What the card showed", "", fence(r.shown.trim() || "(nothing)", "text"), "");
  const rows: [string, string][] = [
    ["Surface", r.surface],
    ...(r.item ? ([["Item", r.item.url]] as [string, string][]) : []),
    ...Object.entries(r.context),
    ["Page", r.page],
    ["Extension", `${env.version} (${env.commit})`],
    ["Jev", `${env.provider} · ${env.model}`],
    ...(env.testMode ? ([["Test mode", "on"]] as [string, string][]) : []),
    ["Sent", env.time],
    [
      "Jev calls",
      trace
        ? `${trace.calls.length}, judged ${trace.at}`
        : "not available (the card was judged before this browser session, or by a request that keeps no trace)",
    ],
  ];
  lines.push("### Context", "", "| | |", "|---|---|", ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`));
  return lines.join("\n");
}

const cell = (v: string) => code(v).replace(/\|/g, "\\|");

/** One attachment: a label and its JSON, folded; or, for a state or questions sent before, a line saying which. */
interface Part {
  label: string;
  json: string;
  same?: string;
}

function parts(r: FeedbackReport, trace: Trace | null): Part[] {
  const out: Part[] = [{ label: "Card result", json: JSON.stringify(r.result, null, 2) }];
  const n = trace?.calls.length ?? 0;
  // Calls often share a state (TestGrid asks about each candidate issue against the same job) or questions: each is
  // written out once, and later calls point back to it.
  const seen = new Map<string, string>();
  const once = (label: string, json: string, where: string): Part => {
    const first = seen.get(json);
    if (first) return { label, json: "", same: first };
    seen.set(json, where);
    return { label, json };
  };
  trace?.calls.forEach((c, i) => {
    const ids = Object.keys(c.questions).join(", ");
    const tag = `Jev call ${i + 1}/${n} (${ids}${c.cached ? "; cached answer" : ""})`;
    out.push(once(`${tag}: questions`, JSON.stringify(c.questions, null, 2), `call ${i + 1}`));
    out.push({ label: `${tag}: answers`, json: JSON.stringify(c.answers, null, 2) });
    out.push(once(`${tag}: state sent`, JSON.stringify(c.state, null, 2), `call ${i + 1}`));
  });
  return out;
}

/** A part as folded blocks, each under `limit`: a JSON too big for one is cut into pieces, numbered in order (join
 *  the pieces to read it). */
function blocks(p: Part, limit: number): string[] {
  const wrap = (label: string, s: string) =>
    `<details><summary>${escapeHtml(label)}</summary>\n\n${fence(s, "json")}\n\n</details>`;
  if (p.same) return [`${escapeHtml(p.label)}: the same as ${p.same}'s.`];
  const whole = wrap(p.label, p.json);
  if (whole.length <= limit) return [whole];
  const size = limit - p.label.length - 200;
  const pieces: string[] = [];
  for (let i = 0; i < p.json.length; i += size) pieces.push(p.json.slice(i, i + size));
  return pieces.map((s, i) => wrap(`${p.label}, part ${i + 1}/${pieces.length}`, s));
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The issue: the head and as many attachments as fit in its body, the rest in comments, in order. With `gist`
 *  (attachments too big for the body), the issue is the head and a link: everything else is in the gist. */
export function renderFeedback(
  r: FeedbackReport,
  env: FeedbackEnv,
  trace: Trace | null,
  limit = BODY_LIMIT,
  gist?: string,
): { title: string; body: string; comments: string[] } {
  const title = feedbackTitle(r);
  const head = `${feedbackHead(r, env, trace)}\n\n### Attachments`;
  if (gist) return { title, body: `${head}\n\n${gistNote(gist, trace)}`, comments: [] };
  const all = parts(r, trace).flatMap((p) => blocks(p, limit));
  const pages: string[] = [head];
  for (const b of all) {
    const last = pages[pages.length - 1]!;
    if (last.length + b.length + 2 <= limit) pages[pages.length - 1] = `${last}\n\n${b}`;
    else pages.push(b);
  }
  return { title, body: pages[0]!, comments: pages.slice(1) };
}

function gistNote(gist: string, trace: Trace | null): string {
  return (
    `Everything behind the card is in a secret gist on the reporter's account: ${gist}\n\n` +
    (trace
      ? `- \`trace.json\`: the ${trace.calls.length} Jev calls in order, each with the state and questions sent and the answers\n`
      : "") +
    "- `result.json`: the card's result\n- `feedback.md`: this issue's text"
  );
}

/** The gist's files when the attachments are too big for the issue: whole, one JSON a program can read. */
export function gistFiles(r: FeedbackReport, env: FeedbackEnv, trace: Trace | null): Record<string, string> {
  return {
    "feedback.md": `# ${feedbackTitle(r)}\n\n${feedbackHead(r, env, trace)}\n`,
    "result.json": JSON.stringify(r.result, null, 2),
    ...(trace ? { "trace.json": JSON.stringify(trace, null, 2) } : {}),
  };
}

/** For a token that cannot open the issue: a prefilled new-issue page with the head (cut to fit a URL), and a link
 *  to the gist, or, without one, the attachments for the reader to paste (`paste` is empty with a gist). */
export function prefilled(
  repo: string,
  r: FeedbackReport,
  env: FeedbackEnv,
  trace: Trace | null,
  gist?: string,
): { url: string; paste: string } {
  const paste = gist
    ? ""
    : parts(r, trace)
        .flatMap((p) => blocks(p, Number.POSITIVE_INFINITY))
        .join("\n\n");
  const note = gist
    ? `\n\n### Attachments\n\n${gistNote(gist, trace)}\n`
    : `\n\n### Attachments\n\n_The card's result and its Jev calls (${Math.round(paste.length / 1024)} KB) were copied to the clipboard: paste them here, or in a comment if GitHub says the body is too long._\n`;
  let head = feedbackHead(r, env, trace);
  const enc = (h: string) => encodeURIComponent(h + note).length;
  while (enc(head) > URL_BODY_LIMIT && head.length > 200)
    head = `${head.slice(0, Math.floor(head.length * 0.9))}…`;
  const q = new URLSearchParams({ title: feedbackTitle(r), body: head + note, labels: "feedback" });
  return { url: `https://github.com/${repo}/issues/new?${q}`, paste };
}
