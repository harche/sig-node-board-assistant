import { describe, expect, it } from "vitest";
import { bugLabels, type BugAnswers } from "../src/core/bugs";
import { isDraftedComment } from "../src/core/comments";
import {
  askedAt,
  decideInfo,
  infoState,
  infoSteps,
  judgeInfo,
  nudgeInfoBody,
  reminderCandidates,
  type InfoResult,
} from "../src/core/needsinfo";
import type { JevClient } from "../src/core/jev";
import type { BoardItem, ItemDetail, JevChoice } from "../src/core/types";

const NOW = Date.parse("2026-09-25T00:00:00Z");
const ago = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const choice = (probabilities: Record<string, number>): JevChoice => ({
  type: "choice",
  choice: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0],
  confidence: 1,
  probabilities,
});
const answers = (enough: number): BugAnswers => ({
  report: choice({ bug: 1 }),
  owner: choice({ node: 1 }),
  dra: { type: "noul", noul: 0 },
  enough_information: { type: "noul", noul: enough },
});

const base = (over: Partial<InfoResult> = {}, labels = ["triage/needs-information"]): InfoResult => ({
  kind: "info",
  item_id: "I",
  repo: "o/r",
  number: 1,
  title: "t",
  url: "u",
  state: "open",
  reporter: "rep",
  labels: bugLabels(labels),
  asked_days_ago: 30,
  reporter_replied_days_ago: null,
  reminded_days_ago: null,
  p_answered: 0.1,
  answers: null,
  priority: "important-longterm",
  priority_why: "",
  usage: { input_tokens: 0, cost: 0 },
  state_chars: 0,
  ...over,
});
const item = { id: "PVTI", restId: 7, repository: "o/r", number: 1 } as BoardItem;

describe("decideInfo", () => {
  it.each([
    ["closed", base({ state: "closed" }), "done", true],
    ["already accepted", base({}, ["triage/accepted", "priority/backlog"]), "accept", true],
    ["no information label any more", base({}, []), "to_triage", true],
    ["answered, enough to start", base({ p_answered: 0.9, answers: answers(0.8) }), "accept", true],
    ["answered, still thin", base({ p_answered: 0.9, answers: answers(0.3) }), "keep", false],
    ["unsure whether answered", base({ p_answered: 0.5 }), "keep", false],
    ["asked 10 days ago", base({ asked_days_ago: 10 }), "keep", true],
    ["asked 30 days ago, nobody reminded", base(), "nudge", true],
    ["reminded 5 days ago", base({ reminded_days_ago: 5 }), "keep", true],
    ["reminded 60 days ago: the lifecycle bot's", base({ reminded_days_ago: 60 }), "keep", true],
  ] as [string, InfoResult, string, boolean][])("%s -> %s", (_w, r, action, auto) =>
    expect(decideInfo(r)).toMatchObject({ action, auto }),
  );
});

describe("infoSteps", () => {
  const out = (r: InfoResult, a: Parameters<typeof infoSteps>[2]) =>
    infoSteps(item, r, a).map((s) => (s.kind === "comment" ? s.body : `-> ${s.lane}`));

  it("accepts an answered card: the information label off, accepted and a priority on", () => {
    expect(
      out(base({ p_answered: 0.9, answers: answers(0.8), priority: "important-soon" }), "accept"),
    ).toEqual([
      "/remove-triage needs-information\n/triage accepted\n/priority important-soon",
      "-> High Priority",
    ]);
  });

  it("reminds the reporter, and never closes", () => {
    expect(out(base(), "nudge")).toEqual([nudgeInfoBody("rep")]);
    expect(nudgeInfoBody("rep")).not.toMatch(/close/);
  });

  it("only moves a card whose labels already decided", () => {
    expect(out(base({ priority: "backlog" }, ["triage/accepted", "priority/backlog"]), "accept")).toEqual([
      "-> Triaged",
    ]);
    expect(out(base({}, []), "to_triage")).toEqual(["-> Triage"]);
  });

  it("accepts a card with both triage/accepted and needs-information: the label off, only what is missing on", () => {
    const both = base({ priority: "backlog" }, ["triage/accepted", "triage/needs-information"]);
    const [body, move] = out(both, "accept");
    expect(body).toBe("/remove-triage needs-information\n/priority backlog");
    expect(move).toBe("-> Triaged");
    expect(isDraftedComment(body!)).toBe(true);
    const set = base({ priority: "backlog" }, [
      "triage/accepted",
      "triage/needs-information",
      "priority/backlog",
    ]);
    expect(out(set, "accept")[0]).toBe("/remove-triage needs-information");
    expect(isDraftedComment("/remove-triage needs-information")).toBe(true);
  });

  it("drafts only allowed comments", () => {
    for (const a of ["accept", "nudge"] as const)
      for (const st of infoSteps(item, base({ p_answered: 0.9, answers: answers(0.8) }), a))
        if (st.kind === "comment") expect(isDraftedComment(st.body), st.body).toBe(true);
    for (const bad of [
      "@rep could you share the details asked for above?",
      "/remove-triage needs-information\n/close",
      "/remove-triage needs-information\n/lgtm",
      `${nudgeInfoBody("rep")}\n/close`,
    ])
      expect(isDraftedComment(bad), bad).toBe(false);
  });
});

