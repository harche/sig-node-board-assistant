import { describe, expect, it } from "vitest";
import { authorNudgeBody, authorSteps, decideAuthor, type AuthorResult } from "../src/core/author";
import { isDraftedComment } from "../src/core/comments";

const base = (over: Partial<AuthorResult> = {}): AuthorResult => ({
  kind: "author",
  item_id: "i",
  repo: "o/r",
  number: 1,
  title: "t",
  url: "u",
  pr: { state: "open", draft: false, author: "auth", labels: [], tide: null, failing: [] },
  holder: null,
  whose_move: { type: "choice", choice: "author", confidence: 0.9, probabilities: { author: 0.9 } },
  hold_met: null,
  engaged: [],
  declined: [],
  asked: [],
  asked_all: [],
  pinged: {},
  author_last_days_ago: 3,
  author_checkin_days_ago: null,
  candidates: [],
  candidates_note: "",
  usage: { input_tokens: 0, cost: 0 },
  scope: { verdict: "KEEP", why: "" },
  ...over,
});
const move = (choice: string) => ({ type: "choice" as const, choice, confidence: 1, probabilities: {} });

describe("decideAuthor", () => {
  it.each([
    ["merged", base({ pr: { ...base().pr, state: "merged" } }), "to_done"],
    ["out of scope", base({ scope: { verdict: "REMOVE", why: "sig-auth work" } }), "archive"],
    ["lgtm", base({ pr: { ...base().pr, labels: ["lgtm"] } }), "to_approver"],
    ["lgtm but needs a rebase", base({ pr: { ...base().pr, labels: ["lgtm", "needs-rebase"] } }), "keep"],
    ["the author answered", base({ whose_move: move("reviewers") }), "to_reviewer"],
    ...["lifecycle/stale", "lifecycle/rotten", "do-not-merge/work-in-progress", "needs-rebase"].map(
      (l) =>
        [
          `the author answered, but ${l}`,
          base({ whose_move: move("reviewers"), pr: { ...base().pr, labels: [l] } }),
          "keep",
        ] as [string, AuthorResult, string],
    ),
    ["author active", base({ author_last_days_ago: 10 }), "keep"],
    ["author quiet, nobody checked in", base({ author_last_days_ago: 45 }), "nudge"],
    [
      "author quiet, but a review asked for changes today",
      base({ author_last_days_ago: 65, last_review_days_ago: 0 }),
      "keep",
    ],
    [
      "author quiet, checked in 5 days ago",
      base({ author_last_days_ago: 45, author_checkin_days_ago: 5 }),
      "keep",
    ],
    [
      "author quiet, check-in unanswered",
      base({ author_last_days_ago: 60, author_checkin_days_ago: 20 }),
      "keep",
    ],
  ] as [string, AuthorResult, string][])("%s -> %s", (_w, r, want) =>
    expect(decideAuthor(r).action).toBe(want),
  );

  it("leaves an unanswered check-in to the lifecycle bot", () => {
    expect(decideAuthor(base({ author_last_days_ago: 60, author_checkin_days_ago: 20 })).why).toContain(
      "lifecycle bot",
    );
  });
});

describe("nudge", () => {
  it("mentions only the author, and passes the allow-list", () => {
    const [st] = authorSteps(
      { repository: "o/r", number: 1, id: "I", restId: 2 } as never,
      base({ author_last_days_ago: 45 }),
      "nudge",
    );
    expect(st).toMatchObject({ kind: "comment", body: authorNudgeBody("auth", 45) });
    expect(isDraftedComment(authorNudgeBody("auth", 45))).toBe(true);
    expect(isDraftedComment(`${authorNudgeBody("auth", 45)} cc @other`)).toBe(false);
  });
});
