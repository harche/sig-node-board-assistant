import { describe, expect, it } from "vitest";
import {
  decideTg,
  fragment,
  isTgDraft,
  namesWhole,
  jobFacts,
  junitFailures,
  prowLabels,
  relatedEligible,
  relatedQueries,
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
  it("cuts a first word over 60 characters", () =>
    expect(fragment(`${"x".repeat(80)} b c`)).toBe("x".repeat(60)));
  it("cuts a long name at a word, since a quoted search for half a word finds nothing", () =>
    expect(
      fragment(
        "[It] Probing container should not be restarted with a non-local redirect http liveness probe",
      ),
    ).toBe("Probing container should not be restarted with a non-local"));
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
    ["maybe tracked", result({}, [track(1, 0.5, { names_job: false })]), "comment", false],
    ["failing, untracked", result({ status: "FAILING" }, [track(1, 0.1)]), "file", true],
    ["flaky often, untracked", result({ failed_runs: 8 }, []), "file", false],
    ["flaky rarely, untracked", result({}, []), "keep", true],
  ] as [string, TgResult, string, boolean][])("%s -> %s", (_w, r, action, auto) =>
    expect(decideTg(r)).toMatchObject({ action, auto }),
  );
  it("among open tracking issues none of which names the job, picks the one with the most recent activity", () =>
    expect(
      verdict(
        result({}, [
          track(1, 0.95, { names_job: false, updated_at: "2026-08-01T00:00:00Z" }),
          track(2, 0.8, { names_job: false, updated_at: "2026-09-20T00:00:00Z" }),
          track(3, 0.5, { names_job: false, updated_at: "2026-09-28T00:00:00Z" }),
        ]),
      ).issue?.number,
    ).toBe(2));
  it("keeps an open tracking issue that already names the job over a more recent one that does not", () => {
    const r = result({}, [
      track(1, 0.95, { names_job: true, updated_at: "2026-08-01T00:00:00Z" }),
      track(2, 0.8, { names_job: false, updated_at: "2026-09-20T00:00:00Z" }),
    ]);
    expect(verdict(r).issue?.number).toBe(1);
    expect(decideTg(r)).toMatchObject({ action: "keep", auto: true });
  });
  it("does not suggest a comment on a maybe-tracking issue that already names the job", () =>
    expect(decideTg(result({}, [track(1, 0.5)]))).toMatchObject({ action: "keep", auto: false }));
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
    expect(c).toMatchObject({
      kind: "comment",
      repo: "kubernetes/kubernetes",
      number: 7,
      names: ["ci-node-e2e"],
    });
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
      askCached: async (s: { issue?: { thread?: string } }, q: Record<string, unknown>) => ({
        answers:
          "tracks" in q
            ? { tracks: { type: "noul", noul: 0.9 } }
            : "names_job" in q
              ? { names_job: { type: "noul", noul: s.issue?.thread?.includes("ci-node-e2e") ? 0.95 : 0.05 } }
              : {
                  failure_kind: { type: "choice", choice: "test_failure", confidence: 1, probabilities: {} },
                },
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
  it("asks Jev whether the tracking issue's thread already names the job, so it is not commented again", async () => {
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
    expect(r.readings?.map((x) => x.label)).toContain("#5 already names the job");
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
  it("reads a presubmit run where its pr-logs/directory pointer says", async () => {
    const seen: string[] = [];
    const d = (pointer: string | null): TgDeps => ({
      ...deps(""),
      fetchFn: (async (u: string) => {
        seen.push(u);
        if (u.endsWith("/b/pr-logs/directory/j/1.txt"))
          return pointer === null ? new Response("", { status: 404 }) : new Response(pointer);
        if (u.includes("/pr-logs/directory/")) return new Response("", { status: 404 });
        if (u.includes("/storage/v1/")) return new Response('{"items":[]}');
        if (u.endsWith("finished.json")) return new Response('{"result":"FAILURE"}');
        return new Response("[FAILED] x\nRan 1 of 2 Specs");
      }) as unknown as typeof fetch,
    });
    const e = await runEvidence(d("gs://b/pr-logs/pull/9/j/1\n"), "b/pr-logs/directory/j", "1", NOW);
    expect(e).toMatchObject({ result: "FAILURE", url: "https://prow.k8s.io/view/gs/b/pr-logs/pull/9/j/1" });
    expect(e.log_signals).not.toBeNull();
    expect(seen).toContain("https://storage.googleapis.com/b/pr-logs/pull/9/j/1/build-log.txt");
    const none = d(null);
    expect((await runEvidence(none, "b/pr-logs/directory/j", "1", NOW)).log_signals).toBeNull();
    expect(await none.cache.get("tgrun:b/pr-logs/directory/j/1", DAY)).toBeUndefined();
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

describe("related issues", () => {
  const now = Date.parse("2026-09-26T00:00:00Z");
  it("reads open issues, and root causes closed in the last 60 days", () => {
    expect(relatedEligible("open", null, now)).toBe(true);
    expect(relatedEligible("closed", "2026-08-30T00:00:00Z", now)).toBe(true);
    expect(relatedEligible("closed", "2026-06-01T00:00:00Z", now)).toBe(false);
  });
  it("searches the failure's own words: its strings verbatim, each test by name, and the test with its error", () => {
    const qs = relatedQueries(
      "kubernetes/kubernetes",
      [
        {
          junit_failures: [
            { test: "Node Tests", message: "error during go run run_remote.go" },
            { test: "t", message: 'pod "p" not ready: GetVfsStats timed out' },
          ],
          log_signals: [],
        },
      ],
      ["E2eNode Suite.[It] [sig-node] Probing container restarts"],
      "ci-node-e2e",
      () => ["GetVfsStats"],
    );
    expect(qs[0]).toBe('repo:kubernetes/kubernetes is:issue "GetVfsStats"');
    expect(qs[1]).toEqual({
      q: "repo:kubernetes/kubernetes is:issue Probing container restarts",
      type: "ISSUE_SEMANTIC",
    });
    // The harness's "Node Tests" row is not the error.
    expect(qs[2]).toEqual({
      q: "repo:kubernetes/kubernetes is:issue Probing container restarts pod p not ready: GetVfsStats timed out",
      type: "ISSUE_SEMANTIC",
    });
    expect(qs[3]).toMatchObject({ type: "ISSUE_HYBRID" });
  });
});

describe("namesWhole", () => {
  it("matches a whole job name, not a prefix of a longer one", () => {
    expect(namesWhole("also flakes on `ci-kubernetes-node-e2e` (TestGrid)", "ci-kubernetes-node-e2e")).toBe(
      true,
    );
    expect(namesWhole("seen on ci-kubernetes-node-e2e.", "ci-kubernetes-node-e2e")).toBe(true);
    expect(namesWhole("on ci-kubernetes-node-e2e-containerd", "ci-kubernetes-node-e2e")).toBe(false);
    expect(namesWhole("pull-ci-kubernetes-node-e2e", "ci-kubernetes-node-e2e")).toBe(false);
    expect(namesWhole("job a.b+c ran", "a.b+c")).toBe(true);
  });
});
