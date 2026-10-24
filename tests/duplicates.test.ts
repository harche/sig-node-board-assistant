import { describe, expect, it } from "vitest";
import {
  dupIssue,
  duplicatePass,
  dupState,
  MAX_CANDIDATES,
  nearest,
  type DupIssue,
} from "../src/core/duplicates";
import { MAX_STATE_CHARS } from "../src/core/fit";
import type { JevClient } from "../src/core/jev";
import { bugDuplicateQuestions } from "../src/core/prompts/backlog";
import { duplicateQuestions } from "../src/core/prompts/todo";
import type { BoardItem, ItemDetail } from "../src/core/types";

const NOW = Date.parse("2026-10-24T00:00:00Z");

const card = (n: number, title: string, over: Partial<BoardItem> = {}): BoardItem =>
  ({
    id: `PVTI_${n}`,
    restId: n,
    status: "Issues - To do",
    type: "Issue",
    number: n,
    url: `https://github.com/o/r/issues/${n}`,
    repository: "o/r",
    title,
    state: "open",
    merged: false,
    draft: false,
    labels: [],
    assignees: [],
    ...over,
  }) as BoardItem;

const issueOf = (i: BoardItem, body = i.title): DupIssue =>
  dupIssue(
    i,
    {
      title: i.title,
      body,
      labels: [],
      state: "OPEN",
      author: { login: "rep" },
      createdAt: "2026-09-01T00:00:00Z",
      url: i.url,
      comments: [],
    },
    [],
    NOW,
  );

/** Answers each target's call from `dup`: target number -> candidate number -> [P, keep the target?]. */
const fakeJev = (dup: Record<number, Record<number, [number, boolean]>>) => {
  const calls: { target: number; candidates: number[]; questions: string[] }[] = [];
  const client = {
    ask: async (s: unknown, q: Record<string, unknown>) => {
      const st = s as { issue: DupIssue; candidates: Record<string, DupIssue> };
      const cands = Object.values(st.candidates).map((c) => c.number);
      calls.push({ target: st.issue.number, candidates: cands, questions: Object.keys(q) });
      const answers: Record<string, unknown> = {};
      cands.forEach((c, k) => {
        const [p, keepTarget] = dup[st.issue.number]?.[c] ?? [0.05, true];
        answers[`duplicate_${k}`] = { type: "noul", noul: p };
        answers[`survivor_${k}`] = {
          type: "choice",
          choice: keepTarget ? "issue" : "candidate",
          confidence: 1,
          probabilities: {},
        };
      });
      return { answers, usage: { input_tokens: 0, cost: 0 } };
    },
  };
  return { client: client as unknown as JevClient, calls };
};

describe("duplicatePass", () => {
  const a = card(1, "kubelet panics on volume removal");
  const b = card(2, "kubelet panic when a volume is removed during restart");
  const c = card(3, "eviction ignores ephemeral storage");
  const prog = card(4, "volume removal panic, fix in flight", { status: "Issues - In progress" });
  const read = async (i: BoardItem) => issueOf(i);

  it("makes one call per open target, over every other card at once", async () => {
    const closed = card(5, "closed one", { state: "closed" });
    const j = fakeJev({});
    const out = await duplicatePass(j.client, [a, b, c, closed], [a, b, c, prog], read, duplicateQuestions);
    expect(j.calls.map((x) => x.target).sort()).toEqual([1, 2, 3]);
    for (const x of j.calls) {
      expect(x.candidates.sort()).toEqual([1, 2, 3, 4].filter((n) => n !== x.target));
      expect(x.questions).toHaveLength(2 * 3);
    }
    expect(out).toEqual({ 1: null, 2: null, 3: null, 5: null });
  });

  it("groups the answers and keeps one card: In progress first, else the one both sides picked", async () => {
    // 1 and 2 are the same bug, each read from both sides: both keep 2. 3 is nobody's duplicate.
    const j = fakeJev({ 1: { 2: [0.9, false] }, 2: { 1: [0.8, true] } });
    const out = await duplicatePass(j.client, [a, b, c], [a, b, c], read, duplicateQuestions);
    expect(out[1]).toMatchObject({ number: 2, p: 0.9 });
    expect(out[2]).toBeNull();
    expect(out[3]).toBeNull();
    // With an In-progress card in the group, it stays and both To-do cards close in its favour.
    const k = fakeJev({ 1: { 2: [0.9, false], 4: [0.7, true] }, 2: { 1: [0.8, true] } });
    const out2 = await duplicatePass(k.client, [a, b, c], [a, b, c, prog], read, duplicateQuestions);
    expect(out2[1]).toMatchObject({ number: 4 });
    expect(out2[2]).toMatchObject({ number: 4 });
  });

  it("reads a duplicate without a survivor answer as no duplicate, rather than close the target", async () => {
    const client = {
      ask: async () => ({
        answers: { duplicate_0: { type: "noul", noul: 0.95 } },
        usage: { input_tokens: 0, cost: 0 },
      }),
    } as unknown as JevClient;
    expect(await duplicatePass(client, [a], [a, b], read, duplicateQuestions)).toEqual({ 1: null });
  });

  it("holds to the tuned threshold per candidate", async () => {
    const j = fakeJev({ 1: { 2: [0.64, false] } });
    expect((await duplicatePass(j.client, [a], [a, b], read, duplicateQuestions))[1]).toBeNull();
  });

  it("on the Bugs backlog keeps the High Priority card, whichever pass reads the pair", async () => {
    const cols = { working: "", closable: ["Triaged", "High Priority"], keep: "High Priority" };
    const t = card(1, "kubelet panics on volume removal", { status: "Triaged" });
    const h = card(2, "kubelet panic when a volume is removed", { status: "High Priority" });
    // Each pass reads the pair from its own card's side, and each side would keep itself.
    const j = fakeJev({ 1: { 2: [0.9, true] }, 2: { 1: [0.9, true] } });
    const triaged = await duplicatePass(j.client, [t], [t, h], read, bugDuplicateQuestions, cols);
    const high = await duplicatePass(j.client, [h], [t, h], read, bugDuplicateQuestions, cols);
    expect(triaged[1]).toMatchObject({ number: 2, status: "High Priority" });
    expect(high[2]).toBeNull();
  });
});