describe("facts", () => {
  it("dates the ask from the last information label", () => {
    expect(
      askedAt([
        { event: "labeled", created_at: ago(40), label: { name: "triage/needs-information" } },
        { event: "labeled", created_at: ago(10), label: { name: "kind/bug" } },
        { event: "labeled", created_at: ago(20), label: { name: "triage/not-reproducible" } },
      ]),
    ).toBe(ago(20));
    expect(askedAt([])).toBeNull();
  });

  const detail = (comments: [string, number, string][]): ItemDetail => ({
    title: "t",
    body: "b",
    labels: [],
    state: "OPEN",
    author: { login: "rep" },
    createdAt: ago(90),
    url: "u",
    comments: comments.map(([login, d, body]) => ({ author: { login }, createdAt: ago(d), body })),
  });

  it("takes the question before a bare command as the request, and the replies after it", () => {
    const st = infoState(
      detail([
        ["maint", 31, "which container runtime and version do you use on these nodes?"],
        ["maint2", 30, "/triage needs-information"],
        ["other", 20, "containerd 2.1.6 here, same problem"],
      ]),
      ago(30),
      NOW,
    );
    expect(st.request.map((c) => c.author)).toEqual(["maint", "maint2"]);
    expect(st.replies.map((c) => c.author)).toEqual(["other"]);
  });

  it("looks for reminders only after the reporter's last reply", () => {
    const st = infoState(
      detail([
        ["maint", 30, "/triage needs-information\nplease share the kubelet logs from the node"],
        ["maint", 25, "@rep any update?"],
        ["rep", 20, "will check"],
        ["maint", 5, "@rep ping"],
      ]),
      ago(30),
      NOW,
    );
    expect(st.request).toHaveLength(1);
    expect(reminderCandidates(st.replies).map((c) => c.days_ago)).toEqual([5]);
  });
});

describe("judgeInfo", () => {
  it("asks the priority even when the request looks unanswered, so a hand-picked Accept has one", async () => {
    const jev = {
      askCached: async (_s: unknown, q: Record<string, unknown>) => ({
        answers:
          "priority" in q
            ? { priority: { type: "score", score: 1, confidence: 1, probabilities: { "1": 1 } } }
            : { answered: { type: "noul", noul: 0.5 } },
        usage: { input_tokens: 0, cost: 0, cached: true },
      }),
    } as unknown as JevClient;
    const d = {
      title: "t",
      body: "b",
      labels: [{ name: "triage/needs-information" }],
      state: "OPEN",
      author: { login: "rep" },
      createdAt: ago(60),
      url: "u",
      comments: [],
    } as ItemDetail;
    const tl = [{ event: "labeled", created_at: ago(30), label: { name: "triage/needs-information" } }];
    const r = await judgeInfo(item, d, tl, jev, false, NOW);
    expect(decideInfo(r).action).toBe("keep");
    expect(r.priority).toBe("important-longterm");
    expect(infoSteps(item, r, "accept").map((s) => s.kind)).toEqual(["comment", "move"]);
  });
});
