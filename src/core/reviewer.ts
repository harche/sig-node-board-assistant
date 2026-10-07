/** 'PRs - Needs Reviewer': is each PR really waiting on a reviewer, and if so who. On 151 the lane means "triage
 *  accepted", not "no reviewer", and nothing moves a card out once review starts, so most cards need re-laning
 *  rather than a ping.
 *
 *  Code keeps what is plain (merged, draft, the lgtm / hold / needs-rebase labels, who put a /hold, Prow's tide
 *  status, dates, who wrote what); Jev reads the thread for whose move it is, who is really reviewing, who
 *  declined, and whether a reviewer's /hold condition looks met. Finding a new reviewer is candidates.ts. */
import { choiceReading, noulReading, type Reading } from "./readings";
import type { ProwFix } from "./prowcmds";
import { isBot } from "./boards";
import type { PullState, TimelineEvent } from "./github";
import type { JevClient } from "./jev";
import type { ActionStep, BoardItem, ItemDetail, JevChoice, JevNoul, JevUsage } from "./types";

const DAY_MS = 86_400_000;
/** A reviewer quiet this long after the author's last move gets a re-ping. */
export const REPING_DAYS = 14;
const lower = (s: string | null | undefined) => (s ?? "").toLowerCase();
const daysAgo = (iso: string | null | undefined, now: number) =>
  iso ? Math.floor((now - Date.parse(iso)) / DAY_MS) : null;

