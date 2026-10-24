import { describe, expect, it } from "vitest";
import type { JevClient } from "../src/core/jev";
import { judge, proposedActions } from "../src/core/triage";
import type { BoardFields, BoardItem, ItemDetail, JevChoice } from "../src/core/types";

const choice = (probabilities: Record<string, number>): JevChoice => {
  const [c, v] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]!;
  return { type: "choice", choice: c, confidence: v, probabilities };
};

const item: BoardItem = {
  id: "PVTI_1",
  restId: 1,
  status: "Triage",
  type: "Issue",
  number: 42,
  url: "https://github.com/kubernetes/kubernetes/issues/42",
  repository: "kubernetes/kubernetes",
  title: "KEP-1234: add a new pod field",
  state: "open",
  merged: false,
  draft: false,
  labels: ["sig/node", "kind/feature"],
  assignees: [],
  updatedAt: "2026-01-01T00:00:00Z",
  closedAt: null,
};

const detail = (comments: { login: string; body: string }[]): ItemDetail => ({
  title: item.title,
  body: "",
  labels: item.labels.map((name) => ({ name })),
  state: "open",
  author: { login: "reporter" },
  createdAt: "2026-01-01T00:00:00Z",
  url: item.url,
  comments: comments.map((c) => ({
    author: { login: c.login },
    body: c.body,
    createdAt: "2026-01-02T00:00:00Z",
  })),
});

const fields: BoardFields = {
  title: "SIG Node CI/Test Board",
  project_id: "PVT_1",
  status_field_id: "PVTSSF_1",
  status_field_rest_id: 1,
  options: { Triage: "opt-triage", "Archive-it": "opt-archive", "Issues - To do": "opt-todo" },
};

/** Answers the first call (bucket, in_scope, owner) and the priority call, recording which keys were asked. */
const jev = (ci: number) => {
  const asked: string[][] = [];
  const states: unknown[] = [];
  const client = {
    ask: async (s: unknown, q: Record<string, unknown>) => {
      asked.push(Object.keys(q));
      states.push(s);
      const answers: Record<string, unknown> = {
        bucket: choice({ failing_or_flaking_test: ci, feature_or_product_change: 1 - ci }),
        in_scope: { type: "noul", noul: 0.2 },
        owner: choice({ node: 0.9, other: 0.1 }),
        priority: { type: "score", score: 0, confidence: 0.3, probabilities: { "0": 0.1, "1": 0.8 } },
      };
      return { answers, usage: { input_tokens: 0, cost: 0 } };
    },
  };
  return { client: client as unknown as JevClient, asked, states };
};

describe("judge() with a human /sig node", () => {
  const routed = detail([{ login: "alice", body: "/sig node" }]);

  it("removes a non-CI item in one Jev call and offers only Archive", async () => {
    const j = jev(0.1);
    const r = await judge(item, routed, j.client);
    expect(r.verdict).toBe("REMOVE");
    expect(r.why).toContain("the human (alice) /sig node routing does not override it");
    // A REMOVE gets no priority question and cannot be accepted: it is only ever archived.
    expect(j.asked).toEqual([["bucket", "in_scope", "owner"]]);
    expect(r.priority).toBeNull();
    const p = proposedActions(item, r, fields);
    expect(p.recommended).toBe("reject");
    expect(p.accept).toBeNull();
    expect(p.reject.steps).toEqual([
      { kind: "move", itemId: item.id, restId: item.restId, lane: "Archive-it" },
    ]);
  });

  it("rescues a CI item to the reviewer's call, and offers Accept with a priority", async () => {
    const j = jev(0.7);
    const r = await judge(item, routed, j.client);
    expect(r.verdict).toBe("BORDERLINE");
    expect(r.priority).toBe("important-longterm");
    expect(j.asked).toHaveLength(2);
    const p = proposedActions(item, r, fields);
    expect(p.recommended).toBeNull(); // borderline: the reviewer picks
    expect(p.accept).not.toBeNull();
  });
});

describe("judge() reads the whole thread", () => {
  it("sends Jev an early decisive comment in a 40-comment thread, in full", async () => {
    const decisive = `This is not a test problem: the kubelet leaks the cgroup on restart. ${"Details. ".repeat(200)}`;
    const thread = Array.from({ length: 40 }, (_, i) => ({
      login: `h${i}`,
      body: i === 2 ? decisive : `+1, seen again (${i})`,
    }));
    const j = jev(0.1);
    await judge(item, detail(thread), j.client);
    const st = j.states[0] as { human_comments: { author: string; text: string }[] };
    expect(st.human_comments).toHaveLength(40);
    expect(st.human_comments[2]).toEqual({ author: "h2", text: decisive });
  });

  it("leaves out comments that are only Prow commands, keeping their routing", async () => {
    const j = jev(0.1);
    await judge(
      item,
      detail([
        { login: "alice", body: "/sig node" },
        { login: "bob", body: "/retest\n/test pull-kubernetes-node-e2e" },
        { login: "carol", body: "/triage accepted\nThe repro in the description is enough." },
      ]),
      j.client,
    );
    const st = j.states[0] as { human_comments: unknown[]; human_routing: unknown[] };
    expect(st.human_comments).toEqual([
      { author: "carol", text: "/triage accepted\nThe repro in the description is enough." },
    ]);
    expect(st.human_routing).toEqual([{ author: "alice", command: "/sig node" }]);
  });
});
