import { describe, expect, it } from "vitest";
import { isDraftedComment } from "../src/core/comments";
import type { JobSignal } from "../src/core/testgrid";
import {
  askThreadBody,
  closeDuplicates,
  closeFixedBody,
  decideTodo,
  duplicateBody,
  freshFixGuard,
  prowTypos,
  todoSteps,
  type TodoResult,
} from "../src/core/todo";
import type { BoardItem, ItemDetail } from "../src/core/types";

const detail = (...bodies: [string, string][]): ItemDetail => ({
  title: "t",
  body: "",
  labels: [],
  state: "open",
  author: { login: "a" },
  createdAt: "2026-09-01T00:00:00Z",
  url: "u",
  comments: bodies.map(([login, body]) => ({ author: { login }, body, createdAt: "2026-09-02T00:00:00Z" })),
});

describe("prowTypos", () => {
  it("finds commands Prow ignored, and what they meant", () => {
    const d = detail(
      ["maria", "seems green now!\ntriage/accept"],
      ["sam", "/priority imporant-soon"],
      ["kim", "/triage accept"],
    );
    expect(prowTypos(d)).toEqual([
      { who: "maria", wrote: "triage/accept", fix: "/triage accepted" },
      { who: "sam", wrote: "/priority imporant-soon", fix: "/priority important-soon" },
      { who: "kim", wrote: "/triage accept", fix: "/triage accepted" },
    ]);
  });

  it("ignores valid commands, prose and bots", () => {
    const d = detail(
      ["sam", "/triage accepted\n/priority backlog"],
      ["sam", "Triage: https://storage.googleapis.com/k8s-triage/index.html"],
      ["k8s-ci-robot", "/triage accept"],
    );
    expect(prowTypos(d)).toEqual([]);
  });
});

const job = (
  rows: Partial<JobSignal["whole_job"]> & { failures: number; runs: number },
  tracked = true,
): JobSignal => {
  const r = {
    test: "t",
    window_days: 14,
    last_failure_days_ago: null,
    runs_since_last_failure: rows.runs,
    last_run_days_ago: 0,
    ...rows,
  };
  return {
    job: "ci-node-e2e",
    testgrid: "d#t",
    named_in_title: false,
    tracked_tests: tracked ? [r as never] : "not found in this job's recent runs",
    whole_job: r as never,
  };
};

describe("freshFixGuard", () => {
  it("lets a test with no failures in the window, or no history at all, through", () => {
    expect(freshFixGuard([])).toBeNull();
    expect(freshFixGuard([job({ runs: 100, failures: 0 })])).toBeNull();
  });

  it("holds a close on the day of the fix", () => {
    const g = freshFixGuard([
      job({
        runs: 141,
        failures: 101,
        last_failure_days_ago: 0,
        runs_since_last_failure: 7,
        runs_after_fix: 7,
        failures_after_fix: 0,
      }),
    ]);
    expect(g).toContain("7/7 clean since the fix");
  });

  it("wants three times the usual gap between failures", () => {
    // 1 in 20: 60 clean runs needed.
    expect(
      freshFixGuard([job({ runs: 100, failures: 5, last_failure_days_ago: 5, runs_since_last_failure: 40 })]),
    ).toContain("60 clean runs");
    expect(
      freshFixGuard([job({ runs: 100, failures: 5, last_failure_days_ago: 5, runs_since_last_failure: 60 })]),
    ).toBeNull();
  });

  it("uses the whole job only when no test was found and the title names the job", () => {
    const flaky = { runs: 100, failures: 50, last_failure_days_ago: 0, runs_since_last_failure: 0 };
    expect(freshFixGuard([job(flaky, false)])).toBeNull();
    expect(freshFixGuard([{ ...job(flaky, false), named_in_title: true }])).not.toBeNull();
  });
});

