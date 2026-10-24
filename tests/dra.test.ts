import { describe, expect, it } from "vitest";
import {
  decideDra,
  draActions,
  draIssueState,
  draLabel,
  draSteps,
  judgeDra,
  releaseCycle,
  type DraColumn,
  type DraResult,
} from "../src/core/dra";
import type { JevClient } from "../src/core/jev";
import type { BoardItem, ItemDetail, JevChoice, LinkedPr } from "../src/core/types";

const lane = (choice: string, p: number): JevChoice => ({
  type: "choice",
  choice,
  confidence: p,
  probabilities: { in_progress: 0, ready: 0, backlog: 0, [choice]: p },
});

const base = (over: Partial<DraResult> = {}, column: DraColumn = "new"): DraResult => ({
  kind: "dra",
  column,
  item_id: "I",
  repo: "o/r",
  number: 1,
  title: "t",
  url: "u",
  type: "Issue",
  state: "open",
  draft: false,
  assignees: [],
  linked_prs: [],
  development_cycle: "1.38",
  milestone: null,
  opted_in: false,
  kep: false,
  lane: null,
  usage: { input_tokens: 0, cost: 0 },
  state_chars: 0,
  ...over,
});
const pr = (over: Partial<DraResult>, column: DraColumn = "new") =>
  base({ type: "PullRequest", ...over }, column);
const backlog = (over: Partial<DraResult> = {}) => base(over, "backlog");

describe("decideDra: New", () => {
  it.each([
    ["a merged PR", pr({ state: "merged" }), "done", true],
    ["a closed PR", pr({ state: "closed" }), "done", true],
    ["a draft PR", pr({ draft: true }), "in_progress", true],
    ["an open PR", pr({}), "in_review", true],
    ["a closed issue", base({ state: "closed" }), "done", true],
    ["an issue Jev is sure is under way", base({ lane: lane("in_progress", 0.97) }), "in_progress", true],
    ["an issue Jev thinks is under way", base({ lane: lane("in_progress", 0.9) }), "in_progress", false],
    ["an issue Jev would put in Ready", base({ lane: lane("ready", 0.99) }), "ready", false],
    ["an issue Jev would put in Backlog", base({ lane: lane("backlog", 0.99) }), "backlog", false],
    ["an issue without an answer", base(), "keep", false],
  ] as [string, DraResult, string, boolean][])("%s -> %s", (_w, r, action, auto) =>
    expect(decideDra(r)).toMatchObject({ action, auto }),
  );
});

describe("decideDra: Backlog", () => {
  it.each([
    ["a closed issue", backlog({ state: "closed" }), "done", true],
    ["a merged PR", pr({ state: "merged" }, "backlog"), "done", true],
    ["an open PR", pr({}, "backlog"), "in_review", true],
    ["a KEP opted into 1.38", backlog({ milestone: "v1.38", opted_in: true }), "in_progress", true],
    [
      "a KEP opted into an earlier release",
      backlog({ milestone: "v1.36", opted_in: true, lane: lane("backlog", 0.9) }),
      "keep",
      true,
    ],
    [
      "a KEP in the milestone but not opted in",
      backlog({ milestone: "v1.38", lane: lane("backlog", 0.9) }),
      "keep",
      true,
    ],
    ["an issue Jev reads as ready", backlog({ lane: lane("ready", 0.9) }), "ready", false],
    ["an issue Jev reads as under way", backlog({ lane: lane("in_progress", 0.99) }), "in_progress", false],
    ["an issue Jev reads as later work", backlog({ lane: lane("backlog", 0.9) }), "keep", true],
    ["an issue without an answer", backlog(), "keep", false],
  ] as [string, DraResult, string, boolean][])("%s -> %s", (_w, r, action, auto) =>
    expect(decideDra(r)).toMatchObject({ action, auto }),
  );
});

const ready = (over: Partial<DraResult> = {}) => base(over, "ready");