const HOLD = /^\s*\/hold(?!\s+cancel)\b/im;
const UNHOLD = /^\s*\/(?:hold\s+cancel|unhold)\b/im;
const REF =
  /(?:^|[\s(])(?:([\w.-]+\/[\w.-]+)#|#|https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/)(\d{2,})/g;

export interface PrEvent {
  kind: "comment" | "review" | "push" | "review_request";
  who: string;
  by_author: boolean;
  days_ago: number | null;
  at: string;
  review?: string;
  text?: string;
}

/** Everything that happened on the PR, oldest first: comments, reviews, pushes and human review requests. */
export function prEvents(d: ItemDetail, ps: PullState, tl: TimelineEvent[], now: number): PrEvent[] {
  const a = lower(ps.author);
  const ev: PrEvent[] = [];
  for (const c of d.comments)
    if (!isBot(c.author.login) && c.body.trim())
      ev.push({
        kind: "comment",
        who: c.author.login,
        by_author: lower(c.author.login) === a,
        days_ago: daysAgo(c.createdAt, now),
        at: c.createdAt,
        text: c.body.slice(0, 600),
      });
  for (const r of ps.reviews)
    if (!isBot(r.author))
      ev.push({
        kind: "review",
        who: r.author,
        by_author: lower(r.author) === a,
        days_ago: daysAgo(r.at, now),
        at: r.at,
        review: r.state.toLowerCase(),
        // A review with no summary still carries inline comments, which the timeline does not include.
        text: r.body || "(inline review comments, not shown)",
      });
  for (const e of tl) {
    const at = e.created_at ?? e.committer?.date;
    if (!at) continue;
    if (e.event === "committed" || e.event === "head_ref_force_pushed")
      ev.push({ kind: "push", who: ps.author, by_author: true, days_ago: daysAgo(at, now), at });
    else if (e.event === "review_requested" && e.requested_reviewer && !isBot(e.actor?.login ?? ""))
      ev.push({
        kind: "review_request",
        who: e.actor?.login ?? "?",
        by_author: lower(e.actor?.login) === a,
        days_ago: daysAgo(at, now),
        at,
        text: `requested a review from ${e.requested_reviewer.login}`,
      });
  }
  return ev.sort((x, y) => x.at.localeCompare(y.at));
}

/** Who holds the PR: the author of the latest /hold not cancelled since (in a comment, a review or the
 *  description), while the label is there. */
export function holder(ps: PullState, d: ItemDetail): string | null {
  if (!ps.labels.includes("do-not-merge/hold")) return null;
  const said = [
    { who: ps.author, at: ps.created_at, body: d.body },
    ...d.comments.map((c) => ({ who: c.author.login, at: c.createdAt, body: c.body })),
    ...ps.reviews.map((r) => ({ who: r.author, at: r.at, body: r.body })),
  ].sort((x, y) => x.at.localeCompare(y.at));
  let who: string | null = null;
  for (const c of said) {
    if (isBot(c.who)) continue;
    if (UNHOLD.test(c.body)) who = null;
    else if (HOLD.test(c.body)) who = c.who;
  }
  return who ?? "unknown";
}

/** People asked to review, by someone other than themselves: /cc and /assign in comments (the author's too),
 *  and review requests a human made. Latest ask per person. */
export function asks(
  events: PrEvent[],
  tl: TimelineEvent[],
  now: number,
): Map<string, { by: string; days_ago: number }> {
  const out = new Map<string, { by: string; days_ago: number; at: string }>();
  const put = (who: string, by: string, at: string) => {
    if (lower(who) === lower(by) || isBot(who)) return;
    const prev = out.get(who);
    if (!prev || prev.at < at) out.set(who, { by, at, days_ago: daysAgo(at, now) ?? 0 });
  };
  for (const e of events)
    if (e.kind === "comment" && e.text)
      for (const m of e.text.matchAll(/^\s*\/(?:cc|assign)\s+(.*)$/gim))
        for (const x of m[1]!.matchAll(/@([\w-]+)/g)) put(x[1]!, e.who, e.at);
  for (const e of tl)
    if (
      e.event === "review_requested" &&
      e.requested_reviewer &&
      e.created_at &&
      !isBot(e.actor?.login ?? "")
    )
      put(e.requested_reviewer.login, e.actor?.login ?? "?", e.created_at);
  return new Map([...out].map(([k, v]) => [k, { by: v.by, days_ago: v.days_ago }]));
}

/** Days since the latest comment by someone else that @-mentions `who` (a ping), or null. */
export function lastPing(events: PrEvent[], who: string): number | null {
  const re = new RegExp(`@${who.replace(/[-]/g, "\\-")}(?![\\w-])`, "i");
  const pings = events.filter(
    (e) => e.kind === "comment" && lower(e.who) !== lower(who) && e.text && re.test(e.text),
  );
  return pings.at(-1)?.days_ago ?? null;
}

/** Other issues and PRs the description and comments point at, for Jev to judge whether one must land first. */
export function references(
  repo: string,
  num: number,
  texts: string[],
): { repo: string; number: number; text: string }[] {
  const out = new Map<string, { repo: string; number: number; text: string }>();
  for (const t of texts)
    for (const m of t.matchAll(REF)) {
      const r = m[1] ?? m[2] ?? repo;
      const n = Number(m[3]);
      if (r === repo && n === num) continue;
      const at = m.index ?? 0;
      out.set(`${r}#${n}`, {
        repo: r,
        number: n,
        text: t.slice(Math.max(0, at - 60), at + 40).replace(/\s+/g, " "),
      });
    }
  return [...out.values()].slice(0, 6);
}

export interface ReviewFacts {
  state: Record<string, unknown>;
  asks: Map<string, { by: string; days_ago: number }>;
  /** The latest comment @-mentioning each person who was not asked otherwise: Jev says whether it is an ask. */
  mentions: { login: string; by: string; days_ago: number; text: string }[];
  events: PrEvent[];
  /** Non-author humans who commented or reviewed, most recent last. */
  participants: string[];
  holder: string | null;
}

export function reviewFacts(
  item: BoardItem,
  d: ItemDetail,
  ps: PullState,
  tl: TimelineEvent[],
  refs: { repo: string; number: number; text: string; state: string }[],
  now: number,
): ReviewFacts {
  const events = prEvents(d, ps, tl, now);
  const participants: string[] = [];
  for (const e of events)
    if (!e.by_author && e.kind !== "push" && e.kind !== "review_request") {
      const i = participants.indexOf(e.who);
      if (i >= 0) participants.splice(i, 1);
      participants.push(e.who);
    }
  const h = holder(ps, d);
  const asked = asks(events, tl, now);
  const mentions = new Map<string, { login: string; by: string; days_ago: number; text: string }>();
  for (const e of events.filter((x) => x.kind === "comment" && x.text).slice(-10))
    for (const m of e.text!.matchAll(/(?:^|[^\w`/])@([A-Za-z0-9][\w-]*)/g)) {
      const who = m[1]!;
      if (lower(who) === lower(e.who) || lower(who) === lower(ps.author) || isBot(who) || asked.has(who))
        continue;
      mentions.set(lower(who), {
        login: who,
        by: e.who,
        days_ago: e.days_ago ?? 0,
        text: e.text!.slice(0, 600),
      });
    }
  return {
    asks: asked,
    mentions: [...mentions.values()].slice(-5),
    events,
    participants: participants.slice(-6),
    holder: h,
    state: {
      today_note: "Every days_ago is counted back from today.",
      pr: {
        repository: item.repository,
        number: item.number,
        title: d.title,
        author: ps.author,
        opened_days_ago: daysAgo(ps.created_at, now),
        description_start: d.body.slice(0, 1500),
        changed_files: (d.files ?? []).map((f) => f.path).slice(0, 30),
      },
      prow: {
        state_labels: ps.labels.filter((l) =>
          /^(lgtm|approved|do-not-merge\/|needs-rebase|lifecycle\/)/.test(l),
        ),
        tide: ps.tide?.description ?? null,
        failing_checks: ps.failing.slice(0, 10),
        hold_by: h,
      },
      references: refs,
      events: events.slice(-25).map(({ at: _at, ...e }) => e),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Jev: one call per PR.

export interface ReviewAnswers {
  whose_move: JevChoice;
  hold_met?: JevNoul;
  [k: string]: JevChoice | JevNoul | undefined;
}

/** Comments by others since the PR author's own last activity (push, comment or review), newest last: the ones
 *  that could be an unanswered check-in to the author. */
export function sinceAuthor(f: ReviewFacts, author: string): PrEvent[] {
  const last = f.events.filter((e) => e.by_author && e.kind !== "review_request").at(-1)?.at ?? "";
  return f.events
    .filter((e) => e.kind === "comment" && !e.by_author && e.at > last && e.who !== author)
    .slice(-4);
}

export function reviewQuestions(f: ReviewFacts, author?: string): Record<string, unknown> {
  const q: Record<string, unknown> = {
    whose_move: {
      type: "choice",
      instructions: {
        question: "Whose move is it on this pull request now?",
        focus:
          "Read the events in order. The latest reviewer request or question that the author has not answered, a push the reviewers have not looked at, red required checks (`prow.tide`, `prow.failing_checks`) all count.",
        evidence: ["pr", "prow", "references", "events"],
      },
      criteria: {
        author: {
          what: "The author has to act before review can go on.",
          includes: [
            "a reviewer asked for changes, a rebase, tests, a release note or answers, and the author has not replied or pushed since",
            "required checks are red for a reason in the PR (not a known flake someone already retested)",
          ],
        },
        reviewers: {
          what: "The PR waits on reviewers.",
          includes: [
            "nobody has reviewed it yet",
            "the author pushed or answered after the last review",
            "a reviewer said they will look and has not yet",
          ],
        },
        blocked: {
          what: "Neither: it waits on something else.",
          includes: [
            "a /hold (see `prow.hold_by`)",
            "another PR or KEP in `references` that has to merge first",
            "a release freeze or a decision the thread says is pending elsewhere",
          ],
        },
      },
    },
  };
  f.participants.forEach((who, i) => {
    const said = f.events.filter((e) => e.who === who && e.text).slice(-3);
    q[`engaged_${i}`] = {
      type: "noul",
      instructions: {
        what_they_wrote: said.map((e) => ({ days_ago: e.days_ago, review: e.review, text: e.text })),
        question: `Is ${who} reviewing this PR: engaging with the change, or saying they will review it?`,
      },
      criteria: {
        true: "Code or design comments, questions to the author, a review with requests or approval, or a promise to review.",
        false:
          "A drive-by: /retest or other bot commands, a ping, thanks, triage or lane bookkeeping, a /cc of someone else.",
      },
    };
    q[`declined_${i}`] = {
      type: "noul",
      instructions: {
        what_they_wrote: said.map((e) => ({ days_ago: e.days_ago, text: e.text })),
        question: `Did ${who} decline this review or hand it to someone else?`,
      },
      criteria: {
        true: "They said they cannot or will not review (no time, not their area, on leave) or redirected it.",
        false: "Anything else.",
      },
    };
  });
  f.mentions.forEach((m, j) => {
    q[`mention_${j}`] = {
      type: "noul",
      instructions: {
        comment: { by: m.by, days_ago: m.days_ago, text: m.text },
        question: `Does this comment ask ${m.login} to review or approve this pull request (or to take another look at it)?`,
      },
      criteria: {
        true: {
          what: `It asks ${m.login} to review, approve, or look at the PR.`,
          examples: [`@${m.login} for approval`, `@${m.login} PTAL`, `@${m.login} could you take a look?`],
        },
        false: {
          what: "Anything else.",
          examples: [
            `thanks @${m.login}`,
            `as @${m.login} said above`,
            `@${m.login} is this still failing on your side?`,
          ],
        },
      },
    };
  });
  // Waiting on Author asks, like In progress does for assignees, which later comments check in with the author.
  if (author)
    sinceAuthor(f, author).forEach((c, k) => {
      q[`author_checkin_${k}`] = {
        type: "noul",
        instructions: {
          comment: { author: c.who, days_ago: c.days_ago, text: c.text },
          question: `Is \`comment\` a check-in to ${author}, the PR's author: does it ask whether they are still working on this PR, or for an update?`,
        },
        criteria: {
          true: {
            what: `It asks ${author} about their progress or whether they are still on it.`,
            examples: [`@${author} are you still working on this?`, `@${author} any update here?`],
          },
          false: {
            what: "Anything else.",
            examples: [
              "a review comment asking for a change",
              "/retest",
              "thanks!",
              "a question to another reviewer",
            ],
          },
        },
      };
    });
  if (f.holder && f.holder !== "unknown")
    q.hold_met = {
      type: "noul",
      instructions: {
        question: `${f.holder} put a /hold on this PR. From the events after it, does the condition of that hold look met, so it could be lifted?`,
        evidence: ["events", "references"],
      },
      criteria: {
        true: "What the hold asked for has happened: the referenced PR or KEP merged, the requested change was pushed and acknowledged, or the holder said it can be lifted.",
        false: "The condition is still open, unclear, or nothing relevant happened after the hold.",
      },
    };
  return q;
}

// ---------------------------------------------------------------------------------------------------------------
// The decision and the actions.

export const REVIEW_ACTIONS = ["keep", "new_ask", "reping", "to_author", "to_approver", "to_done"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export const REVIEW_LABEL: Record<ReviewAction, string> = {
  keep: "Keep in Needs Reviewer",
  new_ask: "Ask reviewers (/cc)",
  reping: "Re-ping the reviewer",
  to_author: "Move to Waiting on Author",
  to_approver: "Move to Needs Approver",
  to_done: "Move to Done",
};

export const REVIEW_TINT: Record<ReviewAction, "KEEP" | "REMOVE" | "BORDERLINE" | "MOVE"> = {
  keep: "KEEP",
  new_ask: "BORDERLINE",
  reping: "BORDERLINE",
  to_author: "MOVE",
  to_approver: "MOVE",
  to_done: "REMOVE",
};

export interface Candidate {
  login: string;
  /** False for an approver known only from OWNERS, with no recent approvals seen: offered only to cover an OWNERS
   *  file nobody active can approve. */
  active?: boolean;
  /** One checkable reason for the /cc. */
  reason: string;
  /** Jev's P(this one reviews if asked), among the candidates shown. */
  p: number;
}

export interface ReviewResult {
  kind: "review";
  item_id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  pr: Pick<PullState, "state" | "draft" | "author" | "labels" | "tide" | "failing">;
  holder: string | null;
  whose_move: JevChoice;
  hold_met: number | null;
  /** Participants Jev reads as reviewing (and not declined), with their last activity. */
  engaged: { login: string; last_days_ago: number | null }[];
  declined: string[];
  /** People asked to review who have not engaged or declined: who asked, how long ago, and the latest ping. */
  asked: { login: string; by: string; days_ago: number; pinged_days_ago: number | null }[];
  /** Everyone asked (not the author, not someone who declined), engaged or not, with the days since their own last
   *  activity: Needs Approver keeps waiting on an asked approver who commented without approving. */
  asked_all: {
    login: string;
    by: string;
    days_ago: number;
    pinged_days_ago: number | null;
    active_days_ago: number | null;
  }[];
  /** Latest ping to each engaged reviewer, in days. */
  pinged: Record<string, number | null>;
  /** Days since the latest review by someone other than the author: when the ball last went to the author. */
  last_review_days_ago?: number | null;
  /** Days since the newest comment Jev reads as an unanswered check-in with the author (Waiting on Author only). */
  author_checkin_days_ago?: number | null;
  /** Days since the author's last push or comment. */
  author_last_days_ago: number | null;
  /** Filled when the PR needs a new reviewer ask. */
  candidates: Candidate[];
  candidates_note: string;
  usage: JevUsage;
  /** Prow commands someone mistyped in the thread, with their fixes (prowcmds.ts). */
  prow_fixes?: ProwFix[];
  /** Every answer Jev gave, labelled, for the bars on the hover card and the pane. */
  readings?: Reading[];
}

/** Plain rules first (merged, draft, lgtm, needs-rebase), then the hold, then Jev's whose-move; a PR waiting on
 *  reviewers keeps its engaged reviewer, re-pings one who went quiet after the author's last move, or asks new
 *  ones. */
export function decideReview(r: Omit<ReviewResult, "candidates" | "candidates_note">): {
  action: ReviewAction;
  why: string;
  reping?: string;
} {
  const L = new Set(r.pr.labels);
  if (r.pr.state !== "open") return { action: "to_done", why: `${r.pr.state}` };
  if (r.pr.draft || L.has("do-not-merge/work-in-progress"))
    return { action: "to_author", why: r.pr.draft ? "draft" : "work in progress" };
  if (L.has("lgtm")) return { action: "to_approver", why: "has lgtm" };
  const stale = [...L].filter((l) => l === "needs-rebase" || /^lifecycle\/(stale|rotten)$/.test(l));
  if (stale.length) return { action: "to_author", why: stale.join(", ") };
  if (r.holder) {
    if (r.holder === lower(r.pr.author) || r.holder === r.pr.author)
      return { action: "keep", why: `held by the author, ${r.holder}` };
    if ((r.hold_met ?? 0) >= 0.65)
      return { action: "reping", why: `${r.holder}'s /hold condition looks met`, reping: r.holder };
    return { action: "to_author", why: `held by ${r.holder}, condition not met yet` };
  }
  const move = r.whose_move.choice;
  if (move === "author") return { action: "to_author", why: "the author has to act next" };
  if (move === "blocked") return { action: "keep", why: "waits on something else (see the thread)" };
  const eng = r.engaged.at(-1);
  if (eng) {
    const quiet = eng.last_days_ago ?? 0;
    const authorAfter = r.author_last_days_ago !== null && r.author_last_days_ago < quiet;
    const ping = r.pinged[eng.login] ?? null;
    if (quiet >= REPING_DAYS && authorAfter) {
      if (ping !== null && ping < REPING_DAYS)
        return { action: "keep", why: `${eng.login} was pinged ${ping}d ago; re-ping after ${REPING_DAYS}d` };
      return {
        action: "reping",
        why: `${eng.login} was reviewing, quiet ${quiet}d since the author's last move`,
        reping: eng.login,
      };
    }
    return { action: "keep", why: `${eng.login} is reviewing (${quiet}d ago)` };
  }
  // Someone was already asked: wait for them, then re-ping (a ping restarts the wait).
  const ask = [...r.asked].sort((x, y) => x.days_ago - y.days_ago)[0];
  if (ask) {
    const since = Math.min(ask.days_ago, ask.pinged_days_ago ?? Infinity);
    if (since < REPING_DAYS)
      return { action: "keep", why: `${ask.by} asked ${ask.login} ${ask.days_ago}d ago` };
    return {
      action: "reping",
      why: `${ask.login} was asked ${ask.days_ago}d ago and has not engaged`,
      reping: ask.login,
    };
  }
  // The search runs after this decision (worker); once it has, an empty result means there is nobody to ask.
  const searched = r as Partial<Pick<ReviewResult, "candidates" | "candidates_note">>;
  if (searched.candidates && !searched.candidates.length && searched.candidates_note)
    return {
      action: "keep",
      why: `nobody is reviewing it and no candidate was found: ${searched.candidates_note}`,
    };
  return { action: "new_ask", why: "nobody is reviewing it and nobody was asked" };
}

export const REVIEW_PREFIX = {
  reping: "could you take another look? The author has moved since your last review.",
  asked: "could you take a look? You were asked to review this earlier.",
  hold: "the condition for your /hold looks met from the thread above; could you take another look and /unhold if you agree?",
  ask: "Whoever has the bandwidth, please take a look; feel free to pass if you are swamped.",
} as const;

export function repingBody(who: string, kind: "hold" | "reviewing" | "asked"): string {
  const text =
    kind === "hold" ? REVIEW_PREFIX.hold : kind === "asked" ? REVIEW_PREFIX.asked : REVIEW_PREFIX.reping;
  return `@${who} ${text}`;
}

export function askBody(cands: Candidate[]): string {
  return [
    `/cc ${cands.map((c) => `@${c.login}`).join(" ")}`,
    ...cands.map((c) => `@${c.login}: ${c.reason}`),
    REVIEW_PREFIX.ask,
  ].join("\n");
}

export function reviewSteps(item: BoardItem, r: ReviewResult, action: ReviewAction): ActionStep[] {
  const { repository: repo, number } = item;
  const comment = (body: string): ActionStep => ({ kind: "comment", repo, number, body });
  const move = (lane: string): ActionStep => ({ kind: "move", itemId: item.id, restId: item.restId, lane });
  const d = decideReview(r);
  switch (action) {
    case "keep":
      return [];
    case "new_ask":
      return r.candidates.length ? [comment(askBody(r.candidates))] : [];
    case "reping": {
      const who =
        d.reping ??
        r.engaged.at(-1)?.login ??
        r.asked[0]?.login ??
        (r.holder !== "unknown" ? r.holder : null);
      if (!who) return [];
      const kind = who === r.holder ? "hold" : r.engaged.some((e) => e.login === who) ? "reviewing" : "asked";
      return [comment(repingBody(who, kind))];
    }
    case "to_author":
      return [move("PRs Waiting on Author")];
    case "to_approver":
      return [move("PRs - Needs Approver")];
    case "to_done":
      return [move("Done")];
  }
}

/** Actions a reviewer can pick: asking needs candidates, re-pinging needs someone to ping. */
export function reviewActions(r: ReviewResult): ReviewAction[] {
  return REVIEW_ACTIONS.filter(
    (a) =>
      (a !== "new_ask" || r.candidates.length > 0) &&
      (a !== "reping" ||
        r.engaged.length > 0 ||
        r.asked.length > 0 ||
        (r.holder !== null && r.holder !== "unknown")),
  );
}

export async function judgeReview(
  item: BoardItem,
  d: ItemDetail,
  ps: PullState,
  tl: TimelineEvent[],
  refState: (repo: string, n: number) => Promise<string>,
  jev: JevClient,
  now = Date.now(),
  opts: { authorCheckins?: boolean } = {},
): Promise<Omit<ReviewResult, "candidates" | "candidates_note">> {
  const refs = await Promise.all(
    references(item.repository, item.number, [d.body, ...d.comments.map((c) => c.body)]).map(async (x) => ({
      ...x,
      state: await refState(x.repo, x.number),
    })),
  );
  const f = reviewFacts(item, d, ps, tl, refs, now);
  const r = await jev.ask<ReviewAnswers>(
    f.state,
    reviewQuestions(f, opts.authorCheckins ? ps.author : undefined),
  );
  const a = r.answers;
  const lastOf = (who: string) =>
    f.events.filter((e) => e.who === who && e.kind !== "review_request").at(-1)?.days_ago ?? null;
  const engaged = f.participants
    .map((who, i) => ({ who, i }))
    .filter(
      ({ i }) =>
        ((a[`engaged_${i}`] as JevNoul)?.noul ?? 0) >= 0.6 &&
        ((a[`declined_${i}`] as JevNoul)?.noul ?? 0) < 0.6,
    )
    .map(({ who }) => ({ login: who, last_days_ago: lastOf(who) }));
  const declined = f.participants.filter((_, i) => ((a[`declined_${i}`] as JevNoul)?.noul ?? 0) >= 0.6);
  const authorEv = f.events.filter((e) => e.by_author && e.kind !== "review_request").at(-1);
  const involved = new Set([...engaged.map((e) => e.login), ...declined].map(lower));
  // A comment Jev reads as asking someone to review or approve counts like a /cc.
  const allAsks = new Map(f.asks);
  f.mentions.forEach((m, j) => {
    if (((a[`mention_${j}`] as JevNoul)?.noul ?? 0) >= 0.6)
      allAsks.set(m.login, { by: m.by, days_ago: m.days_ago });
  });
  const asked = [...allAsks]
    .filter(([who]) => !involved.has(lower(who)) && lower(who) !== lower(ps.author))
    .map(([login, v]) => ({ login, ...v, pinged_days_ago: lastPing(f.events, login) }));
  const declinedL = new Set(declined.map(lower));
  const asked_all = [...allAsks]
    .filter(([who]) => !declinedL.has(lower(who)) && lower(who) !== lower(ps.author))
    .map(([login, v]) => ({
      login,
      ...v,
      pinged_days_ago: lastPing(f.events, login),
      active_days_ago: lastOf(login),
    }));
  const pinged = Object.fromEntries(engaged.map((e) => [e.login, lastPing(f.events, e.login)]));
  return {
    kind: "review",
    item_id: item.id,
    repo: item.repository,
    number: item.number,
    title: d.title,
    url: item.url,
    pr: {
      state: ps.state,
      draft: ps.draft,
      author: ps.author,
      labels: ps.labels,
      tide: ps.tide,
      failing: ps.failing,
    },
    holder: f.holder,
    whose_move: a.whose_move,
    hold_met: a.hold_met?.noul ?? null,
    engaged,
    declined,
    asked,
    asked_all,
    pinged,
    author_last_days_ago: authorEv?.days_ago ?? null,
    last_review_days_ago:
      f.events.filter((e) => e.kind === "review" && !e.by_author).at(-1)?.days_ago ?? null,
    author_checkin_days_ago: opts.authorCheckins
      ? (sinceAuthor(f, ps.author)
          .map((c, k) => ({ c, p: (a[`author_checkin_${k}`] as JevNoul)?.noul ?? 0 }))
          .filter((x) => x.p >= 0.6)
          .at(-1)?.c.days_ago ?? null)
      : null,
    readings: [
      ...choiceReading("Whose move", a.whose_move),
      ...f.participants.flatMap((who, i) => [
        ...noulReading(`${who} is reviewing`, a[`engaged_${i}`] as JevNoul),
        ...noulReading(`${who} declined or handed off`, a[`declined_${i}`] as JevNoul, true),
      ]),
      ...f.mentions.flatMap((m, j) =>
        noulReading(`${m.by} asks ${m.login} to review (${m.days_ago}d ago)`, a[`mention_${j}`] as JevNoul),
      ),
      ...(opts.authorCheckins
        ? sinceAuthor(f, ps.author).flatMap((c, k) =>
            noulReading(
              `check-in to the author (${c.who}, ${c.days_ago}d ago)`,
              a[`author_checkin_${k}`] as JevNoul,
            ),
          )
        : []),
      ...noulReading("Hold condition met", a.hold_met),
    ],
    usage: r.usage,
  };
}
