/** The SIG Node Bugs board's accepted backlog: the Triaged and High Priority columns. Nothing moves a card out of
 *  them but a person, so they go stale: on kubernetes/185, 32 of 171 Triaged cards had no priority, 64 were
 *  referenced by a merged PR while still open, and 119 had not been updated in 90 days.
 *
 *  Labels decide on their own (code): closed → Done; triage/accepted gone → Needs Information or Triage; a missing
 *  priority is added (Jev's pick); the priority decides the column (critical-urgent and important-soon are High
 *  Priority, the rest Triaged). Jev reads the rest: is the bug already fixed (prompts/backlog.ts), is it the same bug
 *  as another card (the column's duplicate pass), and is each assignee still on it (the In-progress reading,
 *  inprogress.ts). What the lifecycle bot does (stale, rotten, the yearly re-triage) is left to it.
 *
 *  On board history: of 18 accepted bugs a person closed as fixed, P(fixed) ≥ 0.8 caught 3, and of 171 open Triaged
 *  cards it flagged 2, both with the fix merged; 0.5–0.8 caught 8 more and flagged 13 open cards, most of them with
 *  the fix merged too, some with work left. So ≥ 0.8 closes on Accept, 0.5–0.8 is the reviewer's call. */
import { bugLabels, bugState, laneFor, LANE, type BugLabels } from "./bugs";
import { judgeProgress, type ProgressFetcher } from "./inprogress";
import type { JevClient } from "./jev";
import { backlogQuestions } from "./prompts/backlog";
import { BUG_PRIORITIES, priorityQuestion } from "./prompts/bugs";
import { choiceReading, noulReading } from "./readings";
import { buildTodoState } from "./todo";
import type { ItemDetail, JevScore, LinkedPr } from "./types";
import type { TimelineEvent } from "./github";

import type { DuplicateOf } from "./todo";
import { COMMENT_PREFIX } from "./todo";
import { f2 } from "./policy";
import { decideProgressCard, nudgeBody, unassignBody, type ProgressResult } from "./inprogress";
import type { ProwFix } from "./prowcmds";
import type { Reading } from "./readings";
import type { ActionStep, BoardItem, JevChoice, JevNoul, JevUsage } from "./types";

export const FIXED_AT = 0.8;
export const FIXED_ASK_AT = 0.5;

export const BACKLOG_ACTIONS = [
  "keep",
  "close_fixed",
  "close_duplicate",
  "nudge",
  "unassign",
  "to_info",
  "to_triage",
  "done",
] as const;
export type BacklogAction = (typeof BACKLOG_ACTIONS)[number];

export const BACKLOG_LABEL: Record<BacklogAction, string> = {
  keep: "Keep",
  close_fixed: "Close as fixed",
  close_duplicate: "Close as a duplicate",
  nudge: "Nudge the assignee",
  unassign: "Unassign",
  to_info: "Move to Needs Information",
  to_triage: "Back to Triage",
  done: "Move to Done",
};

export const BACKLOG_TINT: Record<BacklogAction, "KEEP" | "REMOVE" | "BORDERLINE" | "MOVE"> = {
  keep: "KEEP",
  close_fixed: "REMOVE",
  close_duplicate: "REMOVE",
  nudge: "BORDERLINE",
  unassign: "BORDERLINE",
  to_info: "MOVE",
  to_triage: "MOVE",
  done: "REMOVE",
};

export interface BacklogLinkedPr {
  number: number;
  repository: string;
  title: string;
  state: "open" | "closed" | "merged";
  merged_days_ago?: number;
}

export interface BacklogResult {
  kind: "backlog";
  item_id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  /** The column the card is in. */
  status: string;
  labels: BugLabels;
  assignees: string[];
  /** Jev's reading: is the bug fixed, and how. Null when the labels already decided. */
  answers: { resolved: JevNoul; resolution: JevChoice } | null;
  linked_prs: BacklogLinkedPr[];
  /** The merged PR Jev reads as the fix, when it names one; the closing comment names only this PR. */
  fixed_by: { number: number; repository: string; merged_days_ago: number } | null;
  /** Set by the column's duplicate pass, after judging. */
  duplicate: DuplicateOf | null;
  /** The In-progress reading of the assignees; null when nobody is assigned. */
  progress: Pick<ProgressResult, "assignees" | "p_moving_on" | "sig_node"> | null;
  /** Assignees who assigned themselves (/assign). Only they are nudged or unassigned: an owner a triager assigned
   *  often holds a backlog bug for the long run, and pinging them is noise (the board owner's call). */
  self_assigned: string[];
  priority: string | null;
  priority_why: string;
  prow_fixes?: ProwFix[];
  readings?: Reading[];
  usage: JevUsage;
  state_chars: number;
}

