import { describe, expect, it } from "vitest";
import {
  decideTg,
  fragment,
  isTgDraft,
  jobFacts,
  junitFailures,
  prowLabels,
  titleQuery,
  signalLines,
  tgSteps,
  verdict,
  type JobFacts,
  type TgResult,
  type Track,
} from "../src/core/tgreview";
import type { TgTable } from "../src/core/testgrid";

const NOW = Date.parse("2026-09-26T12:00:00Z");
const DAY = 86_400_000;

describe("jobFacts", () => {
  const table: TgTable = {
    query: "kubernetes-ci-logs/logs/ci-node-e2e",
    timestamps: [NOW - DAY, NOW - 2 * DAY, NOW - 3 * DAY, NOW - 4 * DAY],
    column_ids: ["b4", "b3", "b2", "b1"],
    tests: [
      {
        name: "ci-node-e2e.Overall",
        statuses: [
          { count: 2, value: 12 },
          { count: 1, value: 1 },
          { count: 1, value: 12 },
        ],
      },
      {
        name: "kubetest.Node Tests",
        statuses: [
          { count: 2, value: 12 },
          { count: 2, value: 1 },
        ],
      },
      // FLAKY (13) and TIMED_OUT (9) cells are failures too.
      {
        name: "E2eNode Suite.[It] MirrorPod restarts",
        statuses: [
          { count: 1, value: 13 },
          { count: 1, value: 9 },
          { count: 2, value: 1 },
        ],
      },
      { name: "E2eNode Suite.[It] passes", statuses: [{ count: 4, value: 1 }] },
    ],
  };
  it("counts runs, the streak, and failing tests of every failure status, harness rows aside", () => {
    const f = jobFacts("d", "tab", "FLAKY", table, NOW);
    expect(f).toMatchObject({
      job: "ci-node-e2e",
      runs: 4,
      failed_runs: 3,
      streak: 2,
      first_failure_days_ago: 4,
      last_pass_days_ago: 3,
      harness_only: false,
      failed_builds: [
        { build: "b4", started: NOW - DAY },
        { build: "b3", started: NOW - 2 * DAY },
        { build: "b1", started: NOW - 4 * DAY },
      ],
    });
    expect(f.failing_tests).toEqual([{ name: "E2eNode Suite.[It] MirrorPod restarts", failed: 2 }]);
  });
  it("is harness-only when no test row fails", () => {
    const t = { ...table, tests: table.tests.filter((r) => !r.name.includes("MirrorPod")) };
    expect(jobFacts("d", "tab", "FAILING", t, NOW).harness_only).toBe(true);
  });
});

describe("junitFailures", () => {
  it("takes the test's name, not the suite's classname", () => {
    const xml = `<testsuite><testcase classname="E2eNode Suite" name="[It] [sig-node] MirrorPod &quot;x&quot;" time="1"><failure message="[FAILED] pod &lt;p&gt; not ready" type="failed">trace</failure></testcase><testcase classname="E2eNode Suite" name="passes"></testcase></testsuite>`;
    expect(junitFailures(xml)).toEqual([
      { test: '[It] [sig-node] MirrorPod "x"', message: "[FAILED] pod <p> not ready" },
    ]);
  });
});

describe("signalLines", () => {
  it("keeps Ginkgo's markers and summary, not the wrapper's traceback", () => {
    const log = [
      "I0926 kubelet started",
      "[FAILED] Timed out after 60s",
      '  File "/workspace/scenarios/kubernetes_e2e.py", line 57',
      "Summarizing 1 Failure:",
      "  [FAIL] [sig-node] MirrorPod restarts",
      "Ran 34 of 1267 Specs in 1470 seconds",
      "subprocess.CalledProcessError: Command kubetest returned non-zero exit status 1.",
    ].join("\n");
    const s = signalLines(log);
    expect(s).toContain("[FAILED] Timed out after 60s");
    expect(s).toContain("[FAIL] [sig-node] MirrorPod restarts");
    expect(s.some((l) => l.includes("CalledProcessError") || l.includes("File "))).toBe(false);
  });
  it("falls back to the job's last lines when no test ran", () => {
    const log = [
      "+ curl latest-1.33.txt",
      "<Error><Code>NoSuchKey</Code></Error>",
      "tar: Error is not recoverable",
      "+ atexit",
      "Deleting cluster",
    ].join("\n");
    expect(signalLines(log)).toEqual([
      "+ curl latest-1.33.txt",
      "<Error><Code>NoSuchKey</Code></Error>",
      "tar: Error is not recoverable",
    ]);
  });
});