const item: BoardItem = {
  id: "PVTI_1",
  restId: 7,
  status: "Issues - To do",
  type: "Issue",
  number: 12,
  url: "https://github.com/o/r/issues/12",
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

const result = (p: number, over: Partial<TodoResult> = {}): TodoResult => ({
  kind: "todo",
  item_id: item.id,
  repo: item.repository,
  number: item.number,
  title: "t",
  url: item.url,
  answers: {
    resolved: { type: "noul", noul: p },
    resolution: {
      type: "choice",
      choice: "fixed_by_change",
      confidence: 0.8,
      probabilities: { fixed_by_change: 0.8 },
    },
  },
  rules: { assignees: [], sig_node: true, triage_accepted: true, priority_label: "backlog", prow_typos: [] },
  duplicate: null,
  guard: null,
  ci: [],
  linked_prs: [
    {
      number: 99,
      repository: "o/r",
      title: "fix",
      author: "x",
      state: "merged",
      merged_days_ago: 4,
      description_start: "",
    },
  ],
  priority: null,
  priority_why: "",
  usage: { input_tokens: 0, cost: 0 },
  state_chars: 0,
  ...over,
});

const dup = { repository: "o/r", number: 5, title: "same", url: "u", status: "Issues - In progress", p: 0.9 };

describe("decideTodo", () => {
  it.each([
    [0.1, {}, "keep"],
    [0.5, {}, "ask_thread"],
    [0.8, {}, "close_fixed"],
    [0.8, { guard: "fixed today" }, "keep"],
    [
      0.1,
      {
        rules: {
          assignees: ["x"],
          sig_node: true,
          triage_accepted: true,
          priority_label: "backlog",
          prow_typos: [],
        },
      },
      "in_progress",
    ],
    [
      0.9,
      {
        rules: {
          assignees: [],
          sig_node: false,
          triage_accepted: true,
          priority_label: "backlog",
          prow_typos: [],
        },
      },
      "archive",
    ],
    [0.1, { duplicate: dup }, "close_duplicate"],
    [
      0.8,
      {
        guard: "fixed today",
        rules: {
          assignees: ["x"],
          sig_node: true,
          triage_accepted: true,
          priority_label: "backlog",
          prow_typos: [],
        },
      },
      "in_progress",
    ],
  ] as [number, Partial<TodoResult>, string][])("P %s %j -> %s", (p, over, want) => {
    expect(decideTodo(result(p, over)).action).toBe(want);
  });
});

describe("todoSteps and the comment allow-list", () => {
  it("closes as fixed with a comment naming the fix, then moves to Done", () => {
    const steps = todoSteps(item, result(0.8), "close_fixed");
    expect(steps).toEqual([
      {
        kind: "comment",
        repo: "o/r",
        number: 12,
        body: "This looks resolved: #99 merged 4 days ago. Closing; please reopen if it comes back.\n/close",
      },
      { kind: "move", itemId: "PVTI_1", restId: 7, lane: "Done" },
    ]);
  });

  it("closes a duplicate into Archive-it, never Done", () => {
    const steps = todoSteps(item, result(0.1, { duplicate: dup }), "close_duplicate");
    expect(steps.map((s) => (s.kind === "move" ? s.lane : s.body))).toEqual([
      "Closing as a duplicate of #5, which tracks the same failure. Tracking continues there.\n/close",
      "Archive-it",
    ]);
  });

  it("adds the missing labels to an action that keeps the card", () => {
    const r = result(0.1, {
      rules: { assignees: [], sig_node: true, triage_accepted: false, priority_label: null, prow_typos: [] },
      priority: "important-longterm",
    });
    expect(todoSteps(item, r, "keep")).toEqual([
      { kind: "comment", repo: "o/r", number: 12, body: "/triage accepted\n/priority important-longterm" },
    ]);
    expect(todoSteps(item, r, "in_progress", "backlog")[0]).toMatchObject({
      body: "/triage accepted\n/priority backlog",
    });
    expect(todoSteps(item, r, "archive")).toEqual([
      { kind: "move", itemId: "PVTI_1", restId: 7, lane: "Archive-it" },
    ]);
  });

  it("has nothing to write for a plain keep", () => {
    expect(todoSteps(item, result(0.1), "keep")).toEqual([]);
  });

  it("accepts every comment the actions draft", () => {
    const r = result(0.8, {
      ci: [job({ runs: 50, failures: 1, last_failure_days_ago: 9, runs_since_last_failure: 40 })],
    });
    for (const body of [
      closeFixedBody(r),
      duplicateBody(dup, "o/r"),
      askThreadBody(r),
      "/triage accepted",
      "/priority backlog",
    ])
      expect(isDraftedComment(body), body).toBe(true);
  });

  it.each([
    ["an arbitrary comment", "hello"],
    ["another Prow command", "/lgtm"],
    ["a close without the drafted text", "/close"],
    ["an ask that closes", "Checking in from the SIG Node CI board. Anything left?\n/close"],
    ["a close with extra commands", "This looks resolved. Closing.\n/close\n/lgtm"],
    ["an invalid priority", "/priority whenever"],
    ["a mention", "This looks resolved: @someone. Closing.\n/close"],
    ["an empty comment", "   "],
  ])("refuses %s", (_what, body) => {
    expect(isDraftedComment(body)).toBe(false);
  });
});

describe("closeDuplicates", () => {
  const card = (n: number, over: Partial<BoardItem> = {}): BoardItem => ({
    ...item,
    restId: n,
    number: n,
    id: `PVTI_${n}`,
    ...over,
  });
  const [a, b, c] = [card(1), card(2), card(3)];
  const all = new Set([1, 2, 3]);
  const closed = (m: Map<number, { number: number }>) =>
    Object.fromEntries([...m].map(([id, d]) => [id, d.number]));

  it("keeps one issue when Jev's pairwise picks go round in a circle", () => {
    // B over A, C over B, A over C: each pair alone would close a different card, all three together.
    const m = closeDuplicates(
      [
        { a, b, p: 0.9, survivor: "B" },
        { a: b, b: c, p: 0.8, survivor: "B" },
        { a: c, b: a, p: 0.7, survivor: "B" },
      ],
      all,
    );
    expect(m.size).toBe(2);
    const kept = [1, 2, 3].find((n) => !m.has(n))!;
    expect(Object.values(closed(m))).toEqual([kept, kept]);
  });

  it("points a chain at the one issue that stays", () => {
    // A into B, B into C: A must not close in favour of B, which is itself closing.
    const m = closeDuplicates(
      [
        { a, b, p: 0.9, survivor: "B" },
        { a: b, b: c, p: 0.9, survivor: "B" },
      ],
      all,
    );
    expect(closed(m)).toEqual({ 1: 3, 2: 3 });
  });

  it("always keeps an In-progress or assigned card, and never closes one", () => {
    const prog = card(4, { status: "Issues - In progress" });
    const mine = card(5, { assignees: ["x"] });
    expect(closed(closeDuplicates([{ a: prog, b: a, p: 0.9, survivor: "B" }], all))).toEqual({ 1: 4 });
    expect(closed(closeDuplicates([{ a, b: mine, p: 0.9, survivor: "A" }], new Set([1, 5])))).toEqual({
      1: 5,
    });
    expect(closeDuplicates([{ a: prog, b: mine, p: 0.9, survivor: "A" }], new Set([4, 5])).size).toBe(0);
  });

  it("ignores pairs below the threshold and cards that were not asked about", () => {
    expect(closeDuplicates([{ a, b, p: 0.6, survivor: "B" }], all).size).toBe(0);
    expect(closed(closeDuplicates([{ a, b, p: 0.9, survivor: "A" }], new Set([1])))).toEqual({});
  });
});