/** The column a card belongs in by its priority, or null to leave it where it is. */
export function laneOf(r: Pick<BacklogResult, "labels" | "priority">, priority = r.priority): string | null {
  const p = r.labels.priority ?? priority;
  return p ? laneFor(p) : null;
}

/** The suggested action, why, and whether the header's Accept applies it without the reviewer picking it. `flag`
 *  marks a card that needs a person for something no action here does (a High Priority bug nobody owns): its badge
 *  says so, and Accept still applies its label fixes. */
export function decideBacklog(r: BacklogResult): {
  action: BacklogAction;
  why: string;
  auto: boolean;
  flag?: boolean;
} {
  const L = r.labels;
  if (r.state !== "open") return { action: "done", why: "closed", auto: true };
  if (!L.triage_accepted) {
    if (L.needs_information || L.not_reproducible)
      return { action: "to_info", why: "has triage/needs-information and no triage/accepted", auto: true };
    return { action: "to_triage", why: "no triage/accepted any more: it needs a triage", auto: true };
  }
  if (r.duplicate)
    return {
      action: "close_duplicate",
      why: `the same bug as #${r.duplicate.number} (${r.duplicate.status}), P ${f2(r.duplicate.p)}`,
      auto: true,
    };
  const p = r.answers?.resolved.noul ?? 0;
  if (p >= FIXED_ASK_AT)
    return {
      action: "close_fixed",
      why: `looks fixed: P ${f2(p)}${p < FIXED_AT ? ` (below ${FIXED_AT}: check the thread first)` : ""}`,
      auto: p >= FIXED_AT,
    };
  const own = selfProgress(r);
  if (own) {
    const d = decideProgressCard(own);
    if (d.action === "nudge" || d.action === "unassign") return { action: d.action, why: d.why, auto: true };
  }
  if (r.status === LANE.high && !r.assignees.length)
    return {
      action: "keep",
      why: "high priority and nobody is assigned: who takes it?",
      auto: true,
      flag: true,
    };
  return { action: "keep", why: `still open: P(fixed) ${f2(p)}`, auto: true };
}

/** The assignee reading limited to the people who assigned themselves; null when there are none. */
export function selfProgress(r: BacklogResult): BacklogResult["progress"] {
  const mine = r.progress?.assignees.filter((a) => r.self_assigned.includes(a.login)) ?? [];
  return r.progress && mine.length ? { ...r.progress, assignees: mine } : null;
}

export function backlogActions(r: BacklogResult): BacklogAction[] {
  if (r.state !== "open") return ["done", "keep"];
  const quiet = selfProgress(r)?.assignees.some((a) => a.verdict !== "active") ?? false;
  return BACKLOG_ACTIONS.filter(
    (a) =>
      a !== "done" &&
      (a !== "close_duplicate" || r.duplicate) &&
      (!["nudge", "unassign"].includes(a) || quiet || decideBacklog(r).action === a),
  );
}

