import { describe, expect, it } from "vitest";
import {
  approveAskBody,
  approveSteps,
  APPROVE_PREFIX,
  decideApprove,
  type ApproveResult,
} from "../src/core/approver";
import { blendApprovers, coverApprovers, unapprovedOwners } from "../src/core/candidates";
import { isDraftedComment } from "../src/core/comments";

const base = (over: Partial<ApproveResult> = {}): ApproveResult => ({
  kind: "approve",
  item_id: "i",
  repo: "o/r",
  number: 1,
  title: "t",
  url: "u",
  pr: { state: "open", draft: false, author: "auth", labels: ["lgtm"], tide: null, failing: [] },
  holder: null,
  whose_move: { type: "choice", choice: "reviewers", confidence: 0.9, probabilities: { reviewers: 0.9 } },
  hold_met: null,
  engaged: [],
  declined: [],
  asked: [],
  asked_all: [],
  pinged: {},
  author_last_days_ago: 3,
  candidates: [],
  candidates_note: "",
  usage: { input_tokens: 0, cost: 0 },
  ...over,
});
const ask = (days_ago: number, active_days_ago: number | null) => ({
  login: "x",
  by: "d",
  days_ago,
  pinged_days_ago: null,
  active_days_ago,
});
const pr = (labels: string[], over: Partial<ApproveResult["pr"]> = {}) => ({ ...base().pr, labels, ...over });

describe("decideApprove", () => {
  it.each([
    ["merged", base({ pr: pr(["lgtm"], { state: "merged" }) }), "to_done"],
    ["no lgtm", base({ pr: pr([]) }), "to_reviewer"],
    ["rotten", base({ pr: pr(["lgtm", "lifecycle/rotten"]) }), "to_author"],
    [
      "approved, failing",
      base({ pr: pr(["lgtm", "approved"], { failing: ["pull-kubernetes-unit"] }) }),
      "to_author",
    ],
    ["approved, waiting for tide", base({ pr: pr(["lgtm", "approved"]) }), "keep"],
    [
      "author's move",
      base({ whose_move: { type: "choice", choice: "author", confidence: 1, probabilities: {} } }),
      "to_author",
    ],
    ["asked 3 days ago", base({ asked_all: [ask(3, null)] }), "keep"],
    ["asked 20 days ago", base({ asked_all: [ask(20, null)] }), "reping"],
    ["asked 20 days ago, commented 4 days ago", base({ asked_all: [ask(20, 4)] }), "keep"],
    ["asked 30 days ago, commented 20 days ago", base({ asked_all: [ask(30, 20)] }), "reping"],
    ["nobody asked, not searched yet", base(), "new_ask"],
    ["nobody asked, no approver found", base({ candidates_note: "none" }), "keep"],
  ] as [string, ApproveResult, string][])("%s -> %s", (_w, r, want) =>
    expect(decideApprove(r).action).toBe(want),
  );
});

describe("comments", () => {
  it("accepts the approver ask and re-ping", () => {
    const body = approveAskBody([{ login: "a", reason: "you approved 3 recent PRs touching `pkg/x.go`" }]);
    expect(isDraftedComment(body)).toBe(true);
    const r = base({ asked_all: [ask(20, null)] });
    const [st] = approveSteps({ repository: "o/r", number: 1, id: "I", restId: 2 } as never, r, "reping");
    expect(st).toMatchObject({ kind: "comment", body: `@x ${APPROVE_PREFIX.reping}` });
    expect(isDraftedComment((st as { body: string }).body)).toBe(true);
  });
});

describe("blendApprovers", () => {
  const hp = (n: number, approvers: string[], author = "s") => ({
    number: n,
    title: `pr ${n}`,
    author,
    created: "2026-09-01T00:00:00Z",
    reviewers: [],
    approvers,
  });
  it("ranks eligible approvers by recent approvals, skips the ineligible, the author and emeritus", () => {
    const out = blendApprovers(
      "auth",
      ["pkg/a.go"],
      ["pkg"],
      {
        byPath: { "pkg/a.go": [hp(1, ["filer"]), hp(2, ["filer", "outsider"])], pkg: [hp(3, ["dirr"])] },
        byAuthor: [],
      },
      new Map([
        ["filer", "pkg"],
        ["dirr", "pkg"],
        ["quiet", "/"],
        ["old", "pkg"],
      ]),
      new Set(["old"]),
      [],
    );
    expect(out.slice(0, 3).map((c) => c.login)).toEqual(["filer", "dirr", "quiet"]);
    expect(out[0]!.reason).toBe("you approved 2 recent PRs touching `pkg/a.go`");
    expect(out[2]!.reason).toBe("you are an OWNERS approver for `/`");
  });
});

describe("required OWNERS", () => {
  it("reads the unapproved OWNERS files from Prow's latest notifier comment", () => {
    const body =
      "[APPROVALNOTIFIER] This PR is **NOT APPROVED**\n\n<details open>\nNeeds approval from an approver in each of these files:\n\n- **[test/e2e/node/OWNERS](https://github.com/k/k/blob/master/test/e2e/node/OWNERS)**\n- **[OWNERS](https://github.com/k/k/blob/master/OWNERS)**\n\nApprovers can indicate";
    expect(unapprovedOwners([{ author: { login: "kubernetes-prow[bot]" }, body }])).toEqual([
      "test/e2e/node",
      "",
    ]);
    expect(unapprovedOwners([{ author: { login: "someone" }, body: "hi" }])).toBeNull();
  });

  it("picks an approver for every unapproved OWNERS file before filling up", () => {
    const c = (login: string) => ({ login, reason: "r", p: 1 });
    const ranked = [c("a"), c("b"), c("c"), c("d")];
    const can = new Map([
      ["pkg/x", new Set(["a", "b"])],
      ["test/y", new Set(["d"])],
    ]);
    expect(coverApprovers(ranked, can).picks.map((x) => x.login)).toEqual(["a", "d", "b"]);
  });

  it("never names more than three, and reports the OWNERS files left over", () => {
    const c = (login: string) => ({ login, reason: "r", p: 1 });
    const can = new Map(["p", "q", "r", "s"].map((d) => [d, new Set([d + "-appr"])]));
    const out = coverApprovers(
      ["p", "q", "r", "s"].map((d) => c(d + "-appr")),
      can,
    );
    expect(out.picks).toHaveLength(3);
    expect(out.uncovered).toEqual(["s"]);
  });
});
