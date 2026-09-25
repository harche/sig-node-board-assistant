/** 'Issues - In progress': is each assignee still on it? The CLI's sweep stale pass, rebuilt so Jev makes the
 *  judgement calls. The CLI decided with a regex for its own nudge wording, a window of comments, a "whose court
 *  is the PR in" heuristic and a days-quiet sum, and each misfired somewhere (a "/assign" on a PR read as a
 *  review). Here code hands Jev plain facts (dates, who wrote what, each linked PR's recent events) and asks: is
 *  each comment since an assignee's last activity a check-in to them, is the assignee still on it, and is the
 *  work moving through others. Code only does the date arithmetic on those answers.
 *
 *  Checked against kubernetes/151: on 2026-09-19 it reproduced the nudges and waits the board owner applied the
 *  next day (25/28, the rest borderline), and on 2026-09-25 26/26 against a hand-checked reading. */
import { isBot } from "./boards";
import type { TimelineEvent } from "./github";
import type { JevClient } from "./jev";
import type { ActionStep, BoardItem, ItemDetail, JevNoul, JevUsage } from "./types";

const DAY_MS = 86_400_000;
export const STALE_DAYS = 30;
/** A nudge counts as unanswered after this long. */
export const NUDGE_GRACE_DAYS = 14;
const MAX_LINKED_PRS = 20;

/** What the code reads through; GitHubClient fits. */
export interface ProgressFetcher {
  timeline(repo: string, num: number): Promise<TimelineEvent[]>;
  prLastCommit(repo: string, num: number): Promise<string | null>;
}

type PrSource = NonNullable<NonNullable<TimelineEvent["source"]>["issue"]>;

const lower = (s: string | undefined | null) => (s ?? "").toLowerCase();
const repoOf = (url: string) => url.split("/").slice(3, 5).join("/");

/** Every PR that references the issue, deduped, newest reference last. */
export function linkedPrSources(tl: TimelineEvent[]): PrSource[] {
  const out = new Map<string, PrSource>();
  for (const e of tl) {
    const src = e.event === "cross-referenced" ? e.source?.issue : undefined;
    if (!src?.pull_request) continue;
    out.delete(src.html_url);
    out.set(src.html_url, src);
  }
  return [...out.values()].slice(-MAX_LINKED_PRS);
}

const daysAgo = (iso: string | null | undefined, now: number) =>
  iso ? Math.floor((now - Date.parse(iso)) / DAY_MS) : null;

const LAST_ACTIVITY =
  "last_own_activity_days_ago (comment, commit, PR merge or assignment, whichever is latest)";

/** What Jev is told about the threshold; the grace-period arithmetic is decideProgress's. */
export const POLICY = { stale_after_days: STALE_DAYS };

/** Comments that are only Prow commands (/remove-lifecycle stale, /test …): no check-in, no discussion. */
const PROW_ONLY = /^(\s*\/[a-z-]+( [^\n]*)?\s*)+$/i;

/** A PR's last few events that say whose move it is: pushes, human comments and reviews (each marked when the PR's
 *  author made it), and the needs-rebase / do-not-merge / lgtm / approved labels. */
const recentPrEvents = (tl: TimelineEvent[], author: string, now: number) =>
  tl
    .filter((e) =>
      ["committed", "head_ref_force_pushed", "commented", "reviewed", "labeled"].includes(e.event),
    )
    .filter(
      (e) => e.event !== "labeled" || /needs-rebase|do-not-merge|lgtm|approved/.test(e.label?.name ?? ""),
    )
    .filter((e) => e.event !== "commented" || !PROW_ONLY.test(e.body ?? ""))
    .map((e) => {
      const who = e.event === "committed" ? author : (e.actor?.login ?? e.user?.login ?? "?");
      return {
        event: e.event === "labeled" ? `labeled ${e.label?.name}` : e.event,
        who,
        by_pr_author: lower(who) === lower(author),
        days_ago: daysAgo(e.created_at ?? e.submitted_at ?? e.committer?.date, now),
        ...(e.event === "reviewed" ? { review: lower(e.state) } : {}),
        ...(e.event === "commented" || e.event === "reviewed" ? { text: (e.body ?? "").slice(0, 200) } : {}),
      };
    })
    .filter((e) => e.days_ago !== null)
    .slice(-6);

