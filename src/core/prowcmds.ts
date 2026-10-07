/** Broken Prow commands: a comment line Prow ignored (`/assing @x`, `/triage accept`, `triage/accept`,
 *  `/priority imporant-soon`), so the assignment or label it asked for never happened. Code flags lines that are not
 *  a known command with valid arguments (a fixed list); Jev says which command was meant, or that the line was
 *  never a command; code writes the fix with the original arguments. */
import { isBot } from "./boards";
import type { JevClient } from "./jev";
import { PRIORITY_CHOICES } from "./policy";
import type { ItemDetail, JevChoice, JevUsage } from "./types";

/** Prow's commands (prow.k8s.io/command-help), enough to tell a real one from a typo. */
export const PROW_COMMANDS = [
  "approve",
  "area",
  "assign",
  "cc",
  "cherry-pick",
  "cherrypick",
  "close",
  "retitle",
  "hold",
  "unhold",
  "joke",
  "kind",
  "label",
  "lgtm",
  "lifecycle",
  "milestone",
  "ok-to-test",
  "override",
  "priority",
  "release-note-none",
  "remove-area",
  "remove-kind",
  "remove-label",
  "remove-lifecycle",
  "remove-priority",
  "remove-sig",
  "remove-triage",
  "reopen",
  "retest",
  "retest-required",
  "sig",
  "skip",
  "test",
  "triage",
  "unassign",
  "uncc",
  "help",
  "remove-help",
  "good-first-issue",
  "remove-good-first-issue",
  "lint",
  "shrug",
  "unshrug",
  "meow",
  "meowvie",
  "woof",
  "bark",
  "pony",
  "honk",
  "transfer-issue",
  "verify-owners",
  "check-cla",
  "easycla",
  "remove-release-note-none",
  "release-note-edit",
];

const VALUES: Record<string, string[]> = {
  triage: ["accepted", "needs-information", "duplicate", "not-reproducible", "unresolved"],
  priority: PRIORITY_CHOICES,
  kind: [
    "bug",
    "feature",
    "cleanup",
    "documentation",
    "failing-test",
    "flake",
    "regression",
    "support",
    "api-change",
    "deprecation",
    "design",
  ],
};
VALUES["remove-priority"] = VALUES.priority!;
VALUES["remove-triage"] = VALUES.triage!;
VALUES["remove-kind"] = VALUES.kind!;

/** Commands a fix may post: routing, labels and assignment. Never /lgtm, /approve, /close or /reopen: those are a
 *  person's decision, and posting them would make it the extension user's. Nor /unassign or /uncc: taking someone
 *  off goes through In progress's unassign, with its reason. */
export const FIXABLE = new Set([
  "assign",

  "cc",

  "triage",
  "priority",
  "kind",
  "sig",
  "area",
  "hold",
  "unhold",
  "remove-priority",
  "remove-triage",
  "remove-kind",
  "remove-sig",
  "remove-area",
  "remove-lifecycle",
]);

export interface Suspect {
  who: string;
  wrote: string;
  cmd: string;
  args: string;
  /** Commands the line could have meant, closest first. */
  options: string[];
}

function dist(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return d[a.length]![b.length]!;
}

const closest = (x: string, xs: string[], k: number) =>
  [...xs].sort((a, b) => dist(x, a) - dist(x, b)).slice(0, k);

/** Lines Prow would have ignored, from humans. A `/word` is a suspect when the word is not a command, or when the
 *  command takes a fixed value that is not one of them; `triage/accept` style lines are labels typed as commands.
 *  Paths (`/usr/bin`) and prose are left alone: the command must be a bare lowercase word. */
