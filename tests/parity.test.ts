/** The extension against a frozen snapshot of the Python reference's outputs (tests/fixtures/parity.json).
 *  Same signals, questions, verdicts and commands, apart from the deliberate differences noted below. The Jev state
 *  is the port's own: the fixture's `state` and `state_chars` were regenerated from buildState when it began sending
 *  the whole evidence (docs/design.md, "Parity with the reference"). */
import { describe, expect, it } from "vitest";
import { decide, priority, prLane } from "../src/core/policy";
import { priorityQuestion, triageQuestions } from "../src/core/prompts/triage";
import { signals } from "../src/core/signals";
import { MAX_STATE_CHARS } from "../src/core/fit";
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
  // Deliberate difference: the reference sent the last 10 human comments at 1,000 characters each, the description
  // at 8,000 and 40 + 40 changed files, under a 40,000-character cap. The port sends every human comment in full but
  // those that are only Prow commands, the whole description, every file, and every human /sig or /area comment as
  // `human_routing`.
  it.each(items.map((e) => [`${e.item.repository}#${e.item.number}`, e] as const))("%s", (_name, e) => {
    const st = buildState(toItem(e.item), e.detail, e.kind);
    expect(st).toEqual(e.state);
    const routing = e.signals.human_slash_routing_comments.map((r) => ({ author: r.who, command: r.cmd }));
    expect(st.human_routing ?? []).toEqual(routing);
    expect(pyJsonLength(st)).toBe(e.state_chars);
  });
  const e = items.find((x) => x.kind === "PullRequest")!;
  it("keeps an early decisive comment in a long thread", () => {
    const comments = Array.from({ length: 40 }, (_, i) => ({
      author: { login: `h${i}` },
      body: i === 2 ? "This is a product bug in the kubelet, not a test problem." : `comment ${i}`,
      createdAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
    }));
    const st = buildState(toItem(e.item), { ...e.detail, comments }, e.kind);
    expect(st.human_comments).toHaveLength(40);
    expect(st.human_comments[2]).toEqual({
      author: "h2",
      text: "This is a product bug in the kubelet, not a test problem.",
    });
  });
  it("leaves out comments that are only Prow commands, but not their routing", () => {
    const comments = [
      { author: { login: "a" }, body: "/sig node\n/area test", createdAt: "2026-01-01T00:00:01Z" },
      { author: { login: "b" }, body: "/retest", createdAt: "2026-01-01T00:00:02Z" },
      {
        author: { login: "c" },
        body: "/lgtm\nThanks, the fix looks right.",
        createdAt: "2026-01-01T00:00:03Z",
      },
    ];
    const st = buildState(toItem(e.item), { ...e.detail, comments }, e.kind);
    expect(st.human_comments).toEqual([{ author: "c", text: "/lgtm\nThanks, the fix looks right." }]);
    expect(st.human_routing).toEqual([
      { author: "a", command: "/sig node" },
      { author: "a", command: "/area test" },
    ]);
  });
  it("sends a long comment, description and file list whole", () => {
    const long = "x".repeat(20_000);
    const files = Array.from({ length: 300 }, (_, i) => ({
      path: `pkg/f${i}.go`,
      additions: 1,
      deletions: 1,
    }));
    const st = buildState(
      toItem(e.item),
      { ...e.detail, body: long, files, comments: [{ author: { login: "h" }, body: long, createdAt: "" }] },
      "PullRequest",
    );
    expect(st.description).toBe(long);
    expect(st.human_comments).toEqual([{ author: "h", text: long }]);
    expect(st.changed_files!.other).toHaveLength(300);
  });
  it("over the guard, drops the oldest middle comments, then cuts the middle of the description, and terminates", () => {
    const huge: ItemDetail = {
      ...e.detail,
      body: "x".repeat(480_000),
      comments: Array.from({ length: 30 }, (_, i) => ({
        author: { login: `h${i}` },
        body: "é".repeat(20_000),
        createdAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
      })),
      files: Array.from({ length: 80 }, (_, i) => ({ path: `pkg/p${i}.go`, additions: 1, deletions: 1 })),
    };
    const st = buildState(toItem(e.item), huge, "PullRequest");
    expect(JSON.stringify(st).length).toBeLessThanOrEqual(MAX_STATE_CHARS);
    const who = st.human_comments.map((c) => c.author);
    expect(who[0]).toBe("h0");
    expect(who.at(-1)).toBe("h29");
    expect(st.human_comments[1]!.text).toMatch(/^\(\d+ comments left out here/);
    expect(st.description).toMatch(/^x+\n…\[\d+ characters cut\]…\nx+$/);
    expect(st.changed_files!.other).toHaveLength(80);
  });
});

describe("triageQuestions()", () => {
  const q = fixture.questions as Record<ItemKind, unknown>;
  // The CLI asks all four at once; here priority is a second call, made only when the item is not removed.
  const both = (k: ItemKind) => ({ ...triageQuestions(k), ...priorityQuestion(k) });
  // Deliberate differences, all in in_scope: the CLI lists "a human commented /sig node to route it to SIG Node" as
  // grounds for true, and its focus only says to judge the primary deliverable. On the CI/Test board the routing reads
  // SIG ownership as CI relevance, which a /sig node cannot speak to (every item there already carries the label), so
  // the line is gone and the focus says a /sig comment answers ownership, not CI scope. The ownership evidence itself
  // stays in the owner question's focus.
  it("issue questions match the YAML prompts, minus the in_scope focus and /sig node line", () =>
    expect(both("Issue")).toEqual(q.Issue));
  it("pull request questions match the YAML prompts, minus the in_scope focus and /sig node line", () =>
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
  it(`${cases.length} decision-grid cases match, except the 84 that a human /sig node routed`, () => {
    for (const c of cases) {
      // Deliberate difference: the reference lets any human /sig node turn a REMOVE into BORDERLINE; here it overrides
      // only the ownership half (policy.HAND_ROUTED_CI_AT), so a non-CI deliverable is still removed. The fixture's
      // verdicts and whys are this extension's, not the CLI's, for the 84 cases that write /sig node.
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