describe("decideDra: Ready", () => {
  it.each([
    ["a closed issue", ready({ state: "closed" }), "done", true],
    ["a draft PR", pr({ draft: true }, "ready"), "in_progress", true],
    ["a KEP opted into 1.38", ready({ milestone: "v1.38", opted_in: true }), "in_progress", true],
    ["an issue Jev reads as under way", ready({ lane: lane("in_progress", 0.92) }), "in_progress", false],
    ["an issue Jev is less sure of", ready({ lane: lane("in_progress", 0.8) }), "keep", true],
    ["an issue nobody started", ready({ lane: lane("ready", 0.9) }), "keep", true],
    ["an issue without an answer", ready(), "keep", false],
  ] as [string, DraResult, string, boolean][])("%s -> %s", (_w, r, action, auto) =>
    expect(decideDra(r)).toMatchObject({ action, auto }),
  );
  it("offers Backlog rather than Ready", () =>
    expect(draActions(ready())).toEqual(["in_progress", "backlog", "done", "keep"]));
});

const progress = (over: Partial<DraResult> = {}) => base(over, "progress");

describe("decideDra: In progress", () => {
  it.each([
    ["a closed issue", progress({ state: "closed" }), "done", true],
    ["a merged PR", pr({ state: "merged" }, "progress"), "done", true],
    ["an open PR", pr({}, "progress"), "in_review", true],
    ["a draft PR", pr({ draft: true }, "progress"), "keep", true],
    ["a KEP opted into 1.38", progress({ kep: true, milestone: "v1.38", opted_in: true }), "keep", true],
    ["a KEP opted into 1.37", progress({ kep: true, milestone: "v1.37", opted_in: true }), "backlog", true],
    ["a KEP with no milestone", progress({ kep: true }), "backlog", true],
    ["an issue", progress(), "keep", true],
  ] as [string, DraResult, string, boolean][])("%s -> %s", (_w, r, action, auto) =>
    expect(decideDra(r)).toMatchObject({ action, auto }),
  );
  it("never offers the column the card is in", () => {
    expect(draActions(progress())).toEqual(["ready", "backlog", "done", "keep"]);
    expect(draActions(pr({}, "progress"))).toEqual(["in_review", "done", "keep"]);
  });
});

const review = (over: Partial<DraResult> = {}) => base(over, "review");

describe("decideDra: In review", () => {
  it.each([
    ["a merged PR", pr({ state: "merged" }, "review"), "done", true],
    ["a closed PR", pr({ state: "closed" }, "review"), "done", true],
    ["a draft PR", pr({ draft: true }, "review"), "in_progress", true],
    ["an open PR", pr({}, "review"), "keep", true],
    ["an open issue", review(), "in_progress", true],
    ["a closed issue", review({ state: "closed" }), "done", true],
  ] as [string, DraResult, string, boolean][])("%s -> %s", (_w, r, action, auto) =>
    expect(decideDra(r)).toMatchObject({ action, auto }),
  );
  it("offers Backlog for a PR, never In review", () =>
    expect(draActions(pr({}, "review"))).toEqual(["in_progress", "backlog", "done", "keep"]));
});

describe("draActions, labels and steps", () => {
  const item = { id: "PVTI", restId: 7, repository: "o/r", number: 1 } as BoardItem;
  it("offers PR columns for a PR and issue columns for an issue", () => {
    expect(draActions(pr({}))).toEqual(["in_review", "in_progress", "done", "keep"]);
    expect(draActions(base())).toEqual(["in_progress", "ready", "backlog", "done", "keep"]);
    expect(draActions(backlog())).toEqual(["in_progress", "ready", "done", "keep"]);
  });
  it("names the column a card stays in", () => {
    expect(draLabel("keep", "new")).toBe("Leave in New");
    expect(draLabel("keep", "backlog")).toBe("Leave in Backlog");
    expect(draLabel("in_progress", "new")).toBe("Move to In progress");
  });
  it("only moves the card", () => {
    expect(draSteps(item, "ready")).toEqual([{ kind: "move", itemId: "PVTI", restId: 7, lane: "🔖 Ready" }]);
    expect(draSteps(item, "keep")).toEqual([]);
  });
});

