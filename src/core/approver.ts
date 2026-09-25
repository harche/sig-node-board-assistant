/** 'PRs - Needs Approver': a PR with lgtm waiting for an OWNERS approver's /approve. The same facts and Jev call as
 *  Needs Reviewer (reviewer.ts: whose move, who is engaged or declined, holds, asks and pings); the rules and the
 *  ask differ. Prow's approval notifier names one approver per OWNERS file, often someone who no longer approves,
 *  so the extension asks who approved this code lately instead (candidates.ts blendApprovers). */
import type { ActionStep, BoardItem } from "./types";
import { REPING_DAYS, repingBody, type ReviewResult } from "./reviewer";

export const APPROVE_ACTIONS = ["keep", "new_ask", "reping", "to_reviewer", "to_author", "to_done"] as const;
export type ApproveAction = (typeof APPROVE_ACTIONS)[number];

export const APPROVE_LABEL: Record<ApproveAction, string> = {
  keep: "Keep in Needs Approver",
  new_ask: "Ask approvers (/cc)",
  reping: "Re-ping the approver",
  to_reviewer: "Move to Needs Reviewer",
  to_author: "Move to Waiting on Author",
  to_done: "Move to Done",
};

export const APPROVE_TINT: Record<ApproveAction, "KEEP" | "REMOVE" | "BORDERLINE" | "MOVE"> = {
  keep: "KEEP",
  new_ask: "BORDERLINE",
  reping: "BORDERLINE",
  to_reviewer: "MOVE",
  to_author: "MOVE",
  to_done: "REMOVE",
};

/** Same shape as a Needs Reviewer result; `candidates` are approvers here. */
export type ApproveResult = Omit<ReviewResult, "kind"> & { kind: "approve" };

export function decideApprove(r: Omit<ApproveResult, "candidates" | "candidates_note">): {
  action: ApproveAction;
  why: string;
  reping?: string;
} {
  const L = new Set(r.pr.labels);
  if (r.pr.state !== "open") return { action: "to_done", why: r.pr.state };
  if (r.pr.draft || L.has("do-not-merge/work-in-progress"))
    return { action: "to_author", why: r.pr.draft ? "draft" : "work in progress" };
  if (!L.has("lgtm")) return { action: "to_reviewer", why: "no lgtm: it still needs a review" };
  const stale = [...L].filter((l) => l === "needs-rebase" || /^lifecycle\/(stale|rotten)$/.test(l));
  if (stale.length) return { action: "to_author", why: stale.join(", ") };
  if (r.holder) {
    if (r.holder === r.pr.author) return { action: "keep", why: `held by the author, ${r.holder}` };
    if ((r.hold_met ?? 0) >= 0.65)
      return { action: "reping", why: `${r.holder}'s /hold condition looks met`, reping: r.holder };
    return { action: "to_author", why: `held by ${r.holder}, condition not met yet` };
  }
  // lgtm and approved but still open: Prow's tide says what blocks the merge.
  if (L.has("approved")) {
    if (r.pr.failing.length)
      return { action: "to_author", why: `approved, but failing: ${r.pr.failing.slice(0, 3).join(", ")}` };
    return { action: "keep", why: `approved; ${r.pr.tide?.description || "waiting for tide to merge it"}` };
  }
  const move = r.whose_move.choice;
  if (move === "author") return { action: "to_author", why: "the author has to act next" };
  if (move === "blocked") return { action: "keep", why: "waits on something else (see the thread)" };
  // Someone asked to approve is still the approver after commenting without approving: the wait restarts with
  // their own activity, an ask or a ping, whichever is latest.
  const ask = [...r.asked_all]
    .map((x) => ({
      ...x,
      since: Math.min(x.days_ago, x.pinged_days_ago ?? Infinity, x.active_days_ago ?? Infinity),
    }))
    .sort((x, y) => x.since - y.since)[0];
  if (ask) {
    if (ask.since < REPING_DAYS)
      return {
        action: "keep",
        why:
          ask.active_days_ago !== null && ask.active_days_ago <= ask.days_ago
            ? `${ask.login} was asked and commented ${ask.active_days_ago}d ago`
            : `${ask.by} asked ${ask.login} ${ask.days_ago}d ago`,
      };
    return {
      action: "reping",
      why: `${ask.login} was asked ${ask.days_ago}d ago; quiet ${ask.since}d`,
      reping: ask.login,
    };
  }
  const searched = r as Partial<Pick<ApproveResult, "candidates" | "candidates_note">>;
  if (searched.candidates && !searched.candidates.length && searched.candidates_note)
    return { action: "keep", why: `nobody was asked and no approver was found: ${searched.candidates_note}` };
  return { action: "new_ask", why: "it has lgtm and nobody was asked to approve it" };
}

export const APPROVE_PREFIX = {
  reping: "could you take a look for approval? This has lgtm and you were asked earlier.",
  ask: "This has lgtm and needs an approver. Whoever has the bandwidth, please take a look; feel free to pass if you are swamped.",
} as const;

export function approveAskBody(cands: { login: string; reason: string }[]): string {
  return [
    `/cc ${cands.map((c) => `@${c.login}`).join(" ")}`,
    ...cands.map((c) => `@${c.login}: ${c.reason}`),
    APPROVE_PREFIX.ask,
  ].join("\n");
}

export function approveSteps(item: BoardItem, r: ApproveResult, action: ApproveAction): ActionStep[] {
  const { repository: repo, number } = item;
  const comment = (body: string): ActionStep => ({ kind: "comment", repo, number, body });
  const move = (lane: string): ActionStep => ({ kind: "move", itemId: item.id, restId: item.restId, lane });
  switch (action) {
    case "keep":
      return [];
    case "new_ask":
      return r.candidates.length ? [comment(approveAskBody(r.candidates))] : [];
    case "reping": {
      const who =
        decideApprove(r).reping ?? r.asked_all[0]?.login ?? (r.holder !== "unknown" ? r.holder : null);
      if (!who) return [];
      // A reviewer's hold uses Needs Reviewer's wording; an approver ask its own.
      return [comment(who === r.holder ? repingBody(who, "hold") : `@${who} ${APPROVE_PREFIX.reping}`)];
    }
    case "to_reviewer":
      return [move("PRs - Needs Reviewer")];
    case "to_author":
      return [move("PRs Waiting on Author")];
    case "to_done":
      return [move("Done")];
  }
}

export function approveActions(r: ApproveResult): ApproveAction[] {
  return APPROVE_ACTIONS.filter(
    (a) =>
      (a !== "new_ask" || r.candidates.length > 0) &&
      (a !== "reping" || r.asked_all.length > 0 || (r.holder !== null && r.holder !== "unknown")),
  );
}
