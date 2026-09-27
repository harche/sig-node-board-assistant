import { describe, expect, it } from "vitest";
import {
  candidateQueries,
  classify,
  distinctive,
  mergeCandidates,
  openDuplicate,
  xrefs,
  type RelatedResult,
} from "../src/core/related";

describe("candidates", () => {
  it("finds strings rare enough to search verbatim", () => {
    const d = distinctive(
      "The kubelet panics in GetVfsStats (fs.go) with error: timed out waiting for statfs on /var/lib/kubelet 12345",
    );
    expect(d).toContain("GetVfsStats");
    expect(d).toContain("timed out waiting for statfs on");
    expect(distinctive("[NodeConformance] PodStatus{PodCondition} in run_remote.go")).toEqual([]);
    expect(distinctive("&PodStatus{Phase:Running,LastProbeTime:0001,ObservedGeneration:1}")).toEqual([]);
  });
  it("reads the issues a thread links in its own repo, by #N or URL", () =>
    expect(
      xrefs(
        "see #141786 and https://github.com/kubernetes/kubernetes/issues/116123, not org/repo#5",
        "kubernetes/kubernetes",
      ),
    ).toEqual([141786, 116123]));
  it("asks every source, and searches a long thread too", () => {
    const title = "[Flaking Test] restarted with a non-local redirect http liveness probe";
    const body =
      "### Which tests are flaking?\nProbing container should not be restarted with a non-local redirect\n";
    const sources = (n: number) =>
      new Set(
        candidateQueries(
          "kubernetes/kubernetes",
          title,
          body,
          Array.from({ length: n }, () => ({
            author: "a",
            body: "error: connection refused by the probe target host",
          })),
        ).map((x) => x.source),
      );
    expect([...sources(0)]).toEqual(
      expect.arrayContaining(["keyword", "test", "semantic_title", "semantic_body", "hybrid_title"]),
    );
    expect(sources(0).has("thread")).toBe(false);
    expect(sources(8).has("thread")).toBe(true);
  });
  it("keeps every search within GitHub's 256-character limit", () => {
    const long = `[Flaking Test] E2eNode Suite [It] [sig-node] ${"a very long Ginkgo test name ".repeat(12)}`;
    for (const { query } of candidateQueries("kubernetes/kubernetes", long, long, []))
      expect((typeof query === "string" ? query : query.q).length).toBeLessThanOrEqual(256);
  });
  it("interleaves the searches, puts linked issues first, and leaves the issue itself out", () =>
    expect(
      mergeCandidates(
        [
          [1, 2, 3],
          [4, 1, 5],
        ],
        [9, 7],
        7,
      ),
    ).toEqual([9, 1, 4, 2, 3, 5]));
});

describe("classify", () => {
  it("shows a duplicate only when one could be closed in favour of the other", () => {
    expect(classify({ duplicate: 0.5, same_root_cause: 0.3 }, 0.6)).toMatchObject({
      bucket: "duplicate",
      relation: "duplicate",
    });
    expect(classify({ duplicate: 0.2, same_root_cause: 0.6 }, 0.6)).toMatchObject({
      bucket: "duplicate",
      relation: "same_root_cause",
    });
    expect(classify({ duplicate: 0.5, same_root_cause: 0.3 }, 0.2).bucket).toBeNull();
  });
  it("shows a related issue by its relation", () => {
    expect(classify({ part_of: 0.9 }, undefined)).toMatchObject({ bucket: "related", relation: "part_of" });
    expect(classify({ unrelated: 0.8, follow_up: 0.2 }, undefined).bucket).toBeNull();
  });
  it("names an open duplicate, for a closed issue failing again", () => {
    const m = (number: number, state: "open" | "closed") => ({
      repository: "r",
      number,
      title: "t",
      url: "u",
      state,
      relation: "duplicate" as const,
      older: true,
      p: 0.9,
      probabilities: {},
    });
    const r: RelatedResult = {
      kind: "related",
      duplicates: [m(1, "closed"), m(2, "open")],
      related: [],
      asked: 2,
      usage: { input_tokens: 0, cost: 0 },
    };
    expect(openDuplicate(r)?.number).toBe(2);
    expect(openDuplicate(null)).toBeNull();
    // A newer open issue reporting it came back is where it is tracked now; an older regression is not.
    const reg = (number: number, older: boolean) => ({
      ...m(number, "open"),
      relation: "regression" as const,
      older,
    });
    expect(
      openDuplicate({ ...r, duplicates: [m(1, "closed")], related: [reg(3, true), reg(4, false)] })?.number,
    ).toBe(4);
  });
});