describe("fragment", () => {
  it("drops bracketed tags and the suite name, keeping the longest run of words", () =>
    expect(
      fragment(
        "E2eNode Suite.[It] [sig-node] MirrorPod when kubelet restarts [Serial] should not change status",
      ),
    ).toBe("MirrorPod when kubelet restarts should not change status"));
});

const facts = (over: Partial<JobFacts> = {}): JobFacts => ({
  dashboard: "sig-node-containerd",
  tab: "ci-node-e2e",
  status: "FLAKY",
  job: "ci-node-e2e",
  gcs: "kubernetes-ci-logs/logs/ci-node-e2e",
  runs: 30,
  failed_runs: 2,
  streak: 0,
  first_failure_days_ago: 5,
  last_pass_days_ago: 0,
  failing_tests: [{ name: "E2eNode Suite.[It] MirrorPod restarts", failed: 2 }],
  harness_only: false,
  failed_builds: [],
  ...over,
});
const track = (number: number, p: number, over: Partial<Track> = {}): Track => ({
  repo: "kubernetes/kubernetes",
  number,
  title: "t",
  state: "open",
  url: "u",
  via: "job name",
  p,
  names_job: true,
  ...over,
});
const result = (f: Partial<JobFacts>, tracks: Track[]): TgResult => ({
  kind: "tg",
  facts: facts(f),
  evidence: [],
  failure_kind: null,
  tracks,
  usage: { input_tokens: 0, cost: 0 },
});

describe("decideTg", () => {
  it.each([
    ["tracked by an issue naming the job", result({}, [track(1, 0.9)]), "keep", true],
    [
      "tracked by an issue not naming the job",
      result({}, [track(1, 0.9, { names_job: false })]),
      "comment",
      true,
    ],
    ["only a closed issue matches", result({}, [track(1, 0.9, { state: "closed" })]), "file", false],
    ["maybe tracked", result({}, [track(1, 0.5)]), "comment", false],
    ["failing, untracked", result({ status: "FAILING" }, [track(1, 0.1)]), "file", true],
    ["flaky often, untracked", result({ failed_runs: 8 }, []), "file", false],
    ["flaky rarely, untracked", result({}, []), "keep", true],
  ] as [string, TgResult, string, boolean][])("%s -> %s", (_w, r, action, auto) =>
    expect(decideTg(r)).toMatchObject({ action, auto }),
  );
  it("prefers an open matching issue over a closed one that scores higher", () =>
    expect(verdict(result({}, [track(1, 0.95, { state: "closed" }), track(2, 0.7)]))).toMatchObject({
      verdict: "tracked",
      issue: { number: 2 },
    }));
});

describe("tgSteps", () => {
  it("drafts a comment and an issue this extension recognises as its own", () => {
    const r = result({ status: "FAILING" }, [track(7, 0.9, { names_job: false })]);
    const [c] = tgSteps(r, "comment");
    expect(c).toMatchObject({ kind: "comment", repo: "kubernetes/kubernetes", number: 7 });
    const [i] = tgSteps(r, "file");
    expect(i).toMatchObject({ kind: "issue", labels: ["kind/failing-test", "sig/node"] });
    expect(i?.kind === "issue" && i.title).toBe("[Failing Test] [It] MirrorPod restarts");
    for (const s of [c!, i!]) expect(isTgDraft(s.body)).toBe(true);
    expect(isTgDraft("/close")).toBe(false);
  });
});

