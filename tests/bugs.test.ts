import { describe, expect, it } from "vitest";
import {
  bugLabels,
  bugSteps,
  decideBug,
  isBugComment,
  judgeBug,
  laneFor,
  type BugAnswers,
  type BugResult,
} from "../src/core/bugs";
import { isDraftedComment } from "../src/core/comments";
import type { JevClient } from "../src/core/jev";
import type { BoardItem, ItemDetail, JevChoice } from "../src/core/types";

const choice = (probabilities: Record<string, number>): JevChoice => {
  const [c, v] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]!;
  return { type: "choice", choice: c, confidence: v, probabilities };
};
const answers = (over: Partial<Record<"support" | "feature" | "other" | "info" | "dra", number>> = {}) =>
  ({
    report: choice({
      bug: 1 - (over.support ?? 0) - (over.feature ?? 0),
      support_question: over.support ?? 0,
      feature_request: over.feature ?? 0,
    }),
    owner: choice({ node: 1 - (over.other ?? 0), other: over.other ?? 0 }),
    dra: { type: "noul", noul: over.dra ?? 0 },
    enough_information: { type: "noul", noul: over.info ?? 0.9 },
  }) as BugAnswers;

const base = (over: Partial<BugResult> = {}, labels: string[] = ["kind/bug", "sig/node"]): BugResult => ({
  kind: "bugs",
  item_id: "I",
  repo: "o/r",
  number: 1,
  title: "t",
  url: "u",
  state: "open",
  labels: bugLabels(labels),
  routed_by: [],
  answers: answers(),
  priority: "important-longterm",
  priority_why: "",
  sig: "storage",
  missing: [],
  usage: { input_tokens: 0, cost: 0 },
  state_chars: 0,
  ...over,
});
const item = { id: "PVTI", restId: 7, repository: "o/r", number: 1 } as BoardItem;

describe("decideBug", () => {
  it.each([
    ["closed", base({ state: "closed" }), "done", true],
    ["already accepted", base({ answers: null }, ["triage/accepted"]), "accept", true],
    ["already needs-information", base({ answers: null }, ["triage/needs-information"]), "needs_info", true],
    [
      "accepted and needs-information: accepted wins",
      base({ answers: null }, ["triage/accepted", "triage/needs-information"]),
      "accept",
      true,
    ],
    ["a sure support request", base({ answers: answers({ support: 0.8 }) }), "support", true],
    ["a likely support request", base({ answers: answers({ support: 0.6 }) }), "support", false],
    ["a feature", base({ answers: answers({ feature: 0.7 }) }), "feature", false],
    ["another SIG", base({ answers: answers({ other: 0.8 }) }), "other_sig", false],
    [
      "another SIG, but which one Jev reads as SIG Node",
      base({ answers: answers({ other: 0.8 }), sig: null }),
      "accept",
      true,
    ],
    [
      "another SIG, but a human routed it with /sig node",
      base({ answers: answers({ other: 0.8 }), routed_by: ["tri"] }),
      "accept",
      false,
    ],
    ["hardly any information", base({ answers: answers({ info: 0.2 }) }), "needs_info", true],
    ["thin information", base({ answers: answers({ info: 0.4 }) }), "needs_info", false],
    ["a SIG Node bug", base(), "accept", true],
  ] as [string, BugResult, string, boolean][])("%s -> %s", (_w, r, action, auto) =>
    expect(decideBug(r)).toMatchObject({ action, auto }),
  );
});

describe("bugSteps", () => {
  const comments = (r: BugResult, a: Parameters<typeof bugSteps>[2], prio?: string) =>
    bugSteps(item, r, a, prio).map((s) => (s.kind === "comment" ? s.body : `-> ${s.lane}`));

  it("accepts into Triaged or High Priority by priority, replacing a different one", () => {
    expect(comments(base(), "accept")).toEqual([
      "/triage accepted\n/priority important-longterm",
      "-> Triaged",
    ]);
    expect(comments(base({}, ["priority/backlog"]), "accept", "important-soon")).toEqual([
      "/triage accepted\n/remove-priority backlog\n/priority important-soon",
      "-> High Priority",
    ]);
    expect(laneFor("critical-urgent")).toBe("High Priority");
  });

  it("only moves a card whose labels are already set", () => {
    const r = base({ priority: "backlog" }, ["triage/accepted", "priority/backlog"]);
    expect(comments(r, "accept")).toEqual(["-> Triaged"]);
    expect(comments(base({}, ["triage/needs-information"]), "needs_info")).toEqual(["-> Needs Information"]);
  });

  it("adds /wg device-management to a DRA report", () => {
    expect(comments(base({ answers: answers({ dra: 0.9 }) }), "accept")[0]).toBe(
      "/triage accepted\n/priority important-longterm\n/wg device-management",
    );
  });

  it("asks for the missing facts", () => {
    const [body, move] = comments(base({ missing: ["version", "logs"] }), "needs_info");
    expect(body).toMatch(
      /^Thanks for the report\..*\n- the Kubernetes version.*\n- the kubelet.*\n\n\/triage needs-information$/,
    );
    expect(move).toBe("-> Needs Information");
  });

  it("closes support requests, relabels features and hands over to another SIG, all leaving to Done", () => {
    const [support] = comments(base(), "support");
    expect(support).toMatch(/\n\n\/kind support\n\/remove-kind bug\n\/close$/);
    expect(comments(base(), "feature")).toEqual(["/kind feature\n/remove-kind bug", "-> Done"]);
    const [other, move] = comments(base(), "other_sig");
    expect(other).toMatch(/SIG storage owns.*\n\n\/remove-sig node\n\/sig storage$/);
    expect(move).toBe("-> Done");
  });
});

