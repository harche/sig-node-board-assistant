/** The SIG Node Bugs board's 'Needs Information' column: a triager asked the reporter for details
 *  (triage/needs-information or triage/not-reproducible) and the card waits for the answer. Nothing moves it when the
 *  reporter answers, so it goes stale: on kubernetes/185 most asks were months old, some answered long ago.
 *
 *  Code reads the dates (when the label went on, who wrote what since). Jev reads the thread: has the request been
 *  answered, and which later comments are a reminder to the reporter. Answered → Jev judges the report again with
 *  the Triage questions and, when there is now enough to start, it is accepted at a priority. Unanswered → after 20
 *  days (the community triage guide's wait) the reporter is nudged once, and 14 days after an unanswered nudge the
 *  issue is closed with a comment inviting them to reopen it with the details. */
import { isBot } from "./boards";
import {
  acceptBody,
  bugLabels,
  bugState,
  INFO_ASK_AT,
  laneFor,
  LANE,
  OTHER_AT,
  SUPPORT_AT,
  type BugAnswers,
  type BugLabels,
} from "./bugs";
import type { TimelineEvent } from "./github";
import type { JevClient } from "./jev";
import { BUG_PRIORITIES, bugQuestions, priorityQuestion } from "./prompts/bugs";
import { f2 } from "./policy";
import type { ProwFix } from "./prowcmds";
import { choiceReading, noulReading, type Reading } from "./readings";
import type { ActionStep, BoardItem, ItemDetail, JevNoul, JevScore, JevUsage } from "./types";

export const WAIT_DAYS = 20; // the community issue-triage guide: close after 20 days without a response
export const NUDGE_WAIT_DAYS = 14; // after a reminder, before closing
export const ANSWERED_AT = 0.65;
export const UNANSWERED_AT = 0.35;
export const REMINDER_AT = 0.65;

export const INFO_ACTIONS = ["accept", "nudge", "close", "to_triage", "done", "keep"] as const;
export type InfoAction = (typeof INFO_ACTIONS)[number];

export const INFO_LABEL: Record<InfoAction, string> = {
  accept: "Accept",
  nudge: "Remind the reporter",
  close: "Close: no answer",
  to_triage: "Back to Triage",
  done: "Move to Done",
  keep: "Keep waiting",
};

export const INFO_TINT: Record<InfoAction, "KEEP" | "REMOVE" | "BORDERLINE" | "MOVE"> = {
  accept: "KEEP",
  nudge: "BORDERLINE",
  close: "REMOVE",
  to_triage: "MOVE",
  done: "REMOVE",
  keep: "KEEP",
};

export interface InfoResult {
  kind: "info";
  item_id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  reporter: string;
  labels: BugLabels;
  /** Days since triage/needs-information (or not-reproducible) last went on; null when the timeline has no such event. */
  asked_days_ago: number | null;
  /** Days since the reporter's last comment after the ask, or null. */
  reporter_replied_days_ago: number | null;
  /** Days since the latest comment Jev reads as a reminder to the reporter, after their last reply. */
  reminded_days_ago: number | null;
  /** Jev: the request has been answered (by the reporter or someone who reproduced it). Null when not asked. */
  p_answered: number | null;
  /** Jev's reading of the report with the answers in it, asked only when answered. */
  answers: BugAnswers | null;
  priority: string | null;
  priority_why: string;
  prow_fixes?: ProwFix[];
  /** Every answer Jev gave, labelled, for the bars on the hover card and the pane. */
  readings?: Reading[];
  usage: JevUsage;
  state_chars: number;
}

const INFO_LABELS = ["triage/needs-information", "triage/not-reproducible"];

