import { describe, expect, it } from "vitest";
import {
  backlogSteps,
  decideBacklog,
  selfAssigned,
  shortlist,
  type BacklogResult,
} from "../src/core/backlog";
import { bugLabels } from "../src/core/bugs";
import { isDraftedComment } from "../src/core/comments";
import type { AssigneeVerdict } from "../src/core/inprogress";
import type { BoardItem } from "../src/core/types";

const fixed = (p: number, how = "fixed_by_change") => ({
  resolved: { type: "noul" as const, noul: p },
  resolution: { type: "choice" as const, choice: how, confidence: 1, probabilities: { [how]: 1 } },
});
const who = (login: string, verdict: AssigneeVerdict["verdict"]): AssigneeVerdict => ({
  login,
  verdict,
  why: "quiet, and nobody has checked in yet",
  checkin_days_ago: null,
  last_activity_days_ago: 60,
  p_active: 0.1,
});

const base = (
  over: Partial<BacklogResult> = {},
  labels = ["triage/accepted", "priority/backlog"],
): BacklogResult => ({
  kind: "backlog",
  item_id: "I",
  repo: "o/r",
  number: 1,
  title: "t",
  url: "u",
  state: "open",
  status: "Triaged",
  labels: bugLabels(labels),
  assignees: [],
  answers: fixed(0.1, "still_open"),
  linked_prs: [],
  fixed_by: null,
  duplicate: null,
  progress: null,
  self_assigned: [],
  priority: "backlog",
  priority_why: "already labelled",
  usage: { input_tokens: 0, cost: 0 },
  state_chars: 0,
  ...over,
});
const item = { id: "PVTI", restId: 7, repository: "o/r", number: 1 } as BoardItem;
const quiet = (login: string, self: boolean): Partial<BacklogResult> => ({
  assignees: [login],
  progress: { assignees: [who(login, "nudge")], p_moving_on: 0, sig_node: true },
  self_assigned: self ? [login] : [],
});

describe("decideBacklog", () => {
  it.each([
    ["closed", base({ state: "closed" }), "done", true],
    ["no triage/accepted", base({}, ["priority/backlog"]), "to_triage", true],
    ["needs-information", base({}, ["triage/needs-information"]), "to_info", true],
    [
      "a duplicate",
      base({
        duplicate: { repository: "o/r", number: 9, title: "x", url: "u", status: "Triaged", p: 0.8 },
      }),
      "close_duplicate",
      true,
    ],
    ["surely fixed", base({ answers: fixed(0.9) }), "close_fixed", true],
    ["maybe fixed", base({ answers: fixed(0.6) }), "close_fixed", false],
    ["a quiet self-assigned contributor", base(quiet("dev", true)), "nudge", true],
    ["a quiet owner a triager assigned", base(quiet("owner", false)), "keep", true],
    [
      "high priority, nobody assigned: flagged, labels still fixed",
      base({ status: "High Priority" }),
      "keep",
      true,
    ],
    ["nothing to do", base(), "keep", true],
  ] as [string, BacklogResult, string, boolean][])("%s -> %s", (_w, r, action, auto) =>
    expect(decideBacklog(r)).toMatchObject({ action, auto }),
  );
});

describe("backlogSteps", () => {
  const out = (r: BacklogResult, a: Parameters<typeof backlogSteps>[2], prio?: string) =>
    backlogSteps(item, r, a, prio).map((s) => (s.kind === "comment" ? s.body : `-> ${s.lane}`));

  it("adds a missing priority, and moves the card to its priority's column", () => {
    expect(out(base({ priority: "important-longterm" }, ["triage/accepted"]), "keep")).toEqual([
      "/priority important-longterm",
    ]);
    expect(out(base({ priority: "important-soon" }, ["triage/accepted"]), "keep")).toEqual([
      "/priority important-soon",
      "-> High Priority",
    ]);
    expect(out(base(), "keep", "important-soon")).toEqual([
      "/remove-priority backlog\n/priority important-soon",
      "-> High Priority",
    ]);
    expect(out(base(), "keep")).toEqual([]);
  });

  it("nudges only the self-assigned, and keeps the column fixes", () => {
    const r = base({ ...quiet("dev", true), priority: "important-longterm" }, ["triage/accepted"]);
    const steps = out(r, "nudge");
    expect(steps[0]).toMatch(/^@dev are you still working on this\?/);
    expect(steps[1]).toBe("/priority important-longterm");
    expect(out(base(quiet("owner", false)), "nudge")).toEqual([]);
  });

  it("closes as fixed or as a duplicate with allowed comments", () => {
    const r = base({
      answers: fixed(0.9),
      linked_prs: [
        { number: 5, repository: "o/r", title: "fix", state: "merged", merged_days_ago: 30 },
        { number: 6, repository: "o/r", title: "add a test", state: "merged", merged_days_ago: 3 },
      ],
      fixed_by: { number: 5, repository: "o/r", merged_days_ago: 30 },
      duplicate: { repository: "o/r", number: 9, title: "x", url: "u", status: "Triaged", p: 0.8 },
    });
    const [fixedBody, move] = out(r, "close_fixed");
    // The PR Jev picked as the fix, not the most recent one.
    expect(fixedBody).toBe(
      "This looks resolved: #5 merged 30 days ago. Closing; please reopen if it comes back.\n/close",
    );
    const [unnamed] = out({ ...r, fixed_by: null }, "close_fixed");
    expect(unnamed).toMatch(/^This looks resolved: going by the discussion above\./);
    expect(move).toBe("-> Done");
    const [dup] = out(r, "close_duplicate");
    for (const b of [fixedBody!, dup!, "/remove-priority backlog\n/priority important-soon"])
      expect(isDraftedComment(b), b).toBe(true);
  });
});

describe("selfAssigned", () => {
  it("counts an assignment the person made, directly or through Prow on their own /assign", () => {
    const tl = [
      { event: "commented", created_at: "2026-01-01T00:00:00Z", actor: { login: "dev" }, body: "/assign" },
      {
        event: "assigned",
        created_at: "2026-01-01T00:00:05Z",
        actor: { login: "k8s-ci-robot" },
        assignee: { login: "dev" },
      },
      {
        event: "assigned",
        created_at: "2026-01-02T00:00:00Z",
        actor: { login: "me" },
        assignee: { login: "me" },
      },
      {
        event: "commented",
        created_at: "2026-01-03T00:00:00Z",
        actor: { login: "tri" },
        body: "/assign @owner",
      },
      {
        event: "assigned",
        created_at: "2026-01-03T00:00:05Z",
        actor: { login: "k8s-ci-robot" },
        assignee: { login: "owner" },
      },
    ];
    expect(selfAssigned(["dev", "me", "owner", "ghost"], tl)).toEqual(["dev", "me"]);
  });
});

describe("shortlist", () => {
  it("pairs each target with the cards sharing the most words, once per pair", () => {
    const c = (restId: number, title: string) => ({ restId, title });
    const pool = [
      c(1, "devicemanager stuck in Allocate RPC"),
      c(2, "kubelet stuck when device plugin Allocate RPC hangs"),
      c(3, "eviction manager ignores ephemeral storage"),
    ];
    const pairs = shortlist(pool, pool, (x) => x.title);
    expect(pairs.map(([a, b]) => [a.restId, b.restId])).toEqual([[1, 2]]);
    // The same pair from the other side comes out in the same order.
    expect(shortlist([pool[1]!], pool, (x) => x.title).map(([a, b]) => [a.restId, b.restId])).toEqual([
      [1, 2],
    ]);
  });
});