/** Facts for one In-progress card, for every assignee at once. */
export async function progressState(
  repo: string,
  number: number,
  assignees: string[],
  d: ItemDetail,
  tl: TimelineEvent[],
  f: ProgressFetcher,
  now: number,
): Promise<Record<string, unknown>> {
  const as = new Set(assignees.map(lower));
  const human = d.comments.filter((c) => !isBot(c.author.login) && c.body.trim() && !PROW_ONLY.test(c.body));
  const prs = await Promise.all(
    linkedPrSources(tl).map(async (s) => {
      const merged = Boolean(s.pull_request?.merged_at);
      const state = merged ? "merged" : s.state === "closed" ? "closed" : "open";
      const author = s.user?.login ?? "ghost";
      const r = repoOf(s.html_url);
      const lastCommit = state === "open" ? await f.prLastCommit(r, s.number).catch(() => null) : null;
      return {
        merged_at: s.pull_request?.merged_at ?? null,
        last_commit: lastCommit,
        number: s.number,
        repository: r,
        title: s.title,
        author,
        author_is_assignee: as.has(lower(author)),
        state,
        ...(merged
          ? { merged_days_ago: daysAgo(s.pull_request!.merged_at, now) }
          : { opened_days_ago: daysAgo(s.created_at, now) }),
        ...(state === "open"
          ? {
              last_commit_days_ago: daysAgo(lastCommit, now),
              recent_events: recentPrEvents(await f.timeline(r, s.number).catch(() => []), author, now),
            }
          : {}),
      };
    }),
  );
  const assignedAt = (login: string) =>
    tl
      .filter((e) => e.event === "assigned" && lower(e.assignee?.login) === lower(login) && e.created_at)
      .map((e) => e.created_at!)
      .sort()
      .at(-1);
  // Each assignee's own latest activity: plain dates, no judgement about PRs waiting on reviewers.
  const facts = assignees.map((login) => {
    const L = lower(login);
    const ts = [
      assignedAt(login),
      ...human.filter((c) => lower(c.author.login) === L).map((c) => c.createdAt),
      ...prs.filter((p) => lower(p.author) === L).flatMap((p) => [p.merged_at, p.last_commit]),
    ].filter((t): t is string => Boolean(t));
    return { login, last: ts.sort().at(-1) ?? null };
  });
  const shown = prs.map(({ merged_at: _m, last_commit: _c, ...p }) => p);
  return {
    today_note: "Every days_ago is counted back from today.",
    policy: POLICY,
    issue: {
      repository: repo,
      number,
      title: d.title,
      labels: d.labels.map((l) => l.name).filter((l) => /^(lifecycle|triage|priority|kind)\//.test(l)),
      opened_days_ago: daysAgo(d.createdAt, now),
      description_start: d.body.slice(0, 1500),
    },
    assignees: facts.map(({ login, last }) => {
      const L = lower(login);
      const own = human.filter((c) => lower(c.author.login) === L);
      const mine = prs.filter((p) => lower(p.author) === L);
      return {
        login,
        assigned_days_ago: daysAgo(assignedAt(login), now),
        last_comment_days_ago: daysAgo(own.at(-1)?.createdAt, now),
        comments_on_issue: own.length,
        own_prs: mine.map((p) => `#${p.number} ${p.state}`),
        "last_own_activity_days_ago (comment, commit, PR merge or assignment, whichever is latest)": daysAgo(
          last,
          now,
        ),
      };
    }),
    linked_prs: shown.filter((p) => p.state !== "closed" || p.author_is_assignee).slice(-10),
    thread: human.slice(-15).map((c) => ({
      author: c.author.login,
      author_is_assignee: as.has(lower(c.author.login)),
      days_ago: daysAgo(c.createdAt, now),
      // Which assignees have not done anything since this comment: a check-in to them is still unanswered.
      no_activity_since_by: facts
        .filter((x) => lower(x.login) !== lower(c.author.login) && (!x.last || x.last < c.createdAt))
        .map((x) => x.login),
      text: c.body.slice(0, 800),
    })),
  };
}

// Jev's questions, one call per card:
//   checkin_<a>_<c>: is thread comment c a check-in to assignee a? (asked only for comments after a's own last
//                    activity: anything earlier they have answered by acting)
//   active_<a>:      is assignee a still on it?
//   moving_on:       is the work moving or done through other people?

export interface ProgressAnswers {
  [key: string]: JevNoul;
}

/** Thread comments (indexes into state.thread) to ask about for each assignee: not their own, and after their own
 *  last activity. */
export function checkinCandidates(state: Record<string, unknown>): number[][] {
  const thread = state.thread as { author: string; no_activity_since_by: string[] }[];
  const as = state.assignees as { login: string }[];
  return as.map((a) =>
    thread.flatMap((c, i) => (c.no_activity_since_by.includes(a.login) && c.author !== a.login ? [i] : [])),
  );
}

export function splitQuestions(state: Record<string, unknown>): Record<string, unknown> {
  const as = state.assignees as { login: string }[];
  const thread = state.thread as { author: string; days_ago: number; text: string }[];
  const cands = checkinCandidates(state);
  const q: Record<string, unknown> = {};
  as.forEach((a, i) => {
    for (const c of cands[i]!)
      q[`checkin_${i}_${c}`] = {
        type: "noul",
        instructions: {
          // The comment itself, not an index into the thread: Jev judges exactly this text.
          comment: { author: thread[c]!.author, days_ago: thread[c]!.days_ago, text: thread[c]!.text },
          question: `Is \`comment\` a check-in to ${a.login}: does it ask ${a.login} whether they are still working on this, for a status update, or to unassign if not?`,
        },
        criteria: {
          true: {
            what: `It is addressed to ${a.login} (by name, or clearly to the assignee) and asks about their progress or whether they are still on it.`,
            examples: [
              `@${a.login} are you still working on this? If not, please /unassign.`,
              `Checking in @${a.login}, any progress here?`,
              `@${a.login} is this still on your plate?`,
            ],
          },
          false: {
            what: "Anything else.",
            examples: [
              "this is still failing on the scale tests",
              "@someone-else what do you think is left here?",
              "I'd like to work on this, can I take it?",
              "a status update or analysis written by the assignee's reviewer or a bystander",
            ],
          },
        },
      };
    q[`active_${i}`] = {
      type: "noul",
      instructions: {
        question: `Is ${a.login} still actively working on this issue?`,
        focus: `Judge ${a.login} only. Apply policy.stale_after_days to the dates as given.`,
        evidence: ["assignees", "thread", "linked_prs"],
      },
      criteria: {
        true: {
          what: `${a.login} is on it.`,
          includes: [
            `their last own activity is within stale_after_days`,
            `an open PR by ${a.login} whose latest human event is ${a.login}'s own (by_pr_author: a push, a reply or a ping to reviewers): it waits on reviewers`,
            `a reviewer reviewed ${a.login}'s PR within stale_after_days (any review; inline comments are not shown): the clock restarts then`,
            `${a.login} said why the work is paused, and the reason still holds`,
          ],
        },
        false: {
          what: `${a.login} has gone quiet: no own activity within stale_after_days, no PR of theirs waiting on reviewers, no stated reason.`,
        },
      },
    };
  });
  q.moving_on = {
    type: "noul",
    instructions: {
      question:
        "Is the work on this issue moving or done through people other than the assignees (merged or open PRs by others, recent discussion), or did the last substantive comment scope or defer it in a way later activity may have satisfied?",
      evidence: ["thread", "linked_prs"],
    },
    criteria: {
      true: "Others are carrying the work, or it may be finished: asking the thread what is left makes sense.",
      false: "Nothing is happening without the assignees.",
    },
  };
  return q;
}

export type ProgressVerdict = "active" | "nudge" | "wait" | "unassign" | "ask_thread";

/** Asking the whole thread is the unusual action; below this a quiet assignee gets the ordinary nudge. */
export const MOVING_AT = 0.65;

/** Per assignee: active by Jev; else the newest check-in Jev found decides wait (< grace) or unassign; else ask the
 *  thread when nobody is active and the work moves through others; else nudge. */
export function decideProgress(
  state: Record<string, unknown>,
  a: ProgressAnswers,
  at = 0.5,
): { login: string; verdict: ProgressVerdict; why: string; checkin_days_ago: number | null }[] {
  const as = state.assignees as { login: string }[];
  const thread = state.thread as { author: string; days_ago: number }[];
  const cands = checkinCandidates(state);
  // Own activity within the threshold is plain date arithmetic; Jev judges only the quiet ones (a PR waiting on
  // reviewers, a review that restarted the clock, a stated pause).
  const recent = (as as { [k: string]: unknown }[]).map((x) => {
    const d = x[LAST_ACTIVITY] as number | null;
    return d !== null && d <= STALE_DAYS;
  });
  const active = as.map((_, i) => recent[i]! || (a[`active_${i}`]?.noul ?? 0) >= at);
  return as.map((x, i) => {
    if (active[i]) return { login: x.login, verdict: "active", why: "still on it", checkin_days_ago: null };
    const checkins = cands[i]!.filter((c) => (a[`checkin_${i}_${c}`]?.noul ?? 0) >= at);
    const newest = checkins.length ? thread[checkins.at(-1)!]! : null;
    if (newest) {
      const d = newest.days_ago;
      return d < NUDGE_GRACE_DAYS
        ? {
            login: x.login,
            verdict: "wait",
            why: `${newest.author} checked in ${d}d ago; unassigning becomes possible in ${NUDGE_GRACE_DAYS - d}d`,
            checkin_days_ago: d,
          }
        : {
            login: x.login,
            verdict: "unassign",
            why: `${newest.author}'s check-in ${d}d ago went unanswered`,
            checkin_days_ago: d,
          };
    }
    if (!active.some(Boolean) && (a.moving_on?.noul ?? 0) >= MOVING_AT)
      return {
        login: x.login,
        verdict: "ask_thread",
        why: "quiet, and the work moves through others",
        checkin_days_ago: null,
      };
    return {
      login: x.login,
      verdict: "nudge",
      why: "quiet, and nobody has checked in yet",
      checkin_days_ago: null,
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The card: one suggested action, the steps and comments behind each choice, and judging in the worker.

export interface AssigneeVerdict {
  login: string;
  verdict: ProgressVerdict;
  why: string;
  checkin_days_ago: number | null;
  last_activity_days_ago: number | null;
  /** Jev's P(still on it); null when own activity within the threshold settled it. */
  p_active: number | null;
}

export interface ProgressResult {
  kind: "progress";
  item_id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  sig_node: boolean;
  assignees: AssigneeVerdict[];
  p_moving_on: number;
  usage: JevUsage;
  state_chars: number;
}

export const PROGRESS_ACTIONS = [
  "keep",
  "nudge",
  "unassign",
  "ask_thread",
  "back_to_todo",
  "archive",
] as const;
export type ProgressAction = (typeof PROGRESS_ACTIONS)[number];

export const PROGRESS_LABEL: Record<ProgressAction, string> = {
  keep: "Keep in In progress",
  nudge: "Nudge the assignee",
  unassign: "Unassign",
  ask_thread: "Ask the thread",
  back_to_todo: "Move back to To do",
  archive: "Archive",
};

export const PROGRESS_TINT: Record<ProgressAction, "KEEP" | "REMOVE" | "BORDERLINE" | "MOVE"> = {
  keep: "KEEP",
  nudge: "BORDERLINE",
  ask_thread: "BORDERLINE",
  unassign: "REMOVE",
  back_to_todo: "MOVE",
  archive: "REMOVE",
};

/** The card's suggestion: no sig/node archives, no assignee goes back to To do (the column's own rule: "if one
 *  stopped working, please move back"), else the most pressing assignee verdict: unassign, nudge, ask the
 *  thread, then keep (active, or waiting out a check-in). */
export function decideProgressCard(r: Pick<ProgressResult, "sig_node" | "assignees">): {
  action: ProgressAction;
  why: string;
} {
  if (!r.sig_node)
    return { action: "archive", why: "No sig/node label (e.g. after /remove-sig node): another SIG's issue" };
  if (!r.assignees.length)
    return { action: "back_to_todo", why: "Nobody is assigned: the column is for work someone is doing" };
  for (const v of ["unassign", "nudge", "ask_thread", "wait"] as const) {
    const who = r.assignees.filter((a) => a.verdict === v);
    if (!who.length) continue;
    const names = who.map((a) => a.login).join(", ");
    if (v === "wait")
      return { action: "keep", why: `Wait: ${who.map((a) => `${a.login}, ${a.why}`).join("; ")}` };
    return { action: v, why: `${names}: ${who.map((a) => a.why).join("; ")}` };
  }
  return { action: "keep", why: `Active: ${r.assignees.map((a) => a.login).join(", ")}` };
}

export const PROGRESS_PREFIX = {
  nudge: "are you still working on this?",
  unassign: "Unassigning after no response to the check-in above",
  ask: "Checking in from the SIG Node CI board. The assignees have been quiet",
} as const;

export function nudgeBody(login: string, quietDays: number | null): string {
  const q = quietDays === null ? "" : ` It has been quiet for ${quietDays} days.`;
  return `@${login} ${PROGRESS_PREFIX.nudge}${q} If not, please \`/unassign\` so someone else can pick it up. No worries either way.`;
}

export function unassignBody(login: string): string {
  return `/unassign @${login}\n${PROGRESS_PREFIX.unassign} so this is open for anyone to pick up. Feel free to re-assign yourself if you are still on it.`;
}

export function askThreadProgressBody(): string {
  return `${PROGRESS_PREFIX.ask} and the recent activity here is from others. What is left on this issue, and who is driving it? If nothing remains, please say so and we will close it. If someone else owns the next step, please \`/assign\` them.`;
}

/** The steps of `action`. The suggested action targets the assignees whose own verdict it is; a reviewer's
 *  override targets every assignee who is not active. Unassigning moves the card back to To do unless an active
 *  assignee remains. */
export function progressSteps(item: BoardItem, r: ProgressResult, action: ProgressAction): ActionStep[] {
  const { repository: repo, number } = item;
  const comment = (body: string): ActionStep => ({ kind: "comment", repo, number, body });
  const move = (lane: string): ActionStep => ({ kind: "move", itemId: item.id, restId: item.restId, lane });
  const suggested = decideProgressCard(r).action === action;
  const quiet = r.assignees.filter((a) => a.verdict !== "active");
  const targets = suggested ? r.assignees.filter((a) => a.verdict === action) : quiet;
  switch (action) {
    case "keep":
      return [];
    case "nudge":
      return targets.map((a) => comment(nudgeBody(a.login, a.last_activity_days_ago)));
    case "unassign": {
      const steps = targets.map((a) => comment(unassignBody(a.login)));
      // Back to To do only when nobody is left assigned: an assigned card in To do is moved straight back here.
      const remaining = r.assignees.filter((a) => !targets.includes(a));
      return steps.length && !remaining.length ? [...steps, move("Issues - To do")] : steps;
    }
    case "ask_thread":
      return [comment(askThreadProgressBody())];
    case "back_to_todo":
      return [move("Issues - To do")];
    case "archive":
      return [move("Archive-it")];
  }
}

/** Nudge, unassign and ask the thread need someone who is not active; the moves are always there. */
export function progressActions(r: ProgressResult): ProgressAction[] {
  const quiet = r.assignees.some((a) => a.verdict !== "active");
  const suggested = decideProgressCard(r).action;
  return PROGRESS_ACTIONS.filter(
    (a) => a === suggested || !["nudge", "unassign", "ask_thread"].includes(a) || quiet,
  );
}

export async function judgeProgress(
  item: BoardItem,
  d: ItemDetail,
  f: ProgressFetcher,
  jev: JevClient,
  refresh = false,
  now = Date.now(),
): Promise<ProgressResult> {
  const tl = await f.timeline(item.repository, item.number);
  const base = {
    kind: "progress" as const,
    item_id: item.id,
    repo: item.repository,
    number: item.number,
    title: d.title,
    url: item.url,
    sig_node: d.labels.some((l) => l.name === "sig/node"),
  };
  if (!item.assignees.length)
    return {
      ...base,
      assignees: [],
      p_moving_on: 0,
      usage: { input_tokens: 0, cost: 0, cached: true },
      state_chars: 0,
    };
  const state = await progressState(item.repository, item.number, item.assignees, d, tl, f, now);
  const r = await jev.askCached<ProgressAnswers>(state, splitQuestions(state), 4, refresh);
  const verdicts = decideProgress(state, r.answers);
  const facts = state.assignees as Record<string, unknown>[];
  return {
    ...base,
    assignees: verdicts.map((v, i) => ({
      ...v,
      last_activity_days_ago: facts[i]![LAST_ACTIVITY] as number | null,
      p_active: r.answers[`active_${i}`]?.noul ?? null,
    })),
    p_moving_on: r.answers.moving_on?.noul ?? 0,
    usage: r.usage,
    state_chars: JSON.stringify(state).length,
  };
}
