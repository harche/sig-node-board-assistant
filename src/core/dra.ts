/** The Dynamic Resource Allocation board (kubernetes/95). Its New and Backlog columns share the rules below; each
 *  column adds its own for open issues.
 *
 *  New: every DRA issue and PR lands here and a maintainer moves it on. The board documents no process, so these
 *  follow its record (485 moves out of New):
 *  - PRs: merged or closed → Done, draft → In progress, otherwise In review (89–93% of their moves).
 *  - Closed issues → Done.
 *  - Open issues: Jev picks In progress, Ready or Backlog. Their record is not consistent enough to reproduce well
 *    (65% overall), so Accept moves an issue itself only when Jev says In progress at 0.95 or more (86% of their
 *    moves); every other issue is the reviewer's call, with Jev's pick suggested.
 *
 *  Backlog: later work. The board's "Item closed" workflow is off, so closed items stay until someone moves them.
 *  - PRs and closed issues as in New.
 *  - A KEP in the release being developed (milestone `v1.N` and `lead-opted-in`, which is how sig-release's
 *    release_phases.md defines "in the release") → In progress; 10 of 13 KEPs moved there had the label.
 *  - Other open issues stay. Only 9 left Backlog in two years, so Jev's reading is shown and a move is the reviewer's.
 *
 *  A move only changes the Status: the maintainers add no comments or labels. */
import { isBot } from "./boards";
import type { JevClient } from "./jev";
import { laneQuestion } from "./prompts/dra";
import { choiceReading, type Reading } from "./readings";
import type { ActionStep, BoardItem, ItemDetail, JevChoice, JevUsage, LinkedPr } from "./types";

export const IN_PROGRESS_AT = 0.95;
export const OPTED_IN = "lead-opted-in";

export const DRA_LANE = {
  in_review: "👀 In review",
  in_progress: "🏗 In progress",
  ready: "🔖 Ready",
  backlog: "📋 Backlog",
  done: "✅ Done",
} as const;

export type DraColumn = "new" | "backlog";
const COLUMN_TITLE: Record<DraColumn, string> = { new: "New", backlog: "Backlog" };

export const DRA_ACTIONS = ["in_review", "in_progress", "ready", "backlog", "done", "keep"] as const;
export type DraAction = (typeof DRA_ACTIONS)[number];

export function draLabel(a: DraAction, column: DraColumn): string {
  if (a === "keep") return `Leave in ${COLUMN_TITLE[column]}`;
  return `Move to ${DRA_LANE[a].replace(/^\S+\s/, "")}`;
}

export const DRA_TINT: Record<DraAction, "KEEP" | "REMOVE" | "BORDERLINE" | "MOVE"> = {
  in_review: "MOVE",
  in_progress: "MOVE",
  ready: "MOVE",
  backlog: "MOVE",
  done: "REMOVE",
  keep: "KEEP",
};

export interface DraResult {
  kind: "dra";
  column: DraColumn;
  item_id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  type: "Issue" | "PullRequest";
  state: "open" | "closed" | "merged";
  draft: boolean;
  assignees: string[];
  /** Issues only: PRs that reference the issue, newest last. */
  linked_prs: { repository: string; number: number; title: string; state: string; opened_days_ago: number }[];
  development_cycle: string | null;
  /** Open issues only: the issue's milestone and whether the SIG lead opted it into a release. */
  milestone: string | null;
  opted_in: boolean;
  /** Open issues only: Jev's pick of column. Null for PRs and closed issues, which code places, and for a KEP in the
   *  release, which its labels place. */
  lane: JevChoice | null;
  readings?: Reading[];
  usage: JevUsage;
  state_chars: number;
}

/** A KEP the SIG opted into the release being developed. */
export function inRelease(r: DraResult): boolean {
  return r.opted_in && r.development_cycle !== null && r.milestone === `v${r.development_cycle}`;
}

type Decision = { action: DraAction; why: string; auto: boolean };