const ago = (d: number) => (d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`);
const ref = (repo: string, p: { repository: string; number: number }) =>
  `${p.repository === repo ? "" : p.repository}#${p.number}`;

/** The closing comment names the fix only when Jev picked one merged PR as the fix (a PR that merely references
 *  the issue can be a test or a refactor); otherwise it points at the discussion. */
export function closeFixedBugBody(r: BacklogResult): string {
  const fix = r.fixed_by;
  const how = r.answers?.resolution.choice;
  const ev =
    how === "obsolete"
      ? "the code involved was removed or rewritten"
      : fix && how === "fixed_by_change"
        ? `${ref(r.repo, fix)} merged ${ago(fix.merged_days_ago)}`
        : "going by the discussion above";
  return `${COMMENT_PREFIX.fixed}: ${ev}. Closing; please reopen if it comes back.\n/close`;
}

export function duplicateBugBody(d: DuplicateOf, repo: string): string {
  return `${COMMENT_PREFIX.duplicate}${ref(repo, d)}, which reports the same bug. Tracking continues there.\n/close`;
}

/** What an action writes. A card that stays gets its missing priority and the move its priority calls for first. */
export function backlogSteps(
  item: BoardItem,
  r: BacklogResult,
  action: BacklogAction,
  priority: string | null = r.priority,
): ActionStep[] {
  const { repository: repo, number } = item;
  const comment = (body: string): ActionStep => ({ kind: "comment", repo, number, body });
  const move = (lane: string): ActionStep => ({ kind: "move", itemId: item.id, restId: item.restId, lane });
  const stays = (): ActionStep[] => {
    const fix =
      !r.labels.priority && priority
        ? [comment(`/priority ${priority}`)]
        : r.labels.priority && priority && priority !== r.labels.priority
          ? [comment(`/remove-priority ${r.labels.priority}\n/priority ${priority}`)]
          : [];
    const lane = priority ? laneFor(priority) : laneOf(r);
    return [...fix, ...(lane && lane !== r.status ? [move(lane)] : [])];
  };
  const quiet = (v: "nudge" | "unassign") => {
    const all = selfProgress(r)?.assignees ?? [];
    const own = all.filter((a) => a.verdict === v);
    return own.length ? own : all.filter((a) => a.verdict !== "active");
  };
  switch (action) {
    case "keep":
      return stays();
    case "done":
      return [move(LANE.done)];
    case "to_info":
      return [move(LANE.info)];
    case "to_triage":
      return [move("Triage")];
    case "close_fixed":
      return [comment(closeFixedBugBody(r)), move(LANE.done)];
    case "close_duplicate":
      return r.duplicate ? [comment(duplicateBugBody(r.duplicate, repo)), move(LANE.done)] : [];
    case "nudge":
      return [
        ...quiet("nudge").map((a) => comment(nudgeBody(a.login, a.last_activity_days_ago))),
        ...stays(),
      ];
    case "unassign":
      return [...quiet("unassign").map((a) => comment(unassignBody(a.login))), ...stays()];
  }
}

// ---------------------------------------------------------------------------------------------------- judging

/** No TestGrid: these are product bugs; the To-do state builder is reused with an empty CI signal. */
const NO_CI = { ciSignal: async () => [] } as unknown as Parameters<typeof buildTodoState>[3];

export async function judgeBacklog(
  item: BoardItem,
  d: ItemDetail,
  prs: LinkedPr[],
  f: ProgressFetcher,
  jev: JevClient,
): Promise<BacklogResult> {
  const labels = bugLabels(d.labels.map((l) => l.name));
  const usage: JevUsage = { input_tokens: 0, cost: 0 };
  const add = (u: JevUsage) => {
    usage.input_tokens += u.input_tokens;
    usage.cost += u.cost;
  };
  const st = await buildTodoState(item.repository, d, prs, NO_CI);
  const r: BacklogResult = {
    kind: "backlog",
    item_id: item.id,
    repo: item.repository,
    number: item.number,
    title: d.title,
    url: item.url,
    state: d.state.toLowerCase() === "open" ? "open" : "closed",
    status: item.status,
    labels,
    assignees: item.assignees,
    answers: null,
    linked_prs: st.linked_prs.map((p) => ({
      number: p.number,
      repository: p.repository,
      title: p.title,
      state: p.state,
      ...(p.merged_days_ago !== undefined ? { merged_days_ago: p.merged_days_ago } : {}),
    })),
    fixed_by: null,
    duplicate: null,
    progress: null,
    self_assigned: [],
    priority: labels.priority,
    priority_why: labels.priority ? "already labelled" : "",
    readings: [],
    usage,
    state_chars: JSON.stringify(st).length,
  };
  if (r.state !== "open" || !labels.triage_accepted) return r;
  if (item.assignees.length)
    r.self_assigned = selfAssigned(item.assignees, await f.timeline(item.repository, item.number));
  const [fixed, progress, prio] = await Promise.all([
    jev.ask<{ resolved: JevNoul; resolution: JevChoice }>(st, backlogQuestions()),
    item.assignees.length ? judgeProgress(item, d, f, jev) : null,
    labels.priority ? null : jev.ask<{ priority: JevScore }>(bugState(item, d), priorityQuestion()),
  ]);
  add(fixed.usage);
  r.answers = fixed.answers;
  r.readings!.push(
    ...noulReading("Already fixed", fixed.answers.resolved),
    ...choiceReading("How", fixed.answers.resolution),
  );
  // Which merged PR is the fix, asked only when the bug may be fixed and there is a merged PR to name.
  const merged = st.linked_prs.filter((p) => p.state === "merged");
  if (fixed.answers.resolved.noul >= FIXED_ASK_AT && merged.length) {
    const q = fixPrQuestion(merged);
    const pick = await jev.ask<{ fix_pr: JevChoice }>(st, q);
    add(pick.usage);
    const m = /^pr_(\d+)$/.exec(pick.answers.fix_pr.choice);
    const pr = m ? merged.find((p) => p.number === Number(m[1])) : undefined;
    if (pr && pick.answers.fix_pr.confidence >= 0.5)
      r.fixed_by = { number: pr.number, repository: pr.repository, merged_days_ago: pr.merged_days_ago ?? 0 };
    r.readings!.push(...choiceReading("The fix", pick.answers.fix_pr));
  }
  if (progress) {
    add(progress.usage);
    r.progress = {
      assignees: progress.assignees,
      p_moving_on: progress.p_moving_on,
      sig_node: progress.sig_node,
    };
    r.readings!.push(...(progress.readings ?? []));
  }
  if (prio) {
    add(prio.usage);
    const levels = [...BUG_PRIORITIES].reverse();
    let best = 0;
    let level = -1;
    levels.forEach((_, i) => {
      const v = prio.answers.priority?.probabilities[String(i)] ?? 0;
      if (v > best) [best, level] = [v, i];
    });
    r.priority = level < 0 ? "important-longterm" : levels[level]!;
    r.priority_why = level < 0 ? "default; Jev gave no level" : "Jev's pick";
    r.readings!.push(...choiceReading("Priority", prio.answers.priority, levels));
  }
  return r;
}

const PROW = new Set(["k8s-ci-robot", "kubernetes-prow[bot]", "kubernetes-prow"]);

/** Who assigned themselves: the latest `assigned` event for them was theirs, or Prow's acting on their own /assign
 *  comment (the latest /assign comment at or before the event). */
export function selfAssigned(assignees: string[], tl: TimelineEvent[]): string[] {
  const at = (e: TimelineEvent) => e.created_at ?? "";
  return assignees.filter((a) => {
    const ev = tl.filter((e) => e.event === "assigned" && e.assignee?.login === a).at(-1);
    if (!ev) return false;
    const actor = ev.actor?.login ?? "";
    if (actor === a) return true;
    if (!PROW.has(actor)) return false;
    const cmd = tl
      .filter((e) => e.event === "commented" && at(e) <= at(ev) && /^\s*\/assign\b/m.test(e.body ?? ""))
      .at(-1);
    return (cmd?.actor?.login ?? cmd?.user?.login) === a;
  });
}

/** Which of the merged linked PRs fixed the bug, or none of them. */
export function fixPrQuestion(merged: { number: number; title: string; description_start?: string }[]) {
  return {
    fix_pr: {
      type: "choice",
      instructions: {
        question: "Which of these merged pull requests fixed the bug this issue reports?",
        focus:
          "A PR that only adds a test, refactors, or fixes a related but different problem is not the fix.",
        evidence: ["title", "description", "human_comments", "linked_prs"],
      },
      criteria: {
        ...Object.fromEntries(
          merged
            .slice(-6)
            .map((p) => [`pr_${p.number}`, { title: p.title, description: p.description_start ?? "" }]),
        ),
        none: "None of these is the fix: it came some other way, or it has not landed.",
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------------- duplicates

const WORD = /[a-z0-9][a-z0-9_.-]{2,}/g;
const STOP = new Set([
  "the",
  "and",
  "for",
  "when",
  "with",
  "not",
  "are",
  "that",
  "this",
  "from",
  "pod",
  "pods",
  "kubelet",
]);

function words(s: string): Set<string> {
  return new Set((s.toLowerCase().match(WORD) ?? []).filter((w) => !STOP.has(w)));
}

/** Pairs worth asking Jev about: for each target, the `k` cards whose title and description share the most words
 *  (Jaccard at least `min`). Asking about every pair of a 170-card column would be 15,000 questions. */
export function shortlist<T extends { restId: number }>(
  // Each pair is ordered by restId (see below).
  targets: T[],
  pool: T[],
  text: (x: T) => string,
  k = 3,
  min = 0.12,
): [T, T][] {
  const w = new Map(pool.map((x) => [x.restId, words(text(x))]));
  for (const t of targets) if (!w.has(t.restId)) w.set(t.restId, words(text(t)));
  const seen = new Set<string>();
  const out: [T, T][] = [];
  for (const t of targets) {
    const a = w.get(t.restId)!;
    const scored = pool
      .filter((o) => o.restId !== t.restId)
      .map((o) => {
        const b = w.get(o.restId)!;
        const inter = [...a].filter((x) => b.has(x)).length;
        return { o, j: inter / (a.size + b.size - inter || 1) };
      })
      .filter((x) => x.j >= min)
      .sort((x, y) => y.j - x.j)
      .slice(0, k);
    for (const { o } of scored) {
      const key = [t.restId, o.restId].sort().join("-");
      if (!seen.has(key)) {
        seen.add(key);
        // Lower restId first, always: the Triaged and High Priority passes then ask Jev the same question about a
        // pair across the two columns, and agree on which card stays open.
        out.push(t.restId < o.restId ? [t, o] : [o, t]);
      }
    }
  }
  return out;
}