/** The suggested action, why, and whether the header's Accept applies it without the reviewer picking it. */
export function decideInfo(r: InfoResult): { action: InfoAction; why: string; auto: boolean } {
  const L = r.labels;
  if (r.state !== "open") return { action: "done", why: "closed", auto: true };
  if (L.triage_accepted)
    return {
      action: "accept",
      why: L.priority ? `already triage/accepted, priority/${L.priority}` : "already triage/accepted",
      auto: true,
    };
  if (!L.needs_information && !L.not_reproducible)
    return { action: "to_triage", why: "no needs-information label any more: it needs a triage", auto: true };
  const p = r.p_answered;
  if (p !== null && p >= ANSWERED_AT) {
    const a = r.answers;
    const info = a?.enough_information.noul ?? 0;
    if (!a || info < INFO_ASK_AT)
      return {
        action: "keep",
        why: `answered (P ${f2(p)}), but Jev still reads too little to start (P enough ${f2(info)}): a maintainer should read the reply`,
        auto: false,
      };
    const support = a.report.probabilities.support_question ?? 0;
    const other = a.owner.probabilities.other ?? 0;
    const unsure = support >= SUPPORT_AT || other >= OTHER_AT;
    return {
      action: "accept",
      why:
        `answered (P ${f2(p)}), now enough to start (P ${f2(info)})` +
        (unsure
          ? `; but Jev reads it as ${support >= SUPPORT_AT ? "a support question" : "another SIG's code"}`
          : ""),
      auto: !unsure,
    };
  }
  if (p !== null && p > UNANSWERED_AT)
    return {
      action: "keep",
      why: `Jev is unsure whether the request was answered (P ${f2(p)})`,
      auto: false,
    };
  const asked = r.asked_days_ago;
  if (asked === null)
    return { action: "keep", why: "no needs-information label event in the timeline", auto: false };
  if (asked < WAIT_DAYS)
    return { action: "keep", why: `asked ${asked}d ago; waiting ${WAIT_DAYS}d`, auto: true };
  const reminded = r.reminded_days_ago;
  if (reminded === null)
    return {
      action: "nudge",
      why: `asked ${asked}d ago, no answer and nobody reminded the reporter`,
      auto: true,
    };
  if (reminded < NUDGE_WAIT_DAYS)
    return {
      action: "keep",
      why: `the reporter was reminded ${reminded}d ago; waiting ${NUDGE_WAIT_DAYS}d`,
      auto: true,
    };
  return {
    action: "close",
    why: `asked ${asked}d ago, reminded ${reminded}d ago, still no answer`,
    auto: true,
  };
}

export function infoActions(r: InfoResult): InfoAction[] {
  if (r.state !== "open") return ["done", "keep"];
  return INFO_ACTIONS.filter((a) => a !== "done");
}

export const INFO_PREFIX = {
  nudge:
    "could you share the details asked for above? Without them this cannot be investigated. If there is no update in two weeks this will be closed; it can be reopened any time with the details.",
  close:
    "Closing, since the details asked for above did not come. If this still happens, please reopen it with them.",
} as const;

export function nudgeInfoBody(reporter: string): string {
  return `@${reporter} ${INFO_PREFIX.nudge}`;
}

export function closeInfoBody(): string {
  return `${INFO_PREFIX.close}\n\n/close`;
}

/** Accept: the information label comes off, /triage accepted and the priority go on. */
export function acceptInfoBody(r: InfoResult, priority: string): string {
  const off = [
    ...(r.labels.needs_information ? ["/remove-triage needs-information"] : []),
    ...(r.labels.not_reproducible ? ["/remove-triage not-reproducible"] : []),
  ];
  const on = acceptBody({ labels: r.labels, answers: r.answers } as never, priority);
  return [...off, ...(on ? [on] : [])].join("\n");
}

export function infoSteps(
  item: BoardItem,
  r: InfoResult,
  action: InfoAction,
  priority: string | null = r.priority,
): ActionStep[] {
  const { repository: repo, number } = item;
  const comment = (body: string): ActionStep[] => (body ? [{ kind: "comment", repo, number, body }] : []);
  const move = (lane: string): ActionStep => ({ kind: "move", itemId: item.id, restId: item.restId, lane });
  switch (action) {
    case "keep":
      return [];
    case "done":
      return [move(LANE.done)];
    case "to_triage":
      return [move("Triage")];
    case "nudge":
      return comment(nudgeInfoBody(r.reporter));
    case "close":
      return [...comment(closeInfoBody()), move(LANE.done)];
    case "accept": {
      const prio = priority ?? r.labels.priority;
      if (!prio) return [];
      return [...comment(acceptInfoBody(r, prio)), move(laneFor(prio))];
    }
  }
}

const LOGIN = /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** The comment shapes above (comments.ts). Accept's is the information label coming off, then only the accept lines
 *  still needed: none at all when triage/accepted and the priority are already set. */
export function isInfoComment(body: string): boolean {
  const [first, ...rest] = body.split(" ");
  if (LOGIN.test(first ?? "") && rest.join(" ") === INFO_PREFIX.nudge) return true;
  if (body === closeInfoBody()) return true;
  const lines = body.split("\n");
  const off = lines.filter((l) => /^\/remove-triage (needs-information|not-reproducible)$/.test(l));
  if (!off.length) return false;
  const prio = (l: string, cmd: string) => BUG_PRIORITIES.some((x) => l === `${cmd} ${x}`);
  return lines
    .filter((l) => !off.includes(l))
    .every(
      (l) =>
        l === "/triage accepted" ||
        prio(l, "/priority") ||
        prio(l, "/remove-priority") ||
        l === "/wg device-management",
    );
}