/** The suggested action, why, and whether the header's Accept applies it without the reviewer picking it. */
export function decideDra(r: DraResult): Decision {
  if (r.type === "PullRequest") {
    if (r.state === "merged") return { action: "done", why: "merged", auto: true };
    if (r.state === "closed") return { action: "done", why: "closed without merging", auto: true };
    if (r.draft) return { action: "in_progress", why: "a draft PR", auto: true };
    return { action: "in_review", why: "an open PR, ready for review", auto: true };
  }
  if (r.state !== "open") return { action: "done", why: "closed", auto: true };
  return r.column === "new" ? decideNewIssue(r) : decideBacklogIssue(r);
}

const pick = (a: JevChoice) => {
  const p = a.probabilities[a.choice] ?? a.confidence;
  return { choice: a.choice, pct: `${Math.round(p * 100)}%`, p };
};

function decideNewIssue(r: DraResult): Decision {
  const a = r.lane;
  if (!a || !["in_progress", "ready", "backlog"].includes(a.choice))
    return { action: "keep", why: "Jev gave no column", auto: false };
  const { choice, pct, p } = pick(a);
  const action = choice as DraAction;
  if (action === "in_progress" && p >= IN_PROGRESS_AT)
    return { action, why: `Jev: work is under way (${pct})`, auto: true };
  return {
    action,
    why: `Jev's pick (${pct}); the board's past moves of issues like this vary, so it is your call`,
    auto: false,
  };
}

function decideBacklogIssue(r: DraResult): Decision {
  if (inRelease(r))
    return {
      action: "in_progress",
      why: `a KEP in the ${r.development_cycle} release: milestone ${r.milestone} and ${OPTED_IN}`,
      auto: true,
    };
  const a = r.lane;
  if (a && (a.choice === "in_progress" || a.choice === "ready")) {
    const { pct } = pick(a);
    return {
      action: a.choice,
      why: `Jev reads it as ${a.choice === "ready" ? "ready to pick up" : "under way"} (${pct}); issues rarely leave Backlog, so it is your call`,
      auto: false,
    };
  }
  return {
    action: "keep",
    why: r.opted_in
      ? `opted in for ${r.milestone ?? "an earlier release"}, not ${r.development_cycle}: later work`
      : "later work: not in the release being developed",
    auto: true,
  };
}

export function draActions(r: DraResult): DraAction[] {
  if (r.type === "PullRequest") return ["in_review", "in_progress", "done", "keep"];
  if (r.state !== "open") return ["done", "keep"];
  return r.column === "new"
    ? ["in_progress", "ready", "backlog", "done", "keep"]
    : ["in_progress", "ready", "done", "keep"];
}

export function draSteps(item: BoardItem, action: DraAction): ActionStep[] {
  if (action === "keep") return [];
  return [{ kind: "move", itemId: item.id, restId: item.restId, lane: DRA_LANE[action] }];
}

// ---------------------------------------------------------------------------------------------------- judging

/** Kubernetes minor releases by date. Later ones are assumed every 17 weeks, the release cadence. */
const RELEASES: [string, number][] = [
  ["2024-04-17", 30],
  ["2024-08-13", 31],
  ["2024-12-11", 32],
  ["2025-04-23", 33],
  ["2025-08-27", 34],
  ["2025-12-17", 35],
  ["2026-04-22", 36],
  ["2026-08-19", 37],
];
const DAY = 86_400_000;
const CADENCE = 17 * 7 * DAY;

/** The latest release and the one in development at `now`. */
export function releaseCycle(now: number): { latest: string; development: string } {
  const past = RELEASES.filter(([d]) => Date.parse(d) <= now);
  const [date, first] = past.at(-1) ?? [RELEASES[0]![0], RELEASES[0]![1] - 1];
  let minor = first;
  // Past the table: one release per cadence.
  for (let t = Date.parse(date) + CADENCE; past.length === RELEASES.length && t <= now; t += CADENCE) minor++;
  return { latest: `1.${minor}`, development: `1.${minor + 1}` };
}

