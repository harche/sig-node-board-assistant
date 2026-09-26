/** The Dynamic Resource Allocation board's (kubernetes/95) 'New' column: every DRA issue and PR lands here, and a
 *  maintainer moves it on. The board has no written rules, so these follow its track record (485 moves out of New):
 *
 *  - PRs: merged or closed → Done, draft → In progress, otherwise In review (89–93% of their moves).
 *  - Closed issues → Done.
 *  - Open issues: Jev picks In progress, Ready or Backlog. Their record is not consistent enough to reproduce well
 *    (65% overall), so Accept moves an issue itself only when Jev says In progress at 0.95 or more (86% of their
 *    moves); every other issue is the reviewer's call, with Jev's pick suggested.
 *
 *  A move only changes the Status: the maintainers add no comments or labels in New. */
import { isBot } from "./boards";
import type { JevClient } from "./jev";
import { laneQuestion } from "./prompts/dra";
import { choiceReading, type Reading } from "./readings";
import type { ActionStep, BoardItem, ItemDetail, JevChoice, JevUsage, LinkedPr } from "./types";

export const IN_PROGRESS_AT = 0.95;

export const DRA_LANE = {
  in_review: "👀 In review",
  in_progress: "🏗 In progress",
  ready: "🔖 Ready",
  backlog: "📋 Backlog",
  done: "✅ Done",
} as const;

export const DRA_NEW_ACTIONS = ["in_review", "in_progress", "ready", "backlog", "done", "keep"] as const;
export type DraNewAction = (typeof DRA_NEW_ACTIONS)[number];

export const DRA_NEW_LABEL: Record<DraNewAction, string> = {
  in_review: "Move to In review",
  in_progress: "Move to In progress",
  ready: "Move to Ready",
  backlog: "Move to Backlog",
  done: "Move to Done",
  keep: "Leave in New",
};

export const DRA_NEW_TINT: Record<DraNewAction, "KEEP" | "REMOVE" | "BORDERLINE" | "MOVE"> = {
  in_review: "MOVE",
  in_progress: "MOVE",
  ready: "MOVE",
  backlog: "MOVE",
  done: "REMOVE",
  keep: "KEEP",
};

export interface DraNewResult {
  kind: "dranew";
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
  /** Issues only: Jev's pick of column. Null for PRs and closed issues, which code places. */
  lane: JevChoice | null;
  readings?: Reading[];
  usage: JevUsage;
  state_chars: number;
}

const LANE_ACTION: Record<string, DraNewAction> = {
  in_progress: "in_progress",
  ready: "ready",
  backlog: "backlog",
};

/** The suggested action, why, and whether the header's Accept applies it without the reviewer picking it. */
export function decideDraNew(r: DraNewResult): { action: DraNewAction; why: string; auto: boolean } {
  if (r.type === "PullRequest") {
    if (r.state === "merged") return { action: "done", why: "merged", auto: true };
    if (r.state === "closed") return { action: "done", why: "closed without merging", auto: true };
    if (r.draft) return { action: "in_progress", why: "a draft PR", auto: true };
    return { action: "in_review", why: "an open PR, ready for review", auto: true };
  }
  if (r.state !== "open") return { action: "done", why: "closed", auto: true };
  const a = r.lane;
  const action = a ? LANE_ACTION[a.choice] : undefined;
  if (!a || !action) return { action: "keep", why: "Jev gave no column", auto: false };
  const p = a.probabilities[a.choice] ?? a.confidence;
  const pct = `${Math.round(p * 100)}%`;
  if (action === "in_progress" && p >= IN_PROGRESS_AT)
    return { action, why: `Jev: work is under way (${pct})`, auto: true };
  return {
    action,
    why: `Jev's pick (${pct}); the board's past moves of issues like this vary, so it is your call`,
    auto: false,
  };
}

export function draNewActions(r: DraNewResult): DraNewAction[] {
  if (r.type === "PullRequest") return ["in_review", "in_progress", "done", "keep"];
  if (r.state !== "open") return ["done", "keep"];
  return ["in_progress", "ready", "backlog", "done", "keep"];
}

export function draNewSteps(item: BoardItem, action: DraNewAction): ActionStep[] {
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

export async function judgeDraNew(
  item: BoardItem,
  jev: JevClient,
  fetch: { detail(): Promise<ItemDetail>; linkedPrs(): Promise<LinkedPr[]> },
  refresh = false,
  now = Date.now(),
): Promise<DraNewResult> {
  const r: DraNewResult = {
    kind: "dranew",
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
  r.linked_prs = prs.slice(-6).map((p) => ({
    repository: p.repository,
    number: p.number,
    title: p.title,
    state: p.state,
    opened_days_ago: daysAgo(p.createdAt, now),
  }));
  r.state_chars = JSON.stringify(st).length;
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
