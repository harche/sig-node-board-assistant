/** The extension against a frozen snapshot of the Python reference's outputs (tests/fixtures/parity.json).
 *  Same signals, same Jev state, same questions, same verdicts, same commands. */
import { describe, expect, it } from "vitest";
import { decide, priority, prLane } from "../src/core/policy";
import { priorityQuestion, triageQuestions } from "../src/core/prompts/triage";
import { signals } from "../src/core/signals";
import { buildState, pyJsonLength } from "../src/core/state";
import { moveCommand, prowCommand } from "../src/core/triage";
import type { BoardFields, BoardItem, ItemDetail, ItemKind, Signals, TriageAnswers } from "../src/core/types";
import fixture from "./fixtures/parity.json";

interface PyItem {
  id: string;
  rest_id: number;
  status: string;
  type: ItemKind;
  number: number;
  url: string;
  repository: string;
  title: string;
  state: string;
  merged: boolean;
  draft: boolean;
  labels: string[];
  assignees: string[];
  updated_at: string;
  closed_at: string | null;
}

const toItem = (it: PyItem): BoardItem => ({
  id: it.id,
  restId: it.rest_id,
  status: it.status,
  type: it.type,
  number: it.number,
  url: it.url,
  repository: it.repository,
  title: it.title,
  state: it.state,
  merged: it.merged,
  draft: it.draft,
  labels: it.labels,
  assignees: it.assignees,
  updatedAt: it.updated_at,
  closedAt: it.closed_at,
});

const items = fixture.items as unknown as {
  item: PyItem;
  detail: ItemDetail;
  kind: ItemKind;
  signals: Signals;
  state: unknown;
  state_chars: number;
}[];

describe("signals()", () => {
  it.each(items.map((e) => [`${e.item.repository}#${e.item.number}`, e] as const))("%s", (_name, e) => {
    expect(signals(e.detail, e.kind)).toEqual(e.signals);
  });
});

describe("buildState()", () => {
  it.each(items.map((e) => [`${e.item.repository}#${e.item.number}`, e] as const))("%s", (_name, e) => {
    const st = buildState(toItem(e.item), e.detail, e.kind);
    // The port adds every human /sig or /area comment as `human_routing` (the Python reference only sent the last
    // 10 comments, so early routing was invisible to the owner question); everything else must match.
    const { human_routing, ...rest } = st;
    expect(rest).toEqual(e.state);
    const routing = e.signals.human_slash_routing_comments.map((r) => ({ author: r.who, command: r.cmd }));
    expect(human_routing ?? []).toEqual(routing);
    expect(pyJsonLength(rest)).toBe(e.state_chars);
  });
  it("terminates when the description alone cannot bring the state under the limit", () => {
    const e = items.find((x) => x.kind === "PullRequest")!;
    const huge: ItemDetail = {
      ...e.detail,
      body: "x".repeat(50_000),
      comments: Array.from({ length: 3 }, (_, i) => ({
        author: { login: `h${i}` },
        body: "é".repeat(1000),
        createdAt: "",
      })),
      files: Array.from({ length: 80 }, (_, i) => ({
        path: `pkg/${"p".repeat(600)}${i}.go`,
        additions: 1,
        deletions: 1,
      })),
    };
    const st = buildState(toItem(e.item), huge, "PullRequest");
    expect(st.description).toBe("(truncated)");
  });
});

describe("triageQuestions()", () => {
  const q = fixture.questions as Record<ItemKind, unknown>;
  // The CLI asks all four at once; here priority is a second call, made only when the item is not removed.
  const both = (k: ItemKind) => ({ ...triageQuestions(k), ...priorityQuestion(k) });
  it("issue questions match the YAML prompts", () => expect(both("Issue")).toEqual(q.Issue));
  it("pull request questions match the YAML prompts", () =>
    expect(both("PullRequest")).toEqual(q.PullRequest));
  it("question order is stable", () =>
    expect(Object.keys(triageQuestions("Issue"))).toEqual(["bucket", "in_scope", "owner"]));
});

describe("decide() and priority()", () => {
  const cases = fixture.decisions as {
    answers: TriageAnswers;
    signals: Signals;
    verdict: string;
    why: string;
    priority: string;
    priority_why: string;
  }[];
  it(`agrees with the reference on ${cases.length} decision-grid cases`, () => {
    for (const c of cases) {
      expect(decide(c.answers, c.signals)).toEqual({ verdict: c.verdict, why: c.why });
      // Deliberate difference: the CLI always proposes important-longterm; this takes Jev's most likely level.
      // A priority label already set still wins, as in the CLI.
      if (c.signals.priority_label_already)
        expect(priority(c.answers, c.signals)).toEqual({ priority: c.priority, why: c.priority_why });
      else expect(c.priority_why).toContain(`Jev leans ${priority(c.answers, c.signals).priority} `);
    }
  });
});

describe("prLane()", () => {
  const cases = fixture.lanes as { signals: Signals; lane: string }[];
  it(`agrees with the reference on ${cases.length} lane cases`, () => {
    for (const c of cases) expect(prLane(c.signals)).toBe(c.lane);
  });
});

describe("proposed commands", () => {
  const fields = fixture.fields as BoardFields;
  const cases = fixture.commands as {
    item: PyItem;
    kind: ItemKind;
    priority: string;
    lane: string;
    prow: string;
    move: string;
    archive: string;
  }[];
  it.each(cases.map((c) => [`${c.item.repository}#${c.item.number}`, c] as const))("%s", (_n, c) => {
    expect(prowCommand(c.kind, c.item.repository, c.item.number, c.priority)).toBe(c.prow);
    expect(moveCommand(c.item.id, c.lane, fields)).toBe(c.move);
    expect(moveCommand(c.item.id, "Archive-it", fields)).toBe(c.archive);
  });
});