export function suspects(d: ItemDetail): Suspect[] {
  const out: Suspect[] = [];
  for (const c of d.comments) {
    if (isBot(c.author.login)) continue;
    let fence = false;
    for (const raw of c.body.split("\n")) {
      if (/^\s*```/.test(raw)) fence = !fence;
      if (fence || /^\s*>/.test(raw)) continue;
      const line = raw.trim();
      let m = /^\/([a-z][a-z-]*)(?:\s+(.*))?$/.exec(line);
      if (m) {
        const cmd = m[1]!;
        const args = (m[2] ?? "").trim();
        if (!PROW_COMMANDS.includes(cmd)) {
          if (cmd.length < 3) continue;
          const opts = closest(cmd, [...FIXABLE], 4).filter(
            (o) => dist(cmd, o) <= Math.max(2, cmd.length / 3),
          );
          if (opts.length) out.push({ who: c.author.login, wrote: line, cmd, args, options: opts });
        } else if (VALUES[cmd] && args && !VALUES[cmd]!.includes(args.split(/\s+/)[0]!)) {
          out.push({
            who: c.author.login,
            wrote: line,
            cmd,
            args,
            options: closest(args.split(/\s+/)[0]!, VALUES[cmd]!, 4).map((v) => `${cmd} ${v}`),
          });
        }
        continue;
      }
      m = /^(triage|priority|kind)\/([a-z-]+)$/.exec(line);
      if (m)
        out.push({
          who: c.author.login,
          wrote: line,
          cmd: m[1]!,
          args: m[2]!,
          options: closest(m[2]!, VALUES[m[1]!]!, 4).map((v) => `${m![1]} ${v}`),
        });
    }
  }
  return out.slice(-6);
}

export interface ProwFix {
  who: string;
  wrote: string;
  fix: string;
  p: number;
}

/** Jev's reading of each suspect: which command was meant, or none. A fix is kept only when its labels are not
 *  already on the item and nobody posted the same command since. */
export async function prowFixes(
  d: ItemDetail,
  labels: string[],
  jev: JevClient,
): Promise<{ fixes: ProwFix[]; usage: JevUsage | null }> {
  const sus = suspects(d);
  if (!sus.length) return { fixes: [], usage: null };
  const q: Record<string, unknown> = {};
  sus.forEach((s, i) => {
    const comment = d.comments.find((c) => c.body.includes(s.wrote))?.body ?? s.wrote;
    q[`line_${i}`] = {
      type: "choice",
      instructions: {
        comment: comment.slice(0, 800),
        line: s.wrote,
        question: `Prow ignored the line \`${s.wrote}\` in this comment. Which Prow command did its author mean, if any?`,
      },
      criteria: {
        ...Object.fromEntries(
          s.options.map((o, k) => [
            `o${k}`,
            `/${o}${s.options[k]!.includes(" ") ? "" : " (with the line's own arguments)"}`,
          ]),
        ),
        none: "Not meant as a Prow command: prose, a path, a quote, an example or a different tool's syntax.",
      },
    };
  });
  const r = await jev.ask<Record<string, JevChoice>>(
    { note: "Prow commands are comment lines like /assign @user or /triage accepted." },
    q,
  );
  const have = new Set(labels);
  const later = d.comments.map((c) => c.body).join("\n");
  const fixes: ProwFix[] = [];
  sus.forEach((s, i) => {
    const a = r.answers[`line_${i}`];
    if (!a || a.choice === "none") return;
    const p = a.probabilities[a.choice] ?? a.confidence;
    if (p < 0.6) return;
    const opt = s.options[Number(a.choice.slice(1))];
    if (!opt) return;
    const [cmd, value] = opt.split(" ");
    if (!FIXABLE.has(cmd!)) return;
    const fix = value ? `/${cmd} ${value}` : `/${cmd}${s.args ? ` ${s.args}` : ""}`;
    // Only what the worker would post: a fix it refuses would block every action on the card.
    if (!isFixComment(fix)) return;
    if (!changesSomething(fix, have)) return; // the label came (or went) some other way
    if (later.split("\n").some((l) => l.trim() === fix)) return; // someone already posted the fix
    fixes.push({ who: s.who, wrote: s.wrote, fix, p });
  });
  return { fixes, usage: r.usage };
}

/** Whether a fix line would change a label: adding one the item has, or removing one it lacks, does nothing. */
export function changesSomething(fix: string, labels: Set<string>): boolean {
  const [cmd, ...rest] = fix.slice(1).split(/\s+/);
  const arg = rest.join(" ");
  if (cmd === "hold") return !labels.has("do-not-merge/hold");
  if (cmd === "unhold") return labels.has("do-not-merge/hold");
  if (cmd!.startsWith("remove-")) return labels.has(`${cmd!.slice("remove-".length)}/${arg}`);
  if (["triage", "priority", "kind", "sig", "area"].includes(cmd!)) return !labels.has(`${cmd}/${arg}`);
  return true;
}

/** Whether `body` is only fix lines the extension may post: FIXABLE commands, valid values, mentions only as the
 *  arguments of /assign and /cc. */
export function isFixComment(body: string): boolean {
  const lines = body.split("\n");
  return (
    lines.length > 0 &&
    lines.every((l) => {
      const m = /^\/([a-z-]+)(?:\s+(.*))?$/.exec(l);
      if (!m || !FIXABLE.has(m[1]!)) return false;
      const args = (m[2] ?? "").trim();
      if (VALUES[m[1]!]) return VALUES[m[1]!]!.includes(args);
      if (["assign", "cc"].includes(m[1]!))
        return args.split(/\s+/).every((a) => /^@[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(a));
      if (["sig", "area", "remove-sig", "remove-area", "remove-lifecycle"].includes(m[1]!))
        return /^[a-z0-9-]+$/.test(args);
      return args === ""; // hold, unhold
    })
  );
}
