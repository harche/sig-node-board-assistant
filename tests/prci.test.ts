import { describe, expect, it } from "vitest";
import { decideCi, failedChecks, failName, rerunCommand, suspectFile, type CiJob } from "../src/core/prci";
import { tally, type TgTable } from "../src/core/testgrid";
import { junitFailures } from "../src/core/tgreview";

const prow = (job: string, build = "1") =>
  `https://prow.k8s.io/view/gs/kubernetes-ci-logs/pr-logs/pull/142200/${job}/${build}`;

describe("failedChecks", () => {
  it("keeps Prow's failed and errored presubmits, not tide, the CLA or passing jobs", () => {
    const got = failedChecks([
      {
        context: "pull-kubernetes-verify",
        state: "failure",
        description: "Job failed.   BaseSHA:abc",
        target_url: prow("pull-kubernetes-verify", "7"),
      },
      {
        context: "pull-kubernetes-unit",
        state: "error",
        description: "Pod scheduling timeout.",
        target_url: prow("pull-kubernetes-unit"),
      },
      {
        context: "pull-kubernetes-e2e-kind",
        state: "success",
        description: "",
        target_url: prow("pull-kubernetes-e2e-kind"),
      },
      {
        context: "tide",
        state: "pending",
        description: "Needs lgtm",
        target_url: "https://prow.k8s.io/pr?query=x",
      },
      {
        context: "EasyCLA",
        state: "failure",
        description: "",
        target_url: "https://easycla.lfx.linuxfoundation.org/",
      },
    ]);
    expect(got).toEqual([
      {
        job: "pull-kubernetes-verify",
        state: "failure",
        description: "Job failed.",
        url: prow("pull-kubernetes-verify", "7"),
        gcs: "kubernetes-ci-logs/pr-logs/pull/142200/pull-kubernetes-verify",
        build: "7",
      },
      expect.objectContaining({ job: "pull-kubernetes-unit", state: "error" }),
    ]);
  });
});

describe("junitFailures on presubmit output", () => {
  it("reads a verify script's reason from its stderr, and keeps a Go case's package", () => {
    const xml = `<testsuite>
      <testcase name="featuregates" classname="verify"><failure type="ScriptError"><![CDATA[
see stderr for details
]]></failure><system-err><![CDATA[alpha feature X cannot be enabled by default]]></system-err></testcase>
      <testcase classname="[sig-node] k8s.io/kubernetes/pkg/kubelet.cm" name="cm"><failure message="Failed" type="">=== RUN   TestA&#xA;--- FAIL: TestA (0.1s)</failure></testcase>
    </testsuite>`;
    const [v, g] = junitFailures(xml);
    expect(v).toEqual({
      test: "featuregates",
      classname: "verify",
      message: "alpha feature X cannot be enabled by default",
    });
    expect(g).toMatchObject({ test: "cm", classname: "[sig-node] k8s.io/kubernetes/pkg/kubelet.cm" });
    expect(failName(g!)).toBe("TestA");
  });
});

describe("tally", () => {
  it("counts other PRs' runs of a row, leaving out this PR's builds and runs where it did not run", () => {
    const tbl: TgTable = {
      timestamps: [5, 4, 3, 2, 1],
      column_ids: ["b5", "b4", "b3", "b2", "b1"],
      tests: [],
    };
    const row = {
      name: "t",
      statuses: [
        { count: 2, value: 12 },
        { count: 1, value: 0 },
        { count: 2, value: 1 },
      ],
    };
    expect(tally(tbl, row, new Set(["b5"]))).toEqual({ runs: 3, failed: 1 });
  });
});

const job = (over: Partial<CiJob> = {}, cause?: Record<string, number>): CiJob => ({
  check: {
    job: "pull-kubernetes-node-e2e-containerd",
    state: "failure",
    description: "Job failed.",
    url: "u",
    gcs: "g",
    build: "1",
  },
  evidence: {
    build: "1",
    started: 0,
    url: "u",
    result: "FAILURE",
    junit_failures: [{ test: "[It] [sig-node] Probing container restarts", message: "timed out" }],
    log_signals: ["[FAILED] timed out"],
  },
  this_pr: [],
  elsewhere: {
    testgrid: "d#t",
    window_days: 6,
    job: { runs: 400, failed: 60 },
    tests: [{ test: "E2eNode Suite.[It] [sig-node] Probing container restarts", runs: 400, failed: 14 }],
  },
  cause: cause
    ? { type: "choice", choice: Object.keys(cause)[0]!, confidence: 1, probabilities: cause }
    : null,
  suspects: [],
  tracks: [],
  readings: [],
  usage: { input_tokens: 0, cost: 0 },
  ...over,
});

describe("decideCi", () => {
  it("calls a job Prow never ran infra, without Jev", () =>
    expect(
      decideCi(
        job({
          check: { ...job().check, state: "error", description: "Pod scheduling timeout." },
          evidence: { ...job().evidence, junit_failures: [], log_signals: null },
        }),
      ),
    ).toEqual({
      verdict: "infra",
      why: "Prow could not run it: Pod scheduling timeout.",
      command: "/test pull-kubernetes-node-e2e-containerd",
    }));
  it("says a flake with the test's record on other PRs, and the issue that tracks it", () => {
    const d = decideCi(
      job(
        {
          tracks: [
            {
              repo: "kubernetes/kubernetes",
              number: 9,
              title: "t",
              state: "open",
              url: "u",
              via: "test name",
              p: 0.9,
              names_job: false,
            },
          ],
        },
        { flake: 0.9, this_pr: 0.05, infra: 0.05 },
      ),
    );
    expect(d.verdict).toBe("flake");
    expect(d.why).toBe(
      "90%: [sig-node] Probing container restarts failed on 14 of 400 other PRs' runs in 6d; tracked by #9",
    );
  });
  it("names the changed file Jev judges likely to cause a PR's failure", () => {
    const mine = (p: number) =>
      decideCi(job({ suspects: [{ file: "pkg/kubelet/prober/prober_manager.go", p }] }, { this_pr: 0.9 }));
    expect(mine(0.8).why).toBe(
      "90%: [sig-node] Probing container restarts fails here; likely from the change to pkg/kubelet/prober/prober_manager.go",
    );
    expect(mine(0.3).why).toBe("90%: [sig-node] Probing container restarts fails here");
    expect(suspectFile({ suspects: [{ file: "a.go", p: 0.5 }] })).toBe("a.go");
    expect(suspectFile({ suspects: [] })).toBeNull();
  });
  it("leaves a close call to the reader, with no command", () =>
    expect(decideCi(job({}, { this_pr: 0.5, flake: 0.45, infra: 0.05 }))).toMatchObject({
      verdict: "unsure",
      command: null,
    }));
  it("reruns everything with /retest only when no failure is the PR's", () => {
    const flake = job({}, { flake: 0.9 });
    const mine = job({ check: { ...job().check, job: "pull-kubernetes-verify" } }, { this_pr: 0.95 });
    expect(rerunCommand([flake, flake])).toBe("/retest");
    expect(rerunCommand([flake, mine])).toBe("/test pull-kubernetes-node-e2e-containerd");
    expect(rerunCommand([mine])).toBeNull();
    // A job whose judge failed is unknown: /retest would rerun it too.
    expect(rerunCommand([flake, flake], 3)).toBe(
      "/test pull-kubernetes-node-e2e-containerd\n/test pull-kubernetes-node-e2e-containerd",
    );
  });
});