const daysAgo = (at: string, now: number) => Math.round((now - Date.parse(at)) / DAY);
const NOISE = /^(needs-triage|cncf-cla|wg\/device-management)/;

/** What Jev reads for an open issue: the thread, and the facts code computes (labels, assignees, linked PRs, the
 *  release cycle). */
export function draIssueState(item: BoardItem, d: ItemDetail, prs: LinkedPr[], now: number) {
  const cycle = releaseCycle(now);
  return {
    type: "issue",
    repository: item.repository,
    title: d.title,
    description: (d.body ?? "").slice(0, 6000),
    author: d.author.login,
    opened_days_ago: daysAgo(d.createdAt, now),
    labels: d.labels.map((l) => l.name).filter((l) => !NOISE.test(l)),
    assignees: item.assignees,
    linked_prs: prs.slice(-6).map((p) => ({
      pr: `${p.repository}#${p.number}`,
      title: p.title,
      author: p.author,
      state: p.state,
      opened_days_ago: daysAgo(p.createdAt, now),
      description: p.body.slice(0, 300),
    })),
    human_comments: d.comments
      .filter((c) => !isBot(c.author.login) && c.body.trim())
      .map((c) => ({
        author: c.author.login === d.author.login ? `${c.author.login} (reporter)` : c.author.login,
        days_ago: daysAgo(c.createdAt, now),
        text: c.body.slice(0, 1000),
      }))
      .slice(-10),
    development_cycle: cycle.development,
    latest_release: cycle.latest,
  };
}

const COLUMN_NAMES = ["in_progress", "ready", "backlog"];

export async function judgeDra(
  column: DraColumn,
  item: BoardItem,
  jev: JevClient,
  fetch: { detail(): Promise<ItemDetail>; linkedPrs(): Promise<LinkedPr[]> },
  refresh = false,
  now = Date.now(),
): Promise<DraResult> {
  const r: DraResult = {
    kind: "dra",
    column,
    item_id: item.id,
    repo: item.repository,
    number: item.number,
    title: item.title,
    url: item.url,
    type: item.type,
    state: item.merged ? "merged" : item.state.toLowerCase() === "open" ? "open" : "closed",
    draft: item.draft,
    assignees: item.assignees,
    linked_prs: [],
    development_cycle: null,
    milestone: null,
    opted_in: false,
    lane: null,
    readings: [],
    usage: { input_tokens: 0, cost: 0, cached: true },
    state_chars: 0,
  };
  // PRs and closed issues are placed by code; nothing to ask.
  if (item.type === "PullRequest" || r.state !== "open") return r;
  const [d, prs] = await Promise.all([fetch.detail(), fetch.linkedPrs()]);
  const st = draIssueState(item, d, prs, now);
  r.title = d.title;
  r.development_cycle = st.development_cycle;
  r.milestone = d.milestone ?? null;
  r.opted_in = d.labels.some((l) => l.name === OPTED_IN);
  r.linked_prs = prs.slice(-6).map((p) => ({
    repository: p.repository,
    number: p.number,
    title: p.title,
    state: p.state,
    opened_days_ago: daysAgo(p.createdAt, now),
  }));
  r.state_chars = JSON.stringify(st).length;
  // A KEP in the release is placed by its labels.
  if (column === "backlog" && inRelease(r)) return r;
  const res = await jev.askCached<{ lane: JevChoice }>(st, laneQuestion(), 4, refresh);
  r.usage = { ...res.usage };
  r.lane = res.answers.lane ?? null;
  r.readings = choiceReading(
    "Column",
    r.lane && {
      ...r.lane,
      probabilities: Object.fromEntries(
        COLUMN_NAMES.map((k) => [k.replace("_", " "), r.lane!.probabilities[k] ?? 0]),
      ),
    },
  );
  return r;
}
