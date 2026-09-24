/** The Triage questions, one per key, as the reference implementation's prompts/triage/*.yaml define them.
 *  tests/prompts.test.ts checks this file against the JSON the Python loader produces, so a prompt change in
 *  either repo shows up as a failing test rather than a silent drift.
 *
 *  Shape follows docs.typesafe.ai/primitives/advanced: instructions, Noul criteria, Choice options and Score
 *  levels are objects, so the board definition, boundary cases and examples are labelled rather than buried in
 *  prose. Question ids are for code only; Jev never sees them. */
import type { ItemKind } from "../types";

export const EVIDENCE = {
  issue: ["title", "description", "human_comments"],
  pull_request: ["title", "description", "human_comments", "changed_files"],
} as const;

export const BOARD = {
  name: "SIG Node CI/Test board",
  tracks: [
    "failing or flaking SIG Node tests and CI jobs",
    "SIG Node test coverage work",
    "SIG Node CI and test infrastructure",
  ],
  does_not_track: [
    "SIG Node features, KEPs, API changes",
    "product behaviour fixes and refactors",
    "other SIGs' tests and components",
  ],
};

/** Grey-zone tie-breaker, part 1: P(the deliverable is CI work), summed over policy.CI_WORK; times owner's P(node). */
const bucket = {
  type: "choice",
  instructions: { question: "Which category is this item's primary deliverable?" },
  criteria: {
    failing_or_flaking_test: {
      what: "A specific test or CI job fails, flakes or times out, or the PR fixes that.",
      not_for: "A feature PR whose own presubmits happen to fail.",
    },
    test_coverage: {
      what: "New or improved tests are the deliverable.",
      not_for: "Tests added alongside a feature or product fix.",
    },
    ci_infrastructure: {
      what: "CI job config, lanes, test images, e2e framework, test-infra.",
      not_for: "Product code.",
    },
    feature_or_product_change: {
      what: "KEP, feature gate, API change, behaviour fix, refactor, cherry pick.",
      not_for: "Changes whose only purpose is to fix or add tests.",
    },
  },
};

/** The decision. Every other question is a grey-zone tie-breaker or shown to the reviewer. */
const in_scope = {
  type: "noul",
  instructions: {
    board: BOARD,
    question: "Does this item belong on the `board`?",
    focus: "Judge the primary deliverable, not everything the item touches.",
  },
  criteria: {
    true: {
      what:
        "The deliverable is SIG Node CI work: a failing/flaking SIG Node test or job, SIG Node test coverage, " +
        "or SIG Node CI/test infrastructure.",
      includes: [
        "a PR that fixes a broken or flaky SIG Node test, even if it also changes a few lines of product code to do so",
        "a PR that fixes a kubelet bug whose only reported symptom is a flaking node e2e test",
        "an issue asking for integration or e2e coverage of a node feature",
        "a test-infra change to a node e2e job: skip lists, images, timeouts, lane renames",
        "a human commented /sig node to route it to SIG Node",
      ],
      examples: [
        "[Flaky test] node-e2e eviction test times out",
        "Fix race in kubelet e2e test helper",
        "Add e2e coverage for pod resize",
        "Move node-serial jobs to cgroup v2 images",
      ],
    },
    false: {
      what: "The deliverable is product work, or the test/job belongs to another SIG.",
      includes: [
        "KEP implementation, feature gate add/promote/remove, API field changes",
        "a kubelet behaviour fix or refactor with no failing or flaky test behind it (tests added alongside do not change this)",
        "cherry picks of product fixes",
        "tests, benchmarks or frameworks for another SIG's component",
      ],
      examples: [
        "KEP-XXXX: add alpha support for a new pod field",
        "kubelet: refactor status manager",
        "scheduler_perf: add benchmark labels",
        "e2e/network: add a network policy test",
      ],
    },
  },
};

/** Grey-zone tie-breaker, part 2: P(SIG Node owns it), times bucket's P(CI work). */
const owner = {
  type: "choice",
  instructions: {
    question: "Which SIG owns the test, job or code this item is about?",
    focus: "A human /sig comment in `human_comments` is strong evidence of ownership.",
  },
  criteria: {
    node: {
      areas: [
        "kubelet",
        "CRI and container runtimes (containerd, CRI-O)",
        "pod and container lifecycle on the node",
        "CPU, memory and topology managers",
        "eviction",
        "cgroups",
        "device plugins",
        "node e2e and node-serial CI jobs",
      ],
    },
    other: {
      areas: [
        "scheduler and scheduler_perf",
        "DRA scheduling and allocation",
        "apps controllers",
        "api-machinery, client-go",
        "storage/CSI",
        "network and network policy",
        "auth",
        "cluster-lifecycle",
        "conformance/apisnoop tooling",
      ],
    },
    unclear: "The evidence does not say which component or test is involved.",
  },
};

/** Levels map to Prow priorities in order (policy.PRIORITIES). Shown to the reviewer as a hint only: against past
 *  board decisions it never beat always answering important-longterm, so policy.priority() uses that default. */
const priority = {
  type: "score",
  instructions: {
    question: "How urgent is this for SIG Node CI health?",
    note: "Judge the impact on CI signal, not the author's own urgency claims.",
  },
  criteria: [
    {
      summary: "backlog",
      signals: ["cleanup", "nice-to-have coverage", "nothing is broken", "WIP or exploratory"],
    },
    {
      summary: "important-longterm",
      signals: ["an intermittent flake", "a known coverage gap", "infra work that is not blocking"],
    },
    {
      summary: "important-soon",
      signals: [
        "a job is consistently red",
        "a presubmit or release-blocking job is broken",
        "blocks other contributors' PRs",
      ],
    },
  ],
};

export type TriageQuestions = Record<"bucket" | "in_scope" | "owner" | "priority", Record<string, unknown>>;

/** The four questions with `evidence` for the item type appended to each one's instructions. Key order is the
 *  file-name order of the reference prompts, so the request (and its cache key) is stable. */
export function triageQuestions(kind: ItemKind): TriageQuestions {
  const evidence = [...EVIDENCE[kind === "PullRequest" ? "pull_request" : "issue"]];
  const withEvidence = (q: { instructions: Record<string, unknown> } & Record<string, unknown>) => ({
    ...q,
    instructions: { ...q.instructions, evidence },
  });
  return {
    bucket: withEvidence(bucket),
    in_scope: withEvidence(in_scope),
    owner: withEvidence(owner),
    priority: withEvidence(priority),
  };
}