describe("nearest", () => {
  it("takes every other card, the most similar first, and at most MAX_CANDIDATES of a huge column", () => {
    const t = card(1, "devicemanager stuck in Allocate RPC");
    const pool = [
      t,
      card(2, "eviction manager ignores ephemeral storage"),
      card(3, "kubelet stuck when device plugin Allocate RPC hangs"),
    ];
    expect(nearest(t, pool, (x) => x.title).map((x) => x.restId)).toEqual([3, 2]);
    const huge = Array.from({ length: 170 }, (_, k) => card(10 + k, `issue ${k}`));
    expect(nearest(t, [t, ...huge], (x) => x.title)).toHaveLength(MAX_CANDIDATES);
  });
});

describe("dupState and dupIssue", () => {
  it("carries the whole evidence: description, human comments and linked PRs, template comments stripped", () => {
    const d: ItemDetail = {
      title: "t",
      body: "x".repeat(9000),
      labels: [],
      state: "OPEN",
      author: { login: "rep" },
      createdAt: "2026-09-01T00:00:00Z",
      url: "u",
      comments: [
        { author: { login: "m" }, createdAt: "2026-09-02T00:00:00Z", body: "y".repeat(4000) },
        { author: { login: "m" }, createdAt: "2026-09-03T00:00:00Z", body: "/retest" },
        { author: { login: "k8s-ci-robot" }, createdAt: "2026-09-03T00:00:00Z", body: "bot" },
      ],
    };
    const pr = {
      repository: "o/r",
      number: 9,
      title: "fix",
      author: "a",
      state: "open" as const,
      createdAt: "2026-09-04T00:00:00Z",
      mergedAt: null,
      body: "<!-- template -->\nfixes it",
    };
    const x = dupIssue(card(1, "t"), d, [pr], NOW, true);
    expect(x.description).toHaveLength(9000);
    expect(x.human_comments.map((c) => c.text.length)).toEqual([4000]);
    expect(x.linked_prs).toEqual([
      { pr: "o/r#9", title: "fix", author: "a", state: "open", description: "fixes it" },
    ]);
    expect(x.jobs).toEqual([]);
  });

  it("is whole when it fits, and cut to the guard with an even share each when the column is too much", () => {
    const big = (n: number) => issueOf(card(n, `t${n}`), "z".repeat(30_000));
    const small = issueOf(card(99, "small"), "short");
    const whole = dupState(small, [big(1)]);
    expect(whole.candidates.candidate_0!.description).toHaveLength(30_000);
    expect(whole.candidates.candidate_0!["precomputed (use as given)"]).toEqual({
      same_author: true,
      shared_assignee: false,
    });
    const cut = dupState(
      small,
      Array.from({ length: 30 }, (_, k) => big(k + 1)),
    );
    expect(JSON.stringify(cut).length).toBeLessThanOrEqual(MAX_STATE_CHARS);
    expect(cut.issue.description).toBe("short");
    expect(cut.candidates.candidate_29!.description).toMatch(/characters cut/);
  });
});