describe("comments", () => {
  it("lets every drafted body through", () => {
    const rs = [base(), base({ missing: ["reproduction"], answers: answers({ dra: 0.9 }) })];
    for (const r of rs)
      for (const a of ["accept", "needs_info", "support", "feature", "other_sig"] as const)
        for (const st of bugSteps(item, r, a))
          if (st.kind === "comment") expect(isDraftedComment(st.body), st.body).toBe(true);
  });

  it.each([
    [
      "a made-up fact",
      "Thanks for the report. To look into this, SIG Node needs a few more details:\n- your kubeconfig\n\n/triage needs-information",
    ],
    [
      "support without /close",
      "Thanks for the report. This reads as a support question" + "\n\n/kind support",
    ],
    [
      "a SIG that does not exist",
      "This looks like code SIG node owns, so handing it over. Add /sig node back if SIG Node is needed.\n\n/sig node",
    ],
    ["an extra command", "/kind feature\n/remove-kind bug\n/close"],
    ["an /lgtm", "/triage accepted\n/priority backlog\n/lgtm"],
  ])("refuses %s", (_w, body) => {
    expect(isBugComment(body)).toBe(false);
    expect(isDraftedComment(body)).toBe(false);
  });
});

describe("judgeBug", () => {
  const detail = (labels: string[]): ItemDetail => ({
    title: "t",
    body: "b",
    labels: labels.map((name) => ({ name })),
    state: "OPEN",
    author: { login: "rep" },
    createdAt: "2026-09-01T00:00:00Z",
    url: "u",
    comments: [],
  });
  /** Answers every question; the priority score is `score`. */
  const jev = (score: Record<string, number>) => {
    const asked: string[] = [];
    const client = {
      ask: async (_s: unknown, q: Record<string, unknown>) => {
        asked.push(...Object.keys(q));
        const answers: Record<string, unknown> = {
          ...answers_(),
          sig: choice({ storage: 1 }),
          priority: { type: "score", score: 0, confidence: 0, probabilities: score },
        };
        return { answers, usage: { input_tokens: 0, cost: 0 } };
      },
    };
    return { client: client as unknown as JevClient, asked };
  };
  const answers_ = () => answers();

  it("asks the priority for a card already labelled needs-information, so Accept can set one", async () => {
    const j = jev({ "2": 0.8 });
    const r = await judgeBug(item, detail(["triage/needs-information"]), j.client);
    expect(j.asked).toEqual(["priority"]);
    expect(r.priority).toBe("important-soon");
    expect(bugSteps(item, r, "accept").map((s) => s.kind)).toEqual(["comment", "move"]);
  });

  it("falls back to important-longterm when the score has no levels", async () => {
    const r = await judgeBug(item, detail([]), jev({}).client);
    expect(r).toMatchObject({ priority: "important-longterm", priority_why: "default; Jev gave no level" });
  });
});

describe("readings", () => {
  it("records every Jev answer, priority levels named", async () => {
    const client = {
      ask: async (_s: unknown, q: Record<string, unknown>) => ({
        answers: {
          ...answers({ info: 0.2 }),
          sig: choice({ storage: 0.7, network: 0.3 }),
          priority: { type: "score", score: 1, confidence: 1, probabilities: { "0": 0.1, "1": 0.9 } },
          ...Object.fromEntries(
            Object.keys(q)
              .filter((k) => k.startsWith("missing_"))
              .map((k) => [k, { type: "noul", noul: 0.8 }]),
          ),
        },
        usage: { input_tokens: 0, cost: 0 },
      }),
    } as unknown as JevClient;
    const d = {
      title: "t",
      body: "b",
      labels: [],
      state: "OPEN",
      author: { login: "r" },
      createdAt: "",
      url: "u",
      comments: [],
    } as ItemDetail;
    const r = await judgeBug(item, d, client);
    const labels = (r.readings ?? []).map((x) => x.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        "Kind of report",
        "Owner",
        "Which SIG owns the code",
        "Enough information",
        "About DRA",
        "Priority",
      ]),
    );
    expect(labels.filter((l) => l.startsWith("Needs "))).toHaveLength(4);
    const prio = r.readings!.find((x) => x.label === "Priority");
    expect(prio).toEqual({
      label: "Priority",
      probabilities: { "critical-urgent": 0, "important-soon": 0, "important-longterm": 0.9, backlog: 0.1 },
    });
  });
});
