import { describe, expect, it } from "vitest";
import { blend, parseAliases, parseOwners } from "../src/core/candidates";
import { isDraftedComment } from "../src/core/comments";
import type { PullState, TimelineEvent } from "../src/core/github";
import {
  askBody,
  asks,
  decideReview,
  holder,
  lastPing,
  prEvents,
  repingBody,
  type ReviewResult,
} from "../src/core/reviewer";
import type { ItemDetail } from "../src/core/types";

const NOW = Date.parse("2026-09-25T00:00:00Z");
const ago = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const ps = (over: Partial<PullState> = {}): PullState => ({
  state: "open",
  draft: false,
  author: "auth",
  created_at: ago(60),
  labels: [],
  tide: null,
  failing: [],
  reviews: [],
  ...over,
});
const detail = (comments: [string, number, string][], body = ""): ItemDetail => ({
  title: "t",
  body,
  labels: [],
  state: "open",
  author: { login: "auth" },
  createdAt: ago(60),
  url: "u",
  comments: comments.map(([login, d, text]) => ({ author: { login }, createdAt: ago(d), body: text })),
});

const base = (over: Partial<ReviewResult> = {}): ReviewResult => ({
  kind: "review",
  item_id: "i",
  repo: "o/r",
  number: 1,
  title: "t",
  url: "u",
  pr: { state: "open", draft: false, author: "auth", labels: [], tide: null, failing: [] },
  holder: null,
  whose_move: { type: "choice", choice: "reviewers", confidence: 0.9, probabilities: { reviewers: 0.9 } },
  hold_met: null,
  engaged: [],
  declined: [],
  asked: [],
  pinged: {},
  author_last_days_ago: 3,
  candidates: [],
  candidates_note: "",
  usage: { input_tokens: 0, cost: 0 },
  ...over,
});

describe("decideReview", () => {
  it.each([
    ["merged", base({ pr: { ...base().pr, state: "merged" } }), "to_done"],
    ["draft", base({ pr: { ...base().pr, draft: true } }), "to_author"],
    ["lgtm", base({ pr: { ...base().pr, labels: ["lgtm"] } }), "to_approver"],
    ["needs-rebase", base({ pr: { ...base().pr, labels: ["needs-rebase"] } }), "to_author"],
    ["author's own hold", base({ holder: "auth" }), "keep"],
    ["reviewer's hold, met", base({ holder: "rev", hold_met: 0.8 }), "reping"],
    ["reviewer's hold, not met", base({ holder: "rev", hold_met: 0.2 }), "to_author"],
    [
      "author's move",
      base({ whose_move: { type: "choice", choice: "author", confidence: 1, probabilities: {} } }),
      "to_author",
    ],
    ["nobody reviewing or asked, not searched yet", base(), "new_ask"],
    [
      "nobody reviewing, search found no one",
      base({ candidates_note: "no one with review history" }),
      "keep",
    ],
    [
      "nobody reviewing, search found someone",
      base({ candidates: [{ login: "a", reason: "r", p: 1 }], candidates_note: "1 candidate" }),
      "new_ask",
    ],
    [
      "asked 5 days ago",
      base({ asked: [{ login: "x", by: "tri", days_ago: 5, pinged_days_ago: null }] }),
      "keep",
    ],
    [
      "asked 20 days ago",
      base({ asked: [{ login: "x", by: "tri", days_ago: 20, pinged_days_ago: null }] }),
      "reping",
    ],
    [
      "asked 20 days ago, pinged 3",
      base({ asked: [{ login: "x", by: "tri", days_ago: 20, pinged_days_ago: 3 }] }),
      "keep",
    ],
    [
      "reviewer quiet after the author moved",
      base({ engaged: [{ login: "x", last_days_ago: 30 }], author_last_days_ago: 20 }),
      "reping",
    ],
    [
      "reviewer quiet, pinged 9 days ago",
      base({ engaged: [{ login: "x", last_days_ago: 30 }], pinged: { x: 9 } }),
      "keep",
    ],
    ["reviewer active", base({ engaged: [{ login: "x", last_days_ago: 3 }] }), "keep"],
  ] as [string, ReviewResult, string][])("%s -> %s", (_w, r, want) =>
    expect(decideReview(r).action).toBe(want),
  );
});

