import { describe, expect, it } from "vitest";
import { Cache, MemoryStore } from "../src/core/cache";
import {
  cells,
  matchRows,
  normTest,
  refsFrom,
  rowSignal,
  TestGridClient,
  testsFrom,
  type TgTable,
} from "../src/core/testgrid";

describe("refsFrom", () => {
  it("reads TestGrid tabs, decoding them and dropping query options", () => {
    const r = refsFrom(
      "see https://testgrid.k8s.io/sig-release-master-blocking#gce-device-plugin-gpu-master&exclude-non-failed-tests= and " +
        "[x](https://testgrid.k8s.io/sig-node-containerd#ci-node-e2e%20serial)",
    );
    expect(r.tabs).toEqual([
      { dashboard: "sig-release-master-blocking", tab: "gce-device-plugin-gpu-master" },
      { dashboard: "sig-node-containerd", tab: "ci-node-e2e serial" },
    ]);
  });

  it("reads Prow job names from run links, job history and bare names", () => {
    const r = refsFrom(
      "https://prow.k8s.io/view/gs/kubernetes-ci-logs/logs/ci-node-crio-eviction/2095827467854942208\n" +
        "https://prow.k8s.io/view/gs/kubernetes-ci-logs/pr-logs/pull/140533/pull-kubernetes-unit/2077007666856595456\n" +
        "https://prow.k8s.io/job-history/gs/kubernetes-ci-logs/logs/ci-kubernetes-e2e-gci-gce-slow\n" +
        "also `ci-kubernetes-node-swap-fedora-serial` fails",
    );
    expect(r.jobs).toEqual([
      "ci-node-crio-eviction",
      "pull-kubernetes-unit",
      "ci-kubernetes-e2e-gci-gce-slow",
      "ci-kubernetes-node-swap-fedora-serial",
    ]);
  });
});

describe("testsFrom", () => {
  it("takes the issue template's test section, one test per line", () => {
    const body =
      "### Which jobs are flaking?\n\nci-node-e2e\n\n### Which tests are flaking?\n\n" +
      "- E2eNode Suite [It] [sig-node] Probing container should *not* be restarted\n* `[sig-node] Pods should run`\n\n" +
      "### Since when has it been flaking?\n\nyesterday";
    expect(testsFrom("[Flaking Test] probes", body)).toEqual([
      "E2eNode Suite [It] [sig-node] Probing container should *not* be restarted",
      "[sig-node] Pods should run",
    ]);
  });

  it("falls back to the title without its tags", () => {
    expect(
      testsFrom("[Flaking Test] [sig-node] ImageGCNoEviction: DiskPressure not encountered", "no template"),
    ).toEqual(["[sig-node] ImageGCNoEviction: DiskPressure not encountered"]);
  });
});

const row = (name: string, statuses: [number, number][]) => ({
  name,
  statuses: statuses.map(([count, value]) => ({ count, value })),
});

describe("matchRows", () => {
  const tbl: TgTable = {
    timestamps: [],
    tests: [
      row("Overall", []),
      row("kubetest.Timeout", []),
      row(
        "Kubernetes e2e suite.[It] [sig-node] Probing container should *not* be restarted with a non-local redirect http liveness probe",
        [],
      ),
      row(
        "E2eNode Suite.[It] [sig-node] ImageGCNoEviction [Feature:Eviction] when we run containers that should cause DiskPressure should eventually evict all of the correct pods [Disruptive] [Serial] [Slow]",
        [],
      ),
    ],
  };

  it("matches the TestGrid row that contains the issue's test name, ignoring the suite prefix", () => {
    expect(
      matchRows(tbl, "[sig-node] Probing container should *not* be restarted with a non-local redirect").map(
        (r) => r.name,
      ),
    ).toEqual([tbl.tests[2]!.name]);
  });

  it("matches on most of the words when the wording differs", () => {
    expect(matchRows(tbl, "ImageGCNoEviction DiskPressure evict correct pods").map((r) => r.name)).toEqual([
      tbl.tests[3]!.name,
    ]);
  });

  it("matches a harness row only when it is named in full", () => {
    expect(matchRows(tbl, "kubetest.Timeout. The suite passes otherwise").map((r) => r.name)).toEqual([
      "kubetest.Timeout",
    ]);
    expect(matchRows(tbl, "Timeout")).toEqual([]);
  });

  it("normalises names", () => {
    expect(normTest("E2eNode Suite.[It] [sig-node]  Foo")).toBe("[sig-node] foo");
  });
});

describe("rowSignal", () => {
  const DAY = 86_400_000;
  const now = 100 * DAY;
  // Newest first: 4 passes, a fail, 2 passes, a no-result, a flaky, a pass. One run per day.
  const tbl: TgTable = { timestamps: Array.from({ length: 10 }, (_, i) => now - (i + 1) * DAY), tests: [] };
  const r = row("t", [
    [4, 1],
    [1, 12],
    [2, 1],
    [1, 0],
    [1, 13],
    [1, 1],
  ]);
  const ref = { dashboard: "d", tab: "t" };

  it("expands run-length statuses", () => {
    expect(cells(r, 11)).toEqual([1, 1, 1, 1, 12, 1, 1, 0, 13, 1, 0]);
  });

  it("counts runs, failures (FAIL and FLAKY) and the clean streak, skipping columns without a result", () => {
    expect(rowSignal(tbl, r, ref, now)).toMatchObject({
      runs: 9,
      failures: 2,
      window_days: 10,
      last_failure_days_ago: 5,
      runs_since_last_failure: 4,
      last_run_days_ago: 1,
    });
  });

  it("sees the history as of an earlier time", () => {
    expect(rowSignal(tbl, r, ref, now - 5.5 * DAY)).toMatchObject({
      runs: 4,
      failures: 1,
      last_failure_days_ago: 3,
    });
  });

  it("counts timeouts and build or tool failures as failures, and skips running or cancelled columns", () => {
    const t: TgTable = { timestamps: Array.from({ length: 6 }, (_, i) => now - (i + 1) * DAY), tests: [] };
    const x = row("t", [
      [1, 4],
      [1, 7],
      [1, 9],
      [1, 1],
      [1, 11],
      [1, 14],
    ]);
    expect(rowSignal(t, x, ref, now)).toMatchObject({ runs: 4, failures: 3, runs_since_last_failure: 0 });
  });

  it("counts runs after a fix only when TestGrid still has runs from before it", () => {
    expect(rowSignal(tbl, r, ref, now, now - 4.5 * DAY)).toMatchObject({
      runs_after_fix: 4,
      failures_after_fix: 0,
    });
    expect(rowSignal(tbl, r, ref, now, now - 20 * DAY).runs_after_fix).toBeUndefined();
  });
});

describe("TestGridClient.resolveJob", () => {
  it("finds a job's tab by name and confirms it by the table's GCS query", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(url);
      const path = url.replace("https://testgrid.k8s.io/", "");
      const body = path.endsWith("/summary")
        ? path.startsWith("sig-node-cri-o")
          ? { "ci-node-crio-eviction": {}, "other-tab": {} }
          : {}
        : { query: "kubernetes-ci-logs/logs/ci-node-crio-eviction", timestamps: [], tests: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const tg = new TestGridClient(new Cache(new MemoryStore()), fetchFn);
    expect(await tg.resolveJob("ci-node-crio-eviction")).toEqual({
      dashboard: "sig-node-cri-o",
      tab: "ci-node-crio-eviction",
    });
    expect(await tg.resolveJob("ci-unknown-job-name")).toBeNull();
    expect(calls.some((u) => u.includes("table?tab=ci-node-crio-eviction"))).toBe(true);
  });
});