describe("releaseCycle", () => {
  it.each([
    ["2026-09-25", "1.37", "1.38"],
    ["2026-05-01", "1.36", "1.37"],
    ["2024-01-01", "1.29", "1.30"],
    // Past the table, one release every 17 weeks.
    ["2026-12-20", "1.38", "1.39"],
  ])("%s", (d, latest, development) => expect(releaseCycle(Date.parse(d))).toEqual({ latest, development }));
});

describe("draIssueState", () => {
  const NOW = Date.parse("2026-10-24T00:00:00Z"); // 1.38 in development
  const issue = {
    id: "PVTI",
    restId: 7,
    repository: "kubernetes/kubernetes",
    number: 1,
    assignees: [],
  } as unknown as BoardItem;
  const d = (milestone: string | null): ItemDetail => ({
    title: "DRA: device taints follow-up",
    body: "b",
    labels: [{ name: "wg/device-management" }, { name: "kind/feature" }],
    state: "OPEN",
    author: { login: "rep" },
    createdAt: "2026-09-01T00:00:00Z",
    url: "u",
    milestone,
    comments: [
      {
        author: { login: "maint" },
        createdAt: "2026-09-02T00:00:00Z",
        body: "/assign\n/priority important-soon",
      },
      { author: { login: "k8s-ci-robot" }, createdAt: "2026-09-02T00:00:00Z", body: "Thanks for your PR" },
      {
        author: { login: "maint" },
        createdAt: "2026-09-03T00:00:00Z",
        body: `I'll take it. ${"z".repeat(2000)}`,
      },
    ],
  });
  const prs: LinkedPr[] = Array.from({ length: 7 }, (_, k) => ({
    repository: "kubernetes/kubernetes",
    number: 100 + k,
    title: `part ${k}`,
    author: "a",
    state: "open",
    createdAt: "2026-09-10T00:00:00Z",
    mergedAt: null,
    body: `<!-- Thanks for sending a pull request! ${"t".repeat(1500)} -->\n#### What this PR does\npart ${k} of the follow-up`,
  }));

  it("sends every linked PR with its whole description, template comments stripped", () => {
    const st = draIssueState(issue, d(null), prs, NOW);
    expect(st.linked_prs.map((p) => p.pr)).toContain("kubernetes/kubernetes#106");
    expect(st.linked_prs).toHaveLength(7);
    expect(st.linked_prs[6]!.description).toBe("#### What this PR does\npart 6 of the follow-up");
  });

  it("sends human comments in full, without bots or command-only ones", () => {
    const st = draIssueState(issue, d(null), prs, NOW);
    expect(st.human_comments).toHaveLength(1);
    expect(st.human_comments[0]!.text).toHaveLength(2014);
  });

  it("sends the milestone, and whether it is the release in development", () => {
    expect(draIssueState(issue, d("v1.38"), prs, NOW)).toMatchObject({
      milestone: "v1.38",
      milestone_is_development_cycle: true,
      development_cycle: "1.38",
    });
    expect(draIssueState(issue, d("v1.39"), prs, NOW)).toMatchObject({
      milestone: "v1.39",
      milestone_is_development_cycle: false,
    });
  });

  it("keeps every linked PR on the result, the 7th included", async () => {
    const jev = {
      ask: async () => ({ answers: { lane: lane("ready", 0.8) }, usage: { input_tokens: 0, cost: 0 } }),
    } as unknown as JevClient;
    const open = {
      ...issue,
      type: "Issue",
      state: "OPEN",
      merged: false,
      draft: false,
      title: "t",
      url: "u",
    } as BoardItem;
    const r = await judgeDra(
      "new",
      open,
      jev,
      { detail: async () => d("v1.38"), linkedPrs: async () => prs },
      NOW,
    );
    expect(r.linked_prs.map((p) => p.number)).toEqual([100, 101, 102, 103, 104, 105, 106]);
    expect(r.milestone).toBe("v1.38");
  });
});