describe("facts", () => {
  it("finds the holder in a review, not only in comments", () => {
    const p = ps({
      labels: ["do-not-merge/hold"],
      reviews: [{ author: "rev", state: "COMMENTED", at: ago(80), body: "/lgtm\n/hold\nnits" }],
    });
    expect(holder(p, detail([["x", 10, "ping on the /hold"]]))).toBe("rev");
    expect(holder(ps(), detail([]))).toBeNull();
  });

  it("collects asks from /cc and /assign (the author's too) and human review requests", () => {
    const d = detail([
      ["tri", 3, "/assign @bob"],
      ["auth", 7, "/cc @carol\nready for a look"],
    ]);
    const tl: TimelineEvent[] = [
      {
        event: "review_requested",
        created_at: ago(9),
        actor: { login: "dan" },
        requested_reviewer: { login: "erin" },
      },
      {
        event: "review_requested",
        created_at: ago(9),
        actor: { login: "k8s-ci-robot" },
        requested_reviewer: { login: "bot-pick" },
      },
    ];
    const a = asks(prEvents(d, ps(), tl, NOW), tl, NOW);
    expect(Object.fromEntries(a)).toEqual({
      bob: { by: "tri", days_ago: 3 },
      carol: { by: "auth", days_ago: 7 },
      erin: { by: "dan", days_ago: 9 },
    });
  });

  it("keeps reviews that only left inline comments", () => {
    const e = prEvents(
      detail([]),
      ps({ reviews: [{ author: "rev", state: "COMMENTED", at: ago(2), body: "" }] }),
      [],
      NOW,
    );
    expect(e[0]).toMatchObject({ kind: "review", who: "rev", text: "(inline review comments, not shown)" });
  });

  it("finds the latest ping to someone by someone else", () => {
    const e = prEvents(
      detail([
        ["tri", 9, "@sam gentle ping"],
        ["sam", 5, "@sam-other hi"],
      ]),
      ps(),
      [],
      NOW,
    );
    expect(lastPing(e, "sam")).toBe(9);
    expect(lastPing(e, "zed")).toBeNull();
  });
});

describe("comments", () => {
  const cands = [
    { login: "a", reason: "you reviewed 5 recent PRs touching `pkg/x.go`", p: 0.5 },
    { login: "b-c", reason: "you are in OWNERS for `pkg/`", p: 0.3 },
  ];
  it("accepts the /cc ask and the re-pings", () => {
    for (const b of [
      askBody(cands),
      repingBody("x", "reviewing"),
      repingBody("x", "asked"),
      repingBody("x", "hold"),
    ])
      expect(isDraftedComment(b), b).toBe(true);
  });
  it.each([
    [
      "four people",
      askBody([...cands, { login: "d", reason: "r", p: 0 }, { login: "e", reason: "r", p: 0 }]),
    ],
    ["a reason that mentions someone", askBody([{ login: "a", reason: "ask @z instead", p: 1 }])],
    [
      "a reason line for someone not cc'd",
      "/cc @a\n@z: you reviewed\nWhoever has the bandwidth, please take a look; feel free to pass if you are swamped.",
    ],
    ["a re-ping with a free text", "@x please review"],
  ])("refuses %s", (_w, b) => expect(isDraftedComment(b)).toBe(false));
});

describe("OWNERS", () => {
  it("parses approvers, reviewers, emeritus and filter blocks", () => {
    const o = parseOwners(
      '# comment\napprovers:\n  - sig-node-approvers\n  - alice\nreviewers:\n- bob # inline\nemeritus_approvers:\n  - old\nfilters:\n  ".*":\n    reviewers:\n      - carol\nlabels:\n  - sig/node\n',
    );
    expect(o).toEqual({
      approvers: ["sig-node-approvers", "alice"],
      reviewers: ["bob", "carol"],
      emeritus: ["old"],
    });
  });
  it("parses OWNERS_ALIASES", () => {
    expect(parseAliases("aliases:\n  sig-node-approvers:\n    - a\n    - b\n  other:\n    - c\n")).toEqual({
      "sig-node-approvers": ["a", "b"],
      other: ["c"],
    });
  });
});

describe("blend", () => {
  const pr = (n: number, reviewers: string[], author = "someone") => ({
    number: n,
    title: `pr ${n}`,
    author,
    created: ago(n),
    reviewers,
  });
  it("ranks same-file reviewers first, drops the author, excluded people and emeritus, and names the evidence", () => {
    const out = blend(
      "auth",
      ["pkg/a.go"],
      ["pkg"],
      {
        byPath: { "pkg/a.go": [pr(1, ["filer", "auth"]), pr(2, ["filer"])], pkg: [pr(3, ["dirr", "gone"])] },
        byAuthor: [pr(4, ["pal"], "auth")],
      },
      [{ dir: "pkg", approvers: ["owner"], reviewers: [], emeritus: ["gone"] }],
      ["pal"],
      NOW,
    );
    expect(out.map((c) => c.login)).toEqual(["filer", "dirr"]);
    expect(out[0]!.best).toBe("you reviewed 2 recent PRs touching `pkg/a.go`");
  });
});
