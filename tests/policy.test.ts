import { describe, expect, it } from "vitest";
import { decide, f2, OWNER_OTHER_AT, priority } from "../src/core/policy";
import { prowBody } from "../src/core/triage";
import type { Signals, TriageAnswers } from "../src/core/types";

describe("f2 (Python-compatible .2f)", () => {
  it.each([
    [0.7000000000000001 * 0.95, "0.67"],
    [0.665, "0.67"],
    [0.125, "0.12"],
    [0.375, "0.38"],
    [2.675, "2.67"],
    [0.6649999999999999, "0.66"],
    [0, "0.00"],
    [1, "1.00"],
    [0.995, "0.99"],
    [0.9951, "1.00"],
    [0.005, "0.01"],
  ])("%s -> %s", (n, want) => expect(f2(n)).toBe(want));
});

describe("decide(): ownership guard", () => {
  const answers = (p: number, choice: string, confidence: number): TriageAnswers => ({
    in_scope: { type: "noul", noul: p },
    bucket: {
      type: "choice",
      choice: "failing_or_flaking_test",
      confidence: 0.9,
      probabilities: { failing_or_flaking_test: 0.9, feature_or_product_change: 0.1 },
    },
    owner: {
      type: "choice",
      choice,
      confidence,
      probabilities: {
        node: choice === "node" ? confidence : 1 - confidence,
        other: choice === "other" ? confidence : 1 - confidence,
        unclear: 0,
      },
    },
    priority: { type: "score", score: 0.5, confidence: 0.5, probabilities: { "0": 0.3, "1": 0.4, "2": 0.3 } },
  });
  const sig: Signals = {
    human_slash_routing_comments: [],
    manual_sig_node_routing_present: false,
    human_comment_count: 0,
    triage_accepted_already: false,
    priority_label_already: null,
  };
  it("turns a confident KEEP into BORDERLINE when Jev is confident another SIG owns it", () => {
    const r = decide(answers(0.8, "other", OWNER_OTHER_AT), sig);
    expect(r.verdict).toBe("BORDERLINE");
    expect(r.why).toBe("P(in scope)=0.80; but Jev thinks another SIG owns it (conf 0.60)");
  });
  it("leaves KEEP alone when the owner answer is node or unsure", () => {
    expect(decide(answers(0.8, "node", 0.9), sig).verdict).toBe("KEEP");
    expect(decide(answers(0.8, "other", 0.59), sig).verdict).toBe("KEEP");
  });
});

describe("decide(): a human /sig node routing", () => {
  const routed = (r: string[], p: number, ci: number) => {
    const a: TriageAnswers = {
      in_scope: { type: "noul", noul: p },
      bucket: {
        type: "choice",
        choice: ci >= 0.5 ? "failing_or_flaking_test" : "feature_or_product_change",
        confidence: 0.9,
        probabilities: { failing_or_flaking_test: ci, feature_or_product_change: 1 - ci },
      },
      owner: {
        type: "choice",
        choice: "node",
        confidence: 0.9,
        probabilities: { node: 0.9, other: 0.1, unclear: 0 },
      },
      priority: {
        type: "score",
        score: 0.5,
        confidence: 0.5,
        probabilities: { "0": 0.3, "1": 0.4, "2": 0.3 },
      },
    };
    const s: Signals = {
      human_slash_routing_comments: r.map((who) => ({ who, cmd: "/sig node" })),
      manual_sig_node_routing_present: r.length > 0,
      human_comment_count: r.length,
      triage_accepted_already: false,
      priority_label_already: null,
    };
    return decide(a, s);
  };

  it("rescues a REMOVE when Jev still reads the deliverable as CI work", () => {
    const r = routed(["alice"], 0.2, 0.5);
    expect(r.verdict).toBe("BORDERLINE");
    expect(r.why).toBe(
      "P(in scope)=0.20; but a human (alice) routed it with /sig node, and P(CI work)=0.50 still says CI work, " +
        "so the routing overrides the ownership half of that REMOVE",
    );
  });

  it("keeps the REMOVE when Jev says the deliverable is not CI work", () => {
    // A /sig node on a KEP or a product fix says the SIG owns it, which on a CI board is not the open question.
    const r = routed(["alice", "bob"], 0.2, 0.1);
    expect(r.verdict).toBe("REMOVE");
    expect(r.why).toBe(
      "P(in scope)=0.20; the human (alice, bob) /sig node routing does not override it: P(CI work)=0.10 is below " +
        "0.50, so the deliverable is not CI work",
    );
  });

  // The gate is a literal here, not the exported constant: moving HAND_ROUTED_CI_AT has to fail a test.
  it.each([
    [0.5, "BORDERLINE"],
    [0.49, "REMOVE"],
    [0.7, "BORDERLINE"],
    [0.1, "REMOVE"],
  ])("at P(CI work)=%s the routing gives %s", (ci, verdict) => {
    expect(routed(["alice"], 0.2, ci).verdict).toBe(verdict);
  });

  it("does not touch a verdict that is not a REMOVE", () => {
    expect(routed(["alice"], 0.9, 0.1).verdict).toBe("KEEP");
    expect(routed(["alice"], 0.9, 0.1).why).toBe("P(in scope)=0.90");
    expect(routed([], 0.2, 0.1).why).toBe("P(in scope)=0.20");
  });

  it("names only the humans who wrote /sig node", () => {
    const s: Signals = {
      human_slash_routing_comments: [
        { who: "carol", cmd: "/area test" },
        { who: "alice", cmd: "/sig node" },
      ],
      manual_sig_node_routing_present: true,
      human_comment_count: 2,
      triage_accepted_already: false,
      priority_label_already: null,
    };
    const a = {
      in_scope: { type: "noul", noul: 0.2 },
      bucket: {
        type: "choice",
        choice: "feature_or_product_change",
        confidence: 0.9,
        probabilities: { failing_or_flaking_test: 0.1, feature_or_product_change: 0.9 },
      },
      owner: {
        type: "choice",
        choice: "node",
        confidence: 0.9,
        probabilities: { node: 0.9, other: 0.1, unclear: 0 },
      },
      priority: {
        type: "score",
        score: 0.5,
        confidence: 0.5,
        probabilities: { "0": 0.3, "1": 0.4, "2": 0.3 },
      },
    } as TriageAnswers;
    expect(decide(a, s).why).toContain("the human (alice) /sig node routing does not override it");
  });
});