// ---------------------------------------------------------------------------------------------------- judging

const DAY = 86_400_000;
const daysAgo = (at: string, now: number) => Math.floor((now - Date.parse(at)) / DAY);

/** When the information label last went on, from the timeline. */
export function askedAt(tl: TimelineEvent[]): string | null {
  return (
    tl.filter((e) => e.event === "labeled" && INFO_LABELS.includes(e.label?.name ?? "")).at(-1)?.created_at ??
    null
  );
}

/** What Jev reads: the report, the request (the comment that applied the label, and the maintainer comments just
 *  before it when that one is only the command), and every human reply since. */
export function infoState(d: ItemDetail, asked: string | null, now: number) {
  const reporter = d.author.login;
  const human = d.comments
    .filter((c) => !isBot(c.author.login) && c.body.trim())
    .map((c) => ({
      author: c.author.login,
      is_reporter: c.author.login === reporter,
      days_ago: daysAgo(c.createdAt, now),
      at: c.createdAt,
      text: c.body.slice(0, 1500),
    }));
  const t = asked ? Date.parse(asked) : Infinity;
  const before = human.filter((c) => Date.parse(c.at) <= t + 60_000);
  const replies = human.filter((c) => Date.parse(c.at) > t + 60_000);
  // The asking comment carries the label command; a bare command means the question came just before it.
  const asking = before.filter((c) => !c.is_reporter).slice(-3);
  const last = asking.at(-1);
  const request = last && last.text.replace(/^\s*\/\S.*$/gm, "").trim().length >= 40 ? [last] : asking;
  return {
    title: d.title,
    description: (d.body ?? "").slice(0, 3000),
    reporter,
    asked_days_ago: asked ? daysAgo(asked, now) : null,
    request: request.map(({ author, days_ago, text }) => ({ author, days_ago, text })),
    replies: replies.slice(-10),
  };
}

type Replies = ReturnType<typeof infoState>["replies"];

/** Replies by others after the reporter's last word: the ones that could be a reminder. */
export function reminderCandidates(replies: Replies): Replies {
  const lastReporter = replies.filter((c) => c.is_reporter).at(-1)?.at ?? "";
  return replies.filter((c) => !c.is_reporter && c.at > lastReporter).slice(-4);
}

export function infoQuestions(st: ReturnType<typeof infoState>): Record<string, unknown> {
  const q: Record<string, unknown> = {
    answered: {
      type: "noul",
      instructions: {
        question:
          "A maintainer asked for more information (`request`). Do the `replies` supply it, or make it unnecessary, so the next move is the maintainers'?",
        focus:
          "An answer can come from the reporter or from anyone else who hits the problem. Judge what was asked, not whether the bug is now understood.",
        evidence: ["request", "replies", "description"],
      },
      criteria: {
        true: {
          what: "A reply gives what was asked, or answers the question.",
          examples: [
            "the reporter posted the kubelet logs and the steps asked for",
            "another user with the same problem posted the runtime version the maintainer asked about",
            "asked whether it duplicates another issue, the reporter explained how it differs",
            "the reporter pointed to a reproducer and is now waiting on maintainers to respond",
            "the reporter answered each follow-up question a maintainer asked",
            "a maintainer reproduced it or found the cause, so nothing more is needed from the reporter",
          ],
        },
        false: {
          what: "Nothing in the replies answers the request.",
          examples: [
            "no replies",
            "only '+1' or 'same here' without the details asked for",
            "the reporter said they would check, and did not come back",
            "maintainers speculating about the cause without reproducing it",
          ],
        },
      },
    },
  };
  reminderCandidates(st.replies).forEach((c, k) => {
    q[`reminder_${k}`] = {
      type: "noul",
      instructions: {
        comment: { author: c.author, days_ago: c.days_ago, text: c.text },
        question: `Is \`comment\` a reminder to ${st.reporter}, the reporter, asking for the requested details or whether this still happens?`,
      },
      criteria: {
        true: {
          what: `It asks ${st.reporter} for the details or for an update.`,
          examples: [
            `@${st.reporter} could you share the logs asked for above?`,
            `@${st.reporter} friendly ping, does this still happen on 1.36?`,
          ],
        },
        false: {
          what: "Anything else.",
          examples: [
            "a maintainer's own analysis",
            "'+1, seeing this too'",
            "a question to another maintainer",
          ],
        },
      },
    };
  });
  return q;
}

