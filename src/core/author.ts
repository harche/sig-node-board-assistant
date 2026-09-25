/** 'PRs Waiting on Author': a PR whose author has to act (answer a review, fix CI, rebase). Nothing moves a card
 *  out when the author does act, so it goes stale like the other lanes. The same facts and Jev call as Needs
 *  Reviewer (reviewer.ts), plus which later comments are a check-in with the author, and Triage's scope verdict:
 *  PRs that are not SIG Node CI work leave the board. After a nudge goes unanswered the card stays: the Kubernetes
 *  lifecycle bot marks the PR stale, then rotten, then closes it. */
import type { ReviewResult } from "./reviewer";
import { STALE_DAYS, NUDGE_GRACE_DAYS } from "./inprogress";
import type { ActionStep, BoardItem, Verdict } from "./types";

export const AUTHOR_ACTIONS = ["keep", "nudge", "to_reviewer", "to_approver", "to_done", "archive"] as const;
export type AuthorAction = (typeof AUTHOR_ACTIONS)[number];

export const AUTHOR_LABEL: Record<AuthorAction, string> = {
  keep: "Keep in Waiting on Author",
  nudge: "Nudge the author",
  to_reviewer: "Move to Needs Reviewer",
  to_approver: "Move to Needs Approver",
  to_done: "Move to Done",
  archive: "Archive",
};

export const AUTHOR_TINT: Record<AuthorAction, "KEEP" | "REMOVE" | "BORDERLINE" | "MOVE"> = {
  keep: "KEEP",
  nudge: "BORDERLINE",
  to_reviewer: "MOVE",
  to_approver: "MOVE",
  to_done: "REMOVE",
  archive: "REMOVE",
};

export type AuthorResult = Omit<ReviewResult, "kind"> & {
  kind: "author";
  /** Triage's verdict on whether the PR belongs on the board at all. */
  scope: { verdict: Verdict; why: string };
};

export function decideAuthor(r: Omit<AuthorResult, "candidates" | "candidates_note">): {
  action: AuthorAction;
  why: string;
} {
  const L = new Set(r.pr.labels);
  if (r.pr.state !== "open") return { action: "to_done", why: r.pr.state };
  if (r.scope.verdict === "REMOVE") return { action: "archive", why: `not SIG Node CI work: ${r.scope.why}` };
  // The same labels Needs Reviewer and Needs Approver send to the author: a PR with one of them stays here, or the
  // columns would pass it back and forth.
  const blocked =
    r.pr.draft ||
    [
      "needs-rebase",
      "do-not-merge/hold",
      "do-not-merge/work-in-progress",
      "lifecycle/stale",
      "lifecycle/rotten",
    ].some((l) => L.has(l));
  if (L.has("lgtm") && !blocked) return { action: "to_approver", why: "has lgtm" };
  if (r.holder && r.holder !== "unknown") return { action: "keep", why: `held by ${r.holder}` };
  const move = r.whose_move.choice;
  if (move === "reviewers" && !blocked)
    return { action: "to_reviewer", why: "the author answered or pushed since the last review request" };
  if (move === "blocked") return { action: "keep", why: "waits on something else (see the thread)" };
  // The author's move, counted from when it became theirs: their own last activity or the last review, whichever
  // is later (a fresh change request is not the author going quiet).
  const own = r.author_last_days_ago;
  const review = r.last_review_days_ago ?? null;
  const quiet = quietDays(r);
  if (quiet === null || quiet <= STALE_DAYS)
    return {
      action: "keep",
      why:
        review !== null && quiet === review && review !== own
          ? `a review ${review}d ago asked the author to act`
          : `the author was active ${quiet ?? "?"}d ago`,
    };
  const checkin = r.author_checkin_days_ago ?? null;
  if (checkin !== null && checkin < NUDGE_GRACE_DAYS)
    return { action: "keep", why: `someone checked in with the author ${checkin}d ago` };
  if (checkin !== null)
    return {
      action: "keep",
      why: `a check-in ${checkin}d ago went unanswered; the lifecycle bot takes it from here (stale, rotten, closed)`,
    };
  return { action: "nudge", why: `the author has been quiet for ${quiet}d and nobody checked in` };
}

/** Days since the PR became the author's move and they have not acted. */
export function quietDays(
  r: Pick<AuthorResult, "author_last_days_ago" | "last_review_days_ago">,
): number | null {
  const own = r.author_last_days_ago;
  const review = r.last_review_days_ago ?? null;
  return own === null ? review : review === null ? own : Math.min(own, review);
}

export const AUTHOR_PREFIX = {
  nudge: "are you still working on this PR?",
} as const;

export function authorNudgeBody(author: string, quietDays: number | null): string {
  const q = quietDays === null ? "" : ` It has been quiet for ${quietDays} days.`;
  return `@${author} ${AUTHOR_PREFIX.nudge}${q} If you are waiting on something or need a hand, say so here; if not, feel free to close it.`;
}

export function authorSteps(item: BoardItem, r: AuthorResult, action: AuthorAction): ActionStep[] {
  const { repository: repo, number } = item;
  const move = (lane: string): ActionStep => ({ kind: "move", itemId: item.id, restId: item.restId, lane });
  switch (action) {
    case "keep":
      return [];
    case "nudge":
      return [{ kind: "comment", repo, number, body: authorNudgeBody(r.pr.author, quietDays(r)) }];
    case "to_reviewer":
      return [move("PRs - Needs Reviewer")];
    case "to_approver":
      return [move("PRs - Needs Approver")];
    case "to_done":
      return [move("Done")];
    case "archive":
      return [move("Archive-it")];
  }
}

export function authorActions(): AuthorAction[] {
  return [...AUTHOR_ACTIONS];
}
