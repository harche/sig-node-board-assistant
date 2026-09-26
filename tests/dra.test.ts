import { describe, expect, it } from "vitest";
import {
  decideDra,
  draActions,
  draLabel,
  draSteps,
  releaseCycle,
  type DraColumn,
  type DraResult,
} from "../src/core/dra";
import type { BoardItem, JevChoice } from "../src/core/types";

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
    ["a KEP opted into an earlier release", backlog({ milestone: "v1.36", opted_in: true }), "keep", true],
    ["a KEP in the milestone but not opted in", backlog({ milestone: "v1.38" }), "keep", true],
    ["an issue Jev reads as ready", backlog({ lane: lane("ready", 0.9) }), "ready", false],
    ["an issue Jev reads as under way", backlog({ lane: lane("in_progress", 0.99) }), "in_progress", false],
    ["an issue Jev reads as later work", backlog({ lane: lane("backlog", 0.9) }), "keep", true],
  ] as [string, DraResult, string, boolean][])("%s -> %s", (_w, r, action, auto) =>
    expect(decideDra(r)).toMatchObject({ action, auto }),
  );
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