import { Cache, MemoryStore } from "../src/core/cache";
import type { JevClient } from "../src/core/jev";
import { judgeTg, runEvidence, type TgDeps } from "../src/core/tgjudge";

describe("jobFacts without a GCS query", () => {
  it("names the job after its tab", () =>
    expect(jobFacts("d", "my-tab", "FAILING", { timestamps: [], tests: [] }, NOW).job).toBe("my-tab"));
});

describe("judgeTg", () => {
  const table: TgTable = {
    query: "kubernetes-ci-logs/logs/ci-node-e2e",
    timestamps: [NOW - DAY],
    column_ids: ["b1"],
    tests: [{ name: "ci-node-e2e.Overall", statuses: [{ count: 1, value: 12 }] }],
  };
  const issue = {
    number: 5,
    title: "MirrorPod flakes",
    state: "open" as const,
    html_url: "u",
    body: "about another job",
  };
  const deps = (text: string, fetchOk = true): TgDeps => ({
    table: async () => table,
    search: async (qs) => qs.map((_, i) => (i === 0 ? [issue] : [])),
    issueText: async () => text,
    jev: {
      askCached: async (_s: unknown, q: Record<string, unknown>) => ({
        answers:
          "tracks" in q
            ? { tracks: { type: "noul", noul: 0.9 } }
            : { failure_kind: { type: "choice", choice: "test_failure", confidence: 1, probabilities: {} } },
        usage: { input_tokens: 0, cost: 0, cached: true },
      }),
    } as unknown as JevClient,
    cache: new Cache(new MemoryStore()),
    fetchFn: (async (u: string) =>
      !fetchOk
        ? new Response("", { status: 429 })
        : u.includes("/storage/v1/")
          ? new Response('{"items":[]}')
          : u.endsWith("finished.json")
            ? new Response('{"result":"FAILURE"}')
            : new Response("[FAILED] x\nRan 1 of 2 Specs")) as unknown as typeof fetch,
  });
  it("reads the tracking issue's comments, so a job already added there is not commented again", async () => {
    const r = await judgeTg(
      deps("body\nThis also fails on `ci-node-e2e`"),
      { dashboard: "d", tab: "ci-node-e2e" },
      "FAILING",
      false,
      NOW,
    );
    expect(r.tracks[0]).toMatchObject({ number: 5, names_job: true });
    expect(decideTg(r).action).toBe("keep");
    const r2 = await judgeTg(
      deps("body only"),
      { dashboard: "d", tab: "ci-node-e2e" },
      "FAILING",
      false,
      NOW,
    );
    expect(decideTg(r2).action).toBe("comment");
  });
  it("does not keep evidence a failed read left incomplete", async () => {
    const d = deps("", false);
    const e = await runEvidence(d, "b/logs/j", "1", NOW);
    expect(e.log_signals).toBeNull();
    expect(await d.cache.get("tgrun:b/logs/j/1", DAY)).toBeUndefined();
    const ok = deps("");
    await runEvidence(ok, "b/logs/j", "1", NOW);
    expect(await ok.cache.get("tgrun:b/logs/j/1", DAY)).toBeDefined();
  });
});

describe("writes with test mode off", () => {
  it("keeps the title search within GitHub's query limit, without quotes it cannot escape", () => {
    const long = `[Flaking Test] [It] [sig-node] a "quoted" step ${"with a very long name ".repeat(12)}`;
    const q = titleQuery("kubernetes/kubernetes", long);
    expect(q.length + " sort:updated-desc".length).toBeLessThanOrEqual(256);
    expect(q).toMatch(
      /^repo:kubernetes\/kubernetes is:issue is:open in:title "\[Flaking Test\] \[It\] .* a quoted step /,
    );
    expect(q.slice(q.indexOf('"') + 1, -1)).not.toContain('"');
  });
  it("sets labels through Prow", () =>
    expect(prowLabels(["kind/flake", "sig/node"])).toBe("/kind flake\n/sig node"));
});
