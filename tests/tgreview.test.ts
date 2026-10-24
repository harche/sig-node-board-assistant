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
  uniqueFailures,
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
  it("lists every failing test row, not the first dozen", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      name: `E2eNode Suite.[It] t${i}`,
      statuses: [{ count: 4, value: 12 }],
    }));
    expect(
      jobFacts("d", "tab", "FAILING", { ...table, tests: [...table.tests, ...rows] }, NOW).failing_tests,
    ).toHaveLength(31);
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
  it("keeps a message's lines, up to 3000 characters", () => {
    const diff = `[FAILED] Expected&#xA;    &lt;int&gt;: 1&#xA;to equal&#xA;    &lt;int&gt;: 2&#xA;${"x".repeat(2000)}`;
    const [f] = junitFailures(`<testcase name="t"><failure message="${diff}"></failure></testcase>`);
    expect(f!.message.startsWith("[FAILED] Expected\n    <int>: 1\nto equal\n    <int>: 2\n")).toBe(true);
    expect(f!.message.endsWith("x".repeat(2000))).toBe(true);
    const [g] = junitFailures(
      `<testcase name="t"><failure message="${"y".repeat(5000)}"></failure></testcase>`,
    );
    expect(g!.message).toHaveLength(3000);
  });
  it("keeps a long Go test's --- FAIL and assertion lines, not only its leading === RUN output", () => {
    const out = [
      "=== RUN TestReconcile",
      ...Array.from(
        { length: 200 },
        (_, i) => `    reconcile_test.go:40: step ${i} of the setup went fine as expected`,
      ),
      "    reconcile_test.go:88: expected 3 pods, got 2",
      "        diff: -want +got",
      "--- FAIL: TestReconcile (12.3s)",
      "FAIL",
    ].join("&#xA;");
    const [f] = junitFailures(
      `<testcase classname="k8s.io/kubernetes/pkg/kubelet" name="kubelet"><failure message="Failed">${out}</failure></testcase>`,
    );
    expect(f!.message.length).toBeLessThanOrEqual(3000);
    expect(f!.message).toContain("reconcile_test.go:88: expected 3 pods, got 2");
    expect(f!.message).toContain("diff: -want +got");
    expect(f!.message).toContain("--- FAIL: TestReconcile (12.3s)");
  });
  it("counts a case reported in two junit files once", () => {
    const a = { test: "t", message: "m" };
    expect(uniqueFailures([a, { ...a }, { test: "t", message: "other" }])).toHaveLength(2);
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
  it("keeps the summary and how the run ended when early failures alone are over the cap", () => {
    const early = Array.from({ length: 400 }, (_, i) => [
      `[FAILED] pod ${"p".repeat(i % 7)} not ready in test number ${"n".repeat(i % 5)}`,
      `Expected <bool>: false to be true, case ${String.fromCharCode(97 + (i % 26)).repeat(i % 9)}`,
    ]).flat();
    const log = [
      ...early,
      "Summarizing 2 Failures:",
      "  [FAIL] [sig-node] MirrorPod restarts",
      "  test/e2e_node/mirror_pod_test.go:120",
      "  [TIMEDOUT] [sig-node] Probing container",
      "  test/e2e/common/node/container_probe.go:88",
      "Ran 34 of 1267 Specs in 1470 seconds",
      "FAIL! -- 32 Passed | 2 Failed | 0 Pending | 1233 Skipped",
      "[TIMEDOUT] A suite timeout occurred",
    ].join("\n");
    const s = signalLines(log, 600);
    expect(s).toContain("Summarizing 2 Failures:");
    expect(s).toContain("[TIMEDOUT] [sig-node] Probing container");
    expect(s).toContain("Ran 34 of 1267 Specs in 1470 seconds");
    expect(s).toContain("[TIMEDOUT] A suite timeout occurred");
    expect(s.some((l) => /^… \d+ more signal lines/.test(l))).toBe(true);
    expect(s[0]).toMatch(/^\[FAILED\] pod/);
  });
  it("takes the lines after a [FAILED] marker, where Gomega's diff is", () => {
    const log = [
      "[FAILED] Timed out after 300s.",
      "Expected",
      "    <string>: Pending",
      "to equal",
      "    <string>: Running",
      "In [It] at: test/e2e_node/resize_test.go:77",
      "Full Stack Trace",
      "I0926 unrelated kubelet line much later",
    ].join("\n");
    expect(signalLines(log)).toEqual([
      "[FAILED] Timed out after 300s.",
      "Expected",
      "<string>: Pending",
      "to equal",
      "<string>: Running",
      "In [It] at: test/e2e_node/resize_test.go:77",
      "Full Stack Trace",
    ]);
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
  it("among several open tracking issues, goes by the one Jev reads as the main one", () => {
    const r = {
      ...result({}, [
        track(1, 0.95, { names_job: false }),
        track(2, 0.8, { names_job: false }),
        track(3, 0.5, { names_job: false }),
      ]),
      canonical: { repo: "kubernetes/kubernetes", number: 2, p: 0.8 },
    };
    expect(verdict(r)).toEqual({ verdict: "tracked", issue: expect.objectContaining({ number: 2 }) });
    expect(decideTg(r)).toMatchObject({ action: "comment", auto: true });
  });
  it("keeps to a tracking issue that already names the job over a main one that does not", () => {
    const tracks = [track(1, 0.95, { names_job: false }), track(2, 0.8, { names_job: true })];
    const r = { ...result({}, tracks), canonical: { repo: "kubernetes/kubernetes", number: 1, p: 0.9 } };
    expect(verdict(r)).toEqual({ verdict: "tracked", issue: expect.objectContaining({ number: 2 }) });
    expect(decideTg(r)).toMatchObject({ action: "keep" });
    expect(verdict({ ...result({}, tracks), canonical: null })).toEqual({
      verdict: "tracked",
      issue: expect.objectContaining({ number: 2 }),
    });
  });
  it("leaves it to the reader when Jev names no main one among several tracking issues", () => {
    const r = {
      ...result({}, [track(1, 0.95, { names_job: false }), track(2, 0.8, { names_job: false })]),
      canonical: null,
    };
    expect(verdict(r)).toMatchObject({ verdict: "tracked", issue: { number: 1 }, unsure: true });
    expect(decideTg(r)).toMatchObject({ action: "comment", auto: false });
    expect(decideTg(r).why).toContain("2 open issues track it and none is clearly the main one");
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

import type { JevClient } from "../src/core/jev";
import { fitRuns, judgeTg, relatedRuns, runEvidence, withIssue, type TgDeps } from "../src/core/tgjudge";
import { MAX_STATE_CHARS, size } from "../src/core/fit";
import type { ThreadIssue } from "../src/core/github";
import { POOL_MAX } from "../src/core/tgreview";

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
    issueText: async () => text.split("\n"),
    jev: {
      ask: async (s: { issue?: { thread?: string } }, q: Record<string, unknown>) => ({
        answers:
          "tracks" in q
            ? { tracks: { type: "noul", noul: 0.9 } }
            : "names_job" in q
              ? { names_job: { type: "noul", noul: s.issue?.thread?.includes("ci-node-e2e") ? 0.95 : 0.05 } }
              : {
                  failure_kind: { type: "choice", choice: "test_failure", confidence: 1, probabilities: {} },
                },
        usage: { input_tokens: 0, cost: 0 },
      }),
    } as unknown as JevClient,
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
      NOW,
    );
    expect(r.tracks[0]).toMatchObject({ number: 5, names_job: true });
    expect(decideTg(r).action).toBe("keep");
    const r2 = await judgeTg(deps("body only"), { dashboard: "d", tab: "ci-node-e2e" }, "FAILING", NOW);
    expect(decideTg(r2).action).toBe("comment");
    expect(r.readings?.map((x) => x.label)).toContain("#5 already names the job");
  });
  /** Jev, recording each question's state; `answer` by question id. */
  const recorder = (answer: (id: string, s: Record<string, unknown>) => unknown) => {
    const asked: { id: string; s: Record<string, unknown> }[] = [];
    const jev = {
      ask: async (s: Record<string, unknown>, q: Record<string, unknown>) => {
        const id = Object.keys(q)[0]!;
        asked.push({ id, s });
        return { answers: { [id]: answer(id, s) }, usage: { input_tokens: 0, cost: 0 } };
      },
    } as unknown as JevClient;
    return { asked, jev };
  };
  const thread = (number: number, comments: ThreadIssue["comments"]): ThreadIssue => ({
    number,
    title: `#${number}`,
    body: "body",
    state: "open",
    created_at: "2026-09-01T00:00:00Z",
    closed_at: null,
    url: "u",
    author: "a",
    labels: [],
    comments,
  });
  const noul = (p: number) => ({ type: "noul", noul: p });
  it("sends names_job the whole thread, however long", async () => {
    const { asked, jev } = recorder((id) => (id === "failure_kind" ? null : noul(0.9)));
    const filler = (i: number) => `comment ${i} ${"words ".repeat(600)}`;
    const comments = [...Array.from({ length: 4 }, (_, i) => filler(i)), "This also fails on `ci-node-e2e`"];
    comments.push(...Array.from({ length: 6 }, (_, i) => filler(10 + i)));
    await judgeTg(
      { ...deps(""), issueText: async () => ["body", ...comments], jev },
      { dashboard: "d", tab: "ci-node-e2e" },
      "FAILING",
      NOW,
    );
    const t = (asked.find((a) => a.id === "names_job")!.s.issue as { thread: string }).thread;
    expect(t.length).toBeGreaterThan(16000);
    expect(t).toContain("This also fails on `ci-node-e2e`");
    expect(t).toContain(filler(0));
    expect(t).toContain(filler(15));
  });
  it("reads each candidate's whole thread, people's comments only, and the job's status, history and runs", async () => {
    const { asked, jev } = recorder((id) => (id === "failure_kind" ? null : noul(0.1)));
    const long = `I bisected it: ${"x".repeat(5000)}`;
    await judgeTg(
      {
        ...deps(""),
        jev,
        threads: async (_r, ns) =>
          new Map(
            ns.map((n) => [
              n,
              thread(n, [
                { author: "k8s-triage-robot", body: "The issue has been marked stale", created_at: "t" },
                { author: "alice", body: long, created_at: "t" },
              ]),
            ]),
          ),
      },
      { dashboard: "d", tab: "ci-node-e2e" },
      "FAILING",
      NOW,
    );
    const s = asked.find((a) => a.id === "tracks")!.s as {
      issue: { comments: { author: string; body: string }[] };
      status: string;
      history: { runs: number; failed_runs: number };
      runs: { build: string; result: string; junit_total: number }[];
    };
    expect(s.issue.comments).toEqual([{ author: "alice", body: long, created_at: "t" }]);
    expect(s.status).toBe("FAILING");
    expect(s.history).toMatchObject({ runs: 1, failed_runs: 1, failed_in_a_row: 1, harness_only: true });
    expect(s.runs[0]).toMatchObject({ build: "b1", result: "FAILURE", junit_total: 0 });
  });
  it("asks which of two strong tracking issues is the main one, and goes by Jev's answer", async () => {
    const two = [
      { ...issue, number: 5, title: "MirrorPod flakes (old)" },
      { ...issue, number: 6, title: "MirrorPod flakes" },
    ];
    const { asked, jev } = recorder((id) =>
      id === "canonical"
        ? { type: "choice", choice: "c1", confidence: 0.8, probabilities: { c0: 0.15, c1: 0.8, none: 0.05 } }
        : id === "failure_kind"
          ? null
          : noul(0.9),
    );
    const r = await judgeTg(
      {
        ...deps(""),
        search: async (qs) => qs.map((_, i) => (i === 0 ? two : [])),
        jev,
        threads: async (_r, ns) =>
          new Map(
            ns.map((n) => [
              n,
              thread(n, n === 5 ? [{ author: "bob", body: "Closing in favour of #6", created_at: "t" }] : []),
            ]),
          ),
      },
      { dashboard: "d", tab: "ci-node-e2e" },
      "FAILING",
      NOW,
    );
    const q = asked.filter((a) => a.id === "canonical");
    expect(q).toHaveLength(1);
    const issues = q[0]!.s.issues as { key: string; number: number; comments: { body: string }[] }[];
    expect(issues.map((i) => [i.key, i.number])).toEqual([
      ["c0", 5],
      ["c1", 6],
    ]);
    expect(issues[0]!.comments[0]!.body).toBe("Closing in favour of #6");
    expect(r.canonical).toEqual({ repo: "kubernetes/kubernetes", number: 6, p: 0.8 });
    expect(verdict(r).issue?.number).toBe(6);
    expect(r.readings?.find((x) => x.label === "Main tracking issue")).toEqual({
      label: "Main tracking issue",
      probabilities: { "#5": 0.15, "#6": 0.8, "none clearly": 0.05 },
    });
  });
  it("does not ask for a main issue when only one candidate tracks it", async () => {
    const { asked, jev } = recorder((id) => (id === "failure_kind" ? null : noul(0.9)));
    const r = await judgeTg({ ...deps(""), jev }, { dashboard: "d", tab: "ci-node-e2e" }, "FAILING", NOW);
    expect(asked.some((a) => a.id === "canonical")).toBe(false);
    expect(r.canonical).toBeUndefined();
  });
  it("keeps a finished run's evidence, but reads a failed read again", async () => {
    let n = 0;
    const counted = (ok: boolean): TgDeps => {
      const d = deps("", ok);
      const f = d.fetchFn!;
      return { ...d, fetchFn: ((u: string) => (n++, f(u))) as unknown as typeof fetch };
    };
    expect((await runEvidence(counted(false), "b/logs/kept", "1", NOW)).log_signals).toBeNull();
    expect((await runEvidence(counted(true), "b/logs/kept", "1", NOW)).log_signals).not.toBeNull();
    const reads = n;
    expect((await runEvidence(counted(true), "b/logs/kept", "1", NOW)).log_signals).not.toBeNull();
    expect(n).toBe(reads);
  });
  it("reads a presubmit run where its pr-logs/directory pointer says", async () => {
    const seen: string[] = [];
    const d = (pointer: string | null): TgDeps => ({
      ...deps(""),
      fetchFn: (async (u: string) => {
        seen.push(u);
        if (/\/b\/pr-logs\/directory\/j\/\d+\.txt$/.test(u))
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
    expect((await runEvidence(d(null), "b/pr-logs/directory/j", "2", NOW)).log_signals).toBeNull();
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
  it("reads the whole umbrella pool, page by page, and each candidate's whole thread", async () => {
    const asked: Record<string, unknown>[] = [];
    const ns: number[] = [];
    const out = await relatedRuns(
      {
        table: async () => ({ timestamps: [], tests: [] }),
        issueText: async () => [],
        jev: {} as JevClient,
        search: async (qs, n) => {
          ns.push(n ?? 10);
          return qs.map((q) =>
            typeof q === "string" && q.includes("label:kind/flake")
              ? [{ number: 77, title: "u", state: "open", html_url: "u" }]
              : [],
          );
        },
        threads: async (_r, nums) =>
          new Map(
            nums.map((n) => [
              n,
              {
                number: n,
                title: "Probe tests are flaking often on some jobs",
                body: "umbrella",
                state: "open" as const,
                created_at: "t",
                closed_at: null,
                url: "u",
                author: "a",
                labels: [],
                comments: [{ author: "carol", body: "Also seen in MirrorPod restarts", created_at: "t" }],
              },
            ]),
          ),
      },
      facts(),
      { job: "ci-node-e2e", runs: [] },
      [{ build: "1", started: 0, url: "u", result: null, junit_failures: [], log_signals: ["[FAILED] x"] }],
      new Set(),
      [],
      async <A>(s: unknown, q: Record<string, unknown>) => {
        asked.push(s as Record<string, unknown>);
        return (
          "relation" in q ? { relation: { probabilities: { umbrella: 0.8 } } } : { covers: { noul: 0.7 } }
        ) as A;
      },
      now,
    );
    expect(ns).toContain(POOL_MAX);
    expect(out.map((r) => [r.number, r.kind])).toEqual([[77, "umbrella"]]);
    expect((asked[0]!.issue as { comments: { body: string }[] }).comments[0]!.body).toBe(
      "Also seen in MirrorPod restarts",
    );
  });
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

describe("states that would outgrow Jev's context", () => {
  it("drop a 2,000-comment thread's oldest comments after the first, and say so", () => {
    const comments = Array.from({ length: 2000 }, (_, i) => ({
      author: `u${i}`,
      created_at: "t",
      body: `${i} ${"c".repeat(1000)}`,
    }));
    const st = withIssue(
      { job: "j", runs: [] },
      { number: 1, title: "t", state: "open", body: "b" },
      comments,
    );
    const kept = (st.issue as { comments: { author: string; body: string }[] }).comments;
    expect(size(st)).toBeLessThanOrEqual(MAX_STATE_CHARS);
    expect(size(st)).toBeGreaterThan(MAX_STATE_CHARS - 2000);
    expect(kept[0]!.author).toBe("u0");
    expect(kept[1]!.body).toMatch(/^\(\d+ comments left out here/);
    expect(kept.at(-1)!.author).toBe("u1999");
  });
  it("keep a broken build's first junit failures, junit_total counting them all", () => {
    const run = {
      junit_total: 600,
      junit_failures: Array.from({ length: 600 }, (_, i) => ({ test: `t${i}`, message: "m".repeat(3000) })),
      log_signals: ["[FAILED] x"],
    };
    const [r] = fitRuns([run, run, run]);
    expect(size(r)).toBeLessThanOrEqual(200_000 / 3);
    expect(r!.junit_total).toBe(600);
    expect(r!.junit_failures[0]!.test).toBe("t0");
    expect(r!.junit_failures.at(-1)!.test).toMatch(/^\(\d+ more failures left out/);
    expect(r!.log_signals).toEqual(["[FAILED] x"]);
  });
});