describe("decide(): a missing answer goes to a human", () => {
  // Jev's answers are not validated: a missing one must not read as P = 0 and remove the item.
  const answers = (p: number | undefined, bucket: boolean, owner = true) =>
    ({
      ...(p === undefined ? {} : { in_scope: { type: "noul", noul: p } }),
      ...(bucket
        ? {
            bucket: {
              type: "choice",
              choice: "failing_or_flaking_test",
              confidence: 0.9,
              probabilities: { failing_or_flaking_test: 0.9, feature_or_product_change: 0.1 },
            },
          }
        : {}),
      ...(owner
        ? {
            owner: {
              type: "choice",
              choice: "node",
              confidence: 0.9,
              probabilities: { node: 0.9, other: 0.1 },
            },
          }
        : {}),
    }) as unknown as TriageAnswers;
  const sig = (r: string[]): Signals => ({
    human_slash_routing_comments: r.map((who) => ({ who, cmd: "/sig node" })),
    manual_sig_node_routing_present: r.length > 0,
    human_comment_count: r.length,
    triage_accepted_already: false,
    priority_label_already: null,
  });

  it("no P(in scope): BORDERLINE", () => {
    expect(decide(answers(undefined, true), sig([]))).toEqual({
      verdict: "BORDERLINE",
      why: "Jev gave no P(in scope)",
    });
  });

  it("no bucket on a /sig node REMOVE: BORDERLINE, not archived", () => {
    expect(decide(answers(0.2, false), sig(["alice"]))).toEqual({
      verdict: "BORDERLINE",
      why: "P(in scope)=0.20; but a human (alice) routed it with /sig node, and Jev gave no P(CI work) to say it is not CI work",
    });
  });

  it("no bucket in the grey zone: BORDERLINE, not a tie-break of 0", () => {
    expect(decide(answers(0.5, false), sig([]))).toEqual({
      verdict: "BORDERLINE",
      why: "P(in scope)=0.50 is in the grey zone, and Jev gave no P(CI work) to break the tie",
    });
  });

  it("no owner in the grey zone: BORDERLINE, not a tie-break of 0", () => {
    expect(decide(answers(0.5, true, false), sig([]))).toEqual({
      verdict: "BORDERLINE",
      why: "P(in scope)=0.50 is in the grey zone, and Jev gave no P(node owns it) to break the tie",
    });
  });

  it("no owner where P(in scope) decides alone: unchanged", () => {
    expect(decide(answers(0.2, true, false), sig([])).verdict).toBe("REMOVE");
    expect(decide(answers(0.8, true, false), sig([])).verdict).toBe("KEEP");
  });

  it("no bucket where P(in scope) decides alone: unchanged", () => {
    expect(decide(answers(0.2, false), sig([])).verdict).toBe("REMOVE");
    expect(decide(answers(0.8, false), sig([])).verdict).toBe("KEEP");
  });
});

describe("priority()", () => {
  const a = (probabilities: Record<string, number>) =>
    ({ priority: { type: "score", score: 0, confidence: 0.4, probabilities } }) as unknown as TriageAnswers;
  const sig = (label: string | null) => ({ priority_label_already: label }) as Signals;
  it("takes Jev's most likely level", () => {
    expect(priority(a({ "0": 0.1, "1": 0.2, "2": 0.7 }), sig(null))).toEqual({
      priority: "important-soon",
      why: "Jev's pick",
    });
    expect(priority(a({ "0": 0.6, "1": 0.4 }), sig(null)).priority).toBe("backlog");
  });
  it("keeps a label already set, and falls back to the default when Jev gives nothing", () => {
    expect(priority(a({ "2": 1 }), sig("priority/backlog"))).toEqual({
      priority: "backlog",
      why: "already labelled",
    });
    expect(priority(a({}), sig(null)).priority).toBe("important-longterm");
  });
});

describe("prowBody()", () => {
  it("removes a different priority already on the item", () => {
    expect(prowBody("important-soon")).toBe("/triage accepted\n/priority important-soon");
    expect(prowBody("important-soon", "important-soon")).toBe("/triage accepted\n/priority important-soon");
    expect(prowBody("backlog", "important-soon")).toBe(
      "/triage accepted\n/remove-priority important-soon\n/priority backlog",
    );
  });
});
