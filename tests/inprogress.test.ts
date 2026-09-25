import { describe, expect, it } from "vitest";
import { isDraftedComment } from "../src/core/comments";
import {
  askThreadProgressBody,
  checkinCandidates,
  decideProgress,
  decideProgressCard,
  nudgeBody,
  progressSteps,
  unassignBody,
  type AssigneeVerdict,
  type ProgressResult,
} from "../src/core/inprogress";
import type { BoardItem, JevNoul } from "../src/core/types";

const LAST = "last_own_activity_days_ago (comment, commit, PR merge or assignment, whichever is latest)";
const noul = (p: number): JevNoul => ({ type: "noul", noul: p });

/** A state as progressState builds it: assignees with their last activity, and a thread. */
const state = (
  assignees: [string, number | null][],
  thread: [string, number, string[]][],
): Record<string, unknown> => ({
  assignees: assignees.map(([login, last]) => ({ login, [LAST]: last })),
  thread: thread.map(([author, days_ago, no_activity_since_by]) => ({
    author,
    days_ago,
    no_activity_since_by,
    text: "",
  })),
});

describe("decideProgress", () => {
  it("settles activity within 30 days by date, without asking Jev", () => {
    const st = state([["x", 13]], []);
    expect(decideProgress(st, { active_0: noul(0.1), moving_on: noul(0) })[0]!.verdict).toBe("active");
  });

  it("asks only about comments after the assignee's own last activity, and not their own", () => {
    const st = state(
      [["x", 40]],
      [
        ["a", 50, []],
        ["x", 40, []],
        ["b", 20, ["x"]],
      ],
    );
    expect(checkinCandidates(st)).toEqual([[2]]);
  });

  it("waits while a check-in Jev found is younger than 14 days, then unassigns", () => {
    const st = (d: number) => state([["x", 100]], [["owner", d, ["x"]]]);
    const a = { active_0: noul(0.1), checkin_0_0: noul(0.99), moving_on: noul(0) };
    expect(decideProgress(st(9), a)[0]).toMatchObject({ verdict: "wait", checkin_days_ago: 9 });
    expect(decideProgress(st(14), a)[0]).toMatchObject({ verdict: "unassign", checkin_days_ago: 14 });
  });

  it("nudges a quiet assignee nobody asked yet, or asks the thread when others carry the work", () => {
    const st = state([["x", 100]], [["someone", 5, ["x"]]]);
    const a = (moving: number) => ({ active_0: noul(0.2), checkin_0_0: noul(0.1), moving_on: noul(moving) });
    expect(decideProgress(st, a(0.3))[0]!.verdict).toBe("nudge");
    expect(decideProgress(st, a(0.8))[0]!.verdict).toBe("ask_thread");
  });

  it("never asks the thread while another assignee is active", () => {
    const st = state(
      [
        ["x", 100],
        ["y", 2],
      ],
      [],
    );
    const a = { active_0: noul(0.1), active_1: noul(0.9), moving_on: noul(0.9) };
    expect(decideProgress(st, a).map((v) => v.verdict)).toEqual(["nudge", "active"]);
  });
});

const item: BoardItem = {
  id: "PVTI_1",
  restId: 7,
  status: "Issues - In progress",
  type: "Issue",
  number: 12,
  url: "u",
  repository: "o/r",
  title: "t",
  state: "open",
  merged: false,
  draft: false,
  labels: [],
  assignees: [],
  updatedAt: "",
  closedAt: null,
};

const v = (login: string, verdict: AssigneeVerdict["verdict"]): AssigneeVerdict => ({
  login,
  verdict,
  why: "",
  checkin_days_ago: null,
  last_activity_days_ago: 60,
  p_active: 0.1,
});

const result = (assignees: AssigneeVerdict[], sig_node = true): ProgressResult => ({
  kind: "progress",
  item_id: item.id,
  repo: "o/r",
  number: 12,
  title: "t",
  url: "u",
  sig_node,
  assignees,
  p_moving_on: 0,
  usage: { input_tokens: 0, cost: 0 },
  state_chars: 0,
});

describe("decideProgressCard", () => {
  it.each([
    [result([], false), "archive"],
    [result([]), "back_to_todo"],
    [result([v("x", "active")]), "keep"],
    [result([v("x", "wait")]), "keep"],
    [result([v("x", "nudge"), v("y", "active")]), "nudge"],
    [result([v("x", "nudge"), v("y", "unassign")]), "unassign"],
    [result([v("x", "ask_thread")]), "ask_thread"],
  ] as [ProgressResult, string][])("%#: %s", (r, want) => {
    expect(decideProgressCard(r).action).toBe(want);
  });
});

describe("progressSteps", () => {
  const bodies = (s: ReturnType<typeof progressSteps>) =>
    s.map((x) => (x.kind === "move" ? `move ${x.lane}` : x.body));

  it("unassigns and moves the card back to To do when nobody active remains", () => {
    expect(bodies(progressSteps(item, result([v("x", "unassign")]), "unassign"))).toEqual([
      unassignBody("x"),
      "move Issues - To do",
    ]);
  });

  it("keeps the card in progress while anyone is left assigned, even a quiet one", () => {
    expect(bodies(progressSteps(item, result([v("x", "unassign"), v("y", "wait")]), "unassign"))).toEqual([
      unassignBody("x"),
    ]);
  });

  it("keeps the card in progress when an active assignee remains", () => {
    expect(bodies(progressSteps(item, result([v("x", "unassign"), v("y", "active")]), "unassign"))).toEqual([
      unassignBody("x"),
    ]);
  });

  it("nudges only the assignees whose verdict it is, or every quiet one when the reviewer picks it", () => {
    const r = result([v("x", "nudge"), v("y", "wait"), v("z", "active")]);
    expect(bodies(progressSteps(item, r, "nudge"))).toEqual([nudgeBody("x", 60)]);
    const u = result([v("x", "unassign"), v("y", "wait")]);
    expect(bodies(progressSteps(item, u, "nudge"))).toEqual([nudgeBody("x", 60), nudgeBody("y", 60)]);
  });
});

describe("isDraftedComment for In progress", () => {
  it("accepts the nudge, the unassign and the thread question, mentions included", () => {
    for (const b of [
      nudgeBody("some-one", 40),
      nudgeBody("x", null),
      unassignBody("x"),
      askThreadProgressBody(),
    ])
      expect(isDraftedComment(b), b).toBe(true);
  });

  it.each([
    ["an unassign with another command", `${unassignBody("x")}\n/close`],
    ["an unassign of two people", "/unassign @x @y\nUnassigning after no response to the check-in above."],
    ["an unassign without the reason", "/unassign @x"],
    ["a nudge with a command line", `${nudgeBody("x", 40)}\n/lgtm`],
    ["a free-form mention", "@x please fix this"],
    ["an empty comment", ""],
    ["a second mention in a nudge", `${nudgeBody("x", 40)} cc @y`],
    ["a mention in the thread question", `${askThreadProgressBody()} @y`],
    ["a mention in the unassign reason", `${unassignBody("x")} @y`],
  ])("refuses %s", (_what, body) => expect(isDraftedComment(body)).toBe(false));
});
