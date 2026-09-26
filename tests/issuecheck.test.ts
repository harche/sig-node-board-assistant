import { describe, expect, it } from "vitest";
import {
  decideIssueCi,
  dupQueries,
  likelyDuplicate,
  overlap,
  type IssueCiResult,
  type IssueDup,
} from "../src/core/issuecheck";
import { newestFailure, type JobSignal, type TgTable } from "../src/core/testgrid";

const job = (over: Partial<JobSignal> = {}, failures = 3, last: number | null = 1): JobSignal => ({
  job: "ci-node-e2e",
  testgrid: "d#t",
  named_in_title: false,
  tracked_tests: [
    {
      test: "[sig-node] probing restarts",
      runs: 100,
      failures,
      window_days: 14,
      last_failure_days_ago: last,
      runs_since_last_failure: 5,
      last_run_days_ago: 0,
    },
  ],
  whole_job: null,
  ...over,
});

const result = (over: Partial<IssueCiResult> = {}, resolved = 0.1): IssueCiResult => ({
  kind: "issueci",
  closed: false,
  closed_at: null,
  ci: [job()],
  newest: null,
  answers: {
    resolved: { type: "noul", noul: resolved },
    resolution: { type: "choice", choice: "still_open", confidence: 1, probabilities: {} },
  },
  guard: null,
  linked_prs: [],
  readings: [],
  usage: { input_tokens: 0, cost: 0 },
  ...over,
});

const dup = (number: number, p: number, state: "open" | "closed" = "open"): IssueDup => ({
  repository: "kubernetes/kubernetes",
  number,
  title: "t",
  url: "u",
  state,
  p,
  keep: "this",
});

describe("decideIssueCi", () => {
  it("still failing, with the named test's record", () =>
    expect(decideIssueCi(result())).toMatchObject({
      verdict: "failing",
      why: 'On ci-node-e2e, 100 runs in 14d: "[sig-node] probing restarts" failed 3, last yesterday.',
    }));
  it("fixed when Jev reads it resolved and the history allows closing", () =>
    expect(decideIssueCi(result({ ci: [job({}, 0, null)] }, 0.9)).verdict).toBe("fixed"));
  it("too soon to close when the guard holds it", () =>
    expect(decideIssueCi(result({ guard: "wait" }, 0.9))).toMatchObject({
      verdict: "too_fresh",
      why: "wait",
    }));
  it("a different error when the newest failure is not the issue's", () =>
    expect(
      decideIssueCi(
        result({
          newest: {
            job: "j",
            testgrid: "d#t",
            evidence: { build: "1", started: 0, url: "u", result: null, junit_failures: [], log_signals: [] },
            tracks: 0.1,
          },
        }),
      ).verdict,
    ).toBe("changed"));
  it("a closed issue failing again: reopen, unless an open duplicate tracks it now", () => {
    expect(decideIssueCi(result({ closed: true }))).toMatchObject({
      verdict: "regressed",
      suggest: expect.any(String),
    });
    expect(decideIssueCi(result({ closed: true }), dup(7, 0.8))).toMatchObject({
      verdict: "regressed",
      suggest: null,
      why: expect.stringContaining("Tracked again in #7."),
    });
  });
  it("a closed issue is failing again only when the newest failure came after it closed", () => {
    const newest = (started: number) => ({
      job: "j",
      testgrid: "d#t",
      evidence: { build: "1", started, url: "u", result: null, junit_failures: [], log_signals: [] },
      tracks: 0.9,
    });
    const closed_at = new Date(1_000_000).toISOString();
    expect(decideIssueCi(result({ closed: true, closed_at, newest: newest(500_000) })).verdict).toBe("quiet");
    expect(decideIssueCi(result({ closed: true, closed_at, newest: newest(2_000_000) })).verdict).toBe(
      "regressed",
    );
  });
  it("uses the whole job only when the title names it", () => {
    const untested = {
      tracked_tests: "not found",
      whole_job: {
        runs: 50,
        failures: 20,
        window_days: 14,
        last_failure_days_ago: 0,
        runs_since_last_failure: 0,
        last_run_days_ago: 0,
      },
    };
    expect(decideIssueCi(result({ ci: [job(untested)] })).verdict).toBe("open");
    expect(decideIssueCi(result({ ci: [job({ ...untested, named_in_title: true })] })).verdict).toBe(
      "failing",
    );
  });
});

describe("duplicates", () => {
  it("searches the tests, the jobs and the title's telling words", () => {
    const qs = dupQueries(
      "kubernetes/kubernetes",
      "[Flaking Test] restarted with a non-local redirect http liveness probe",
      "### Which jobs are flaking?\nci-kubernetes-node-e2e-containerd\n### Which tests are flaking?\nProbing container should not be restarted with a non-local redirect\n",
      "2025-09-26",
    );
    expect(qs).toContain(
      'repo:kubernetes/kubernetes is:issue "Probing container should not be restarted with a non-local" updated:>=2025-09-26',
    );
    expect(qs).toContain(
      'repo:kubernetes/kubernetes is:issue "ci-kubernetes-node-e2e-containerd" updated:>=2025-09-26',
    );
    expect(qs.some((q) => q.includes("in:title") && q.includes("redirect"))).toBe(true);
  });
  it("scores shared words, not stop words", () => {
    expect(overlap("liveness probe redirect", "liveness probe redirect")).toBe(1);
    expect(overlap("the failing test", "the flaky test")).toBe(0);
  });
  it("names a sure duplicate, and only an open one when asked", () => {
    const r = {
      kind: "issuedups" as const,
      candidates: [dup(1, 0.9, "closed"), dup(2, 0.7), dup(3, 0.4)],
      usage: { input_tokens: 0, cost: 0 },
    };
    expect(likelyDuplicate(r)?.number).toBe(1);
    expect(likelyDuplicate(r, true)?.number).toBe(2);
    expect(likelyDuplicate(null)).toBeNull();
  });
});

describe("newestFailure", () => {
  it("finds the newest column where the row failed", () => {
    const tbl: TgTable = { timestamps: [30, 20, 10], column_ids: ["c", "b", "a"], tests: [] };
    expect(
      newestFailure(tbl, {
        name: "t",
        statuses: [
          { count: 1, value: 1 },
          { count: 2, value: 12 },
        ],
      }),
    ).toEqual({
      build: "b",
      started: 20,
    });
    expect(newestFailure(tbl, { name: "t", statuses: [{ count: 3, value: 1 }] })).toBeNull();
  });
});
