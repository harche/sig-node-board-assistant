import { describe, expect, it } from "vitest";
import {
  decideDraNew,
  draNewActions,
  draNewSteps,
  releaseCycle,
  type DraNewResult,
} from "../src/core/dranew";
import type { BoardItem, JevChoice } from "../src/core/types";

const lane = (choice: string, p: number): JevChoice => ({
  type: "choice",
  choice,
  confidence: p,
  probabilities: { in_progress: 0, ready: 0, backlog: 0, [choice]: p },
});

const base = (over: Partial<DraNewResult> = {}): DraNewResult => ({
  kind: "dranew",
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
  lane: null,
  usage: { input_tokens: 0, cost: 0 },
  state_chars: 0,
  ...over,
});
const pr = (over: Partial<DraNewResult>) => base({ type: "PullRequest", ...over });

describe("decideDraNew", () => {
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
  ] as [string, DraNewResult, string, boolean][])("%s -> %s", (_w, r, action, auto) =>
    expect(decideDraNew(r)).toMatchObject({ action, auto }),
  );
});

describe("draNewActions and steps", () => {
  const item = { id: "PVTI", restId: 7, repository: "o/r", number: 1 } as BoardItem;
  it("offers PR columns for a PR and issue columns for an issue", () => {
    expect(draNewActions(pr({}))).toEqual(["in_review", "in_progress", "done", "keep"]);
    expect(draNewActions(base())).toEqual(["in_progress", "ready", "backlog", "done", "keep"]);
  });
  it("only moves the card", () => {
    expect(draNewSteps(item, "ready")).toEqual([
      { kind: "move", itemId: "PVTI", restId: 7, lane: "🔖 Ready" },
    ]);
    expect(draNewSteps(item, "keep")).toEqual([]);
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