export async function judgeInfo(
  item: BoardItem,
  d: ItemDetail,
  tl: TimelineEvent[],
  jev: JevClient,
  refresh = false,
  now = Date.now(),
): Promise<InfoResult> {
  const labels = bugLabels(d.labels.map((l) => l.name));
  const asked = askedAt(tl);
  const st = infoState(d, asked, now);
  const usage: JevUsage = { input_tokens: 0, cost: 0, cached: true };
  const ask = async <A>(state: unknown, q: Record<string, unknown>): Promise<A> => {
    const res = await jev.askCached<A>(state, q, 4, refresh);
    usage.input_tokens += res.usage.input_tokens;
    usage.cost += res.usage.cost;
    usage.cached = usage.cached && res.usage.cached;
    return res.answers;
  };
  const reporterReplies = st.replies.filter((c) => c.is_reporter);
  const r: InfoResult = {
    kind: "info",
    item_id: item.id,
    repo: item.repository,
    number: item.number,
    title: d.title,
    url: item.url,
    state: d.state.toLowerCase() === "open" ? "open" : "closed",
    reporter: st.reporter,
    labels,
    asked_days_ago: st.asked_days_ago,
    reporter_replied_days_ago: reporterReplies.at(-1)?.days_ago ?? null,
    reminded_days_ago: null,
    p_answered: null,
    answers: null,
    priority: labels.priority,
    priority_why: labels.priority ? "already labelled" : "",
    readings: [],
    usage,
    state_chars: JSON.stringify(st).length,
  };
  if (
    r.state !== "open" ||
    labels.triage_accepted ||
    (!labels.needs_information && !labels.not_reproducible)
  ) {
    // Already decided by labels; an accepted card without a priority still needs one.
    if (r.state === "open" && labels.triage_accepted && !labels.priority) await setPriority(r, d, item, ask);
    return r;
  }
  const a = await ask<Record<string, JevNoul>>(st, infoQuestions(st));
  r.p_answered = a.answered?.noul ?? null;
  const cands = reminderCandidates(st.replies);
  r.reminded_days_ago =
    cands
      .map((c, k) => ({ c, p: a[`reminder_${k}`]?.noul ?? 0 }))
      .filter((x) => x.p >= REMINDER_AT)
      .at(-1)?.c.days_ago ?? null;
  r.readings = [
    ...noulReading("The request was answered", a.answered),
    ...cands.flatMap((c, k) =>
      noulReading(`reminder to the reporter (${c.author}, ${c.days_ago}d ago)`, a[`reminder_${k}`]),
    ),
  ];
  if ((r.p_answered ?? 0) >= ANSWERED_AT) {
    // Answered: the Triage questions again, on the whole thread with the answers in it.
    const bs = bugState(item, d);
    const answers = await ask<BugAnswers>(bs, bugQuestions());
    r.answers = answers;
    r.readings.push(
      ...choiceReading("Kind of report", answers.report),
      ...choiceReading("Owner", answers.owner),
      ...noulReading(
        "Enough information now",
        answers.enough_information,
        answers.enough_information.noul < INFO_ASK_AT,
      ),
      ...noulReading("About DRA", answers.dra),
    );
  }
  // Asked for every open card without one, so a reviewer who picks Accept (the suggestion or not) has a priority.
  if (!labels.priority) await setPriority(r, d, item, ask);
  return r;
}

async function setPriority(
  r: InfoResult,
  d: ItemDetail,
  item: BoardItem,
  ask: <A>(state: unknown, q: Record<string, unknown>) => Promise<A>,
): Promise<void> {
  const p = await ask<{ priority: JevScore }>(bugState(item, d), priorityQuestion());
  const levels = [...BUG_PRIORITIES].reverse();
  let best = 0;
  let level = -1;
  levels.forEach((_, i) => {
    const v = p.priority?.probabilities[String(i)] ?? 0;
    if (v > best) [best, level] = [v, i];
  });
  r.priority = level < 0 ? "important-longterm" : levels[level]!;
  r.priority_why = level < 0 ? "default; Jev gave no level" : "Jev's pick";
  r.readings = [...(r.readings ?? []), ...choiceReading("Priority", p.priority, levels)];
}
