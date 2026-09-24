import { describe, expect, it } from "vitest";
import { decide, f2, OWNER_OTHER_AT } from "../src/core/policy";
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
