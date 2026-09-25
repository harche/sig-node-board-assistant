/** TestGrid's JSON endpoints (no UI), ported from the reference implementation's lib/testgrid.py: per-dashboard
 *  summaries and per-tab tables. Used to tell whether the test an issue tracks still fails, so Jev reads run
 *  history computed by code rather than a commenter's "seems green now". TestGrid keeps about two weeks of runs. */
import { type Cache, MINUTE } from "./cache";

export const TESTGRID = "https://testgrid.k8s.io";

/** The in-tree SIG Node dashboard group (test-infra config/testgrids/kubernetes/sig-node) and the release
 *  dashboards node tests also run on. Searched, in order, to find the tab of a job an issue names only by name. */
export const DASHBOARDS = [
  "sig-node-release-blocking",
  "sig-node-kubelet",
  "sig-node-containerd",
  "sig-node-cri-o",
  "sig-node-dynamic-resource-allocation",
  "sig-node-presubmits",
  "sig-node-ec2",
  "sig-node-gpu",
  "sig-release-master-blocking",
  "sig-release-master-informing",
];

/** TestGrid TestStatus cell values that count as a failure: 9 TIMED_OUT, 10 CATEGORIZED_FAIL, 11 BUILD_FAIL,
 *  12 FAIL, 13 FLAKY (failed, then passed on retry), 14 TOOL_FAIL. */
const FAIL = new Set([9, 10, 11, 12, 13, 14]);
/** Cells that say nothing either way: 0 NO_RESULT (the test did not run), 4 RUNNING (often the newest column),
 *  5 CATEGORIZED_ABORT, 7 CANCEL, 8 BLOCKED. Everything else (the PASS variants, UNKNOWN) is a non-failing result. */
const NO_RESULT = 0;
const SILENT = new Set([NO_RESULT, 4, 5, 7, 8]);

export interface TgRef {
  dashboard: string;
  tab: string;
}

export interface TgRow {
  name: string;
  statuses: { count: number; value: number }[];
  messages?: string[];
}

export interface TgTable {
  query?: string;
  /** Run start times in ms, newest first; one per column. */
  timestamps: number[];
  tests: TgRow[];
}

export type TgSummary = Record<string, { overall_status?: string; dashboard_name?: string }>;

/** Only what the signal needs from a table: TestGrid's own carries messages, metrics and per-cell ids too. */
function compact(t: TgTable): TgTable {
  return {
    query: t.query,
    timestamps: t.timestamps ?? [],
    tests: (t.tests ?? []).map((r) => ({ name: r.name, statuses: r.statuses })),
  };
}

/** What the code knows about one test on one job, over the runs TestGrid still has. */
export interface TestSignal {
  job: string;
  tab: string;
  dashboard: string;
  test: string;
  /** Runs in the window that ran this test. */
  runs: number;
  failures: number;
  window_days: number;
  /** null when the test did not fail in the window. */
  last_failure_days_ago: number | null;
  runs_since_last_failure: number;
  last_run_days_ago: number | null;
  runs_after_fix?: number;
  failures_after_fix?: number;
}

/** An issue body's TestGrid tabs and Prow job names, as written. */
export function refsFrom(text: string): { tabs: TgRef[]; jobs: string[] } {
  const tabs = new Map<string, TgRef>();
  for (const m of text.matchAll(/testgrid\.k8s\.io\/([\w-]+)#([^\s&)>"'`\]]+)/g)) {
    const ref = { dashboard: m[1]!, tab: safeDecode(m[2]!) };
    tabs.set(`${ref.dashboard}#${ref.tab}`, ref);
  }
  const jobs = new Set<string>();
  // prow.k8s.io/view/gs/<bucket>/logs/<job>/<build>, .../pr-logs/pull/[<org>_<repo>/]<pr>/<job>/<build>, job-history/...
  for (const m of text.matchAll(
    /prow\.k8s\.io\/(?:view|job-history)\/gs\/[\w.-]+\/(?:logs|pr-logs\/pull\/(?:[\w.-]+_[\w.-]+\/)?\d+)\/([\w.-]+)/g,
  ))
    jobs.add(m[1]!);
  for (const m of text.matchAll(/\b((?:ci|pull)-[a-z0-9]+(?:-[a-z0-9.]+){2,})\b/g)) jobs.add(m[1]!);
  return { tabs: [...tabs.values()], jobs: [...jobs] };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const TEST_SECTION = /###\s*Which tests are (?:flaking|failing)\??[^\n]*\n([\s\S]*?)(?=\n###|$)/i;
const TITLE_TAGS =
  /^\s*(?:\[(?:flak\w*|failing)[^\]]*\]\s*|failure cluster \[[^\]]*\]\s*|failing test:?\s*)+/i;

/** Test names an issue tracks: the "Which tests are flaking/failing?" section of the issue template, else the
 *  title without its [Flaking Test] / [Failing Test] tags. */
export function testsFrom(title: string, body: string): string[] {
  const sec = TEST_SECTION.exec(body)?.[1] ?? "";
  const lines = sec
    .split("\n")
    .map((l) =>
      l
        .replace(/^[\s>*-]*(?:\d+\.\s*)?/, "")
        .replace(/[`]/g, "")
        .trim(),
    )
    .filter((l) => l.length >= 8 && !/^(?:_?no response_?|n\/a|none)$/i.test(l) && !/^https?:\/\//.test(l));
  if (lines.length) return lines.slice(0, 8);
  const t = title.replace(TITLE_TAGS, "").replace(/`/g, "").trim();
  return t ? [t] : [];
}

const STOP = new Set([
  "should",
  "the",
  "and",
  "with",
  "when",
  "for",
  "that",
  "test",
  "tests",
  "sig-node",
  "it",
  "suite",
]);
/** Lower-case, drop the suite prefix TestGrid adds ("Kubernetes e2e suite.[It] ", "E2eNode Suite.[It] "). */
export function normTest(s: string): string {
  return s
    .toLowerCase()
    .replace(/^.*?suite\.\s*(?:\[it\]\s*)?/, "")
    .replace(/\s+/g, " ")
    .trim();
}
const tokens = (s: string) =>
  new Set(
    normTest(s)
      .split(/[\s[\]():,."'`]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  );

const HARNESS = /(\.Overall$|^Overall$|^kubetest2?\.|^Test$|Node Tests$)/;

/** Rows of `tbl` that are the test `want` names: containment either way (a harness row such as kubetest.Timeout
 *  only when `want` names it in full), else at least 70% of `want`'s words. */
export function matchRows(tbl: TgTable, want: string): TgRow[] {
  const w = normTest(want);
  if (!w) return [];
  const exact = tbl.tests.filter((r) => {
    const n = normTest(r.name);
    if (HARNESS.test(r.name)) return n.length >= 8 && w.includes(r.name.toLowerCase());
    return n.includes(w) || (n.length >= 20 && w.includes(n));
  });
  if (exact.length) return exact;
  const wt = tokens(want);
  if (wt.size < 2) return [];
  const scored = tbl.tests
    .filter((r) => !HARNESS.test(r.name))
    .map((r) => {
      const rt = tokens(r.name);
      let hit = 0;
      for (const t of wt) if (rt.has(t)) hit++;
      return { r, s: hit / wt.size };
    })
    .filter((x) => x.s >= 0.7)
    .sort((a, b) => b.s - a.s);
  return scored.length ? scored.filter((x) => x.s === scored[0]!.s).map((x) => x.r) : [];
}

/** The job-level row TestGrid adds to every tab ("<job>.Overall" or "Overall"): did the run as a whole pass. */
export function overallRow(tbl: TgTable): TgRow | undefined {
  return tbl.tests.find((r) => /(^|\.)Overall$/.test(r.name));
}

/** Run-length `statuses` expanded to one value per column, newest first. */
export function cells(row: TgRow, n: number): number[] {
  const out: number[] = [];
  for (const s of row.statuses) for (let i = 0; i < s.count && out.length < n; i++) out.push(s.value);
  while (out.length < n) out.push(NO_RESULT);
  return out;
}

const DAY_MS = 86_400_000;

/** One row's history. `asOf` (ms) drops the columns that started after it, to see a closed issue as it stood
 *  before it was closed. `since` (ms), when given, also counts the runs and failures from then on: the runs
 *  after a fix merged. */
export function rowSignal(tbl: TgTable, row: TgRow, ref: TgRef, asOf: number, since?: number): TestSignal {
  const all = cells(row, tbl.timestamps.length);
  const keep = tbl.timestamps.map((t, i) => [t, all[i]!] as const).filter(([t]) => t < asOf);
  const res = keep.filter(([, v]) => !SILENT.has(v));
  const failIdx = res.findIndex(([, v]) => FAIL.has(v));
  const days = (t: number) => Math.floor((asOf - t) / DAY_MS);
  const out: TestSignal = {
    job: tbl.query?.split("/").pop() ?? ref.tab,
    tab: ref.tab,
    dashboard: ref.dashboard,
    test: normTest(row.name),
    runs: res.length,
    failures: res.filter(([, v]) => FAIL.has(v)).length,
    window_days: keep.length ? Math.round((asOf - keep[keep.length - 1]![0]) / DAY_MS) : 0,
    last_failure_days_ago: failIdx >= 0 ? days(res[failIdx]![0]) : null,
    runs_since_last_failure: failIdx >= 0 ? failIdx : res.length,
    last_run_days_ago: res.length ? days(res[0]![0]) : null,
  };
  // Only when TestGrid still has runs from before `since`; otherwise every run in the window is "after".
  if (since !== undefined && keep.length && keep[keep.length - 1]![0] < since) {
    const after = res.filter(([t]) => t >= since);
    out.runs_after_fix = after.length;
    out.failures_after_fix = after.filter(([, v]) => FAIL.has(v)).length;
  }
  return out;
}

/** Candidate tab names for a Prow job: TestGrid tabs are usually the job name, sometimes with its ci-kubernetes-
 *  / ci- / pull-kubernetes- prefix dropped. */
function tabGuesses(job: string): string[] {
  const g = [job];
  for (const p of ["ci-kubernetes-", "ci-", "pull-kubernetes-"])
    if (job.startsWith(p)) g.push(job.slice(p.length));
  return g;
}

export class TestGridClient {
  constructor(
    private cache: Cache,
    private fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {}

  private async json<T>(path: string): Promise<T> {
    const r = await this.fetchFn(`${TESTGRID}/${path}`);
    if (!r.ok) throw new Error(`TestGrid ${r.status} for ${path}`);
    return (await r.json()) as T;
  }

  /** The dashboard's tab names. */
  tabs(dashboard: string): Promise<string[]> {
    return this.cache.cached(`tg:tabs:${dashboard}`, 30 * MINUTE, async () =>
      Object.keys(await this.json<TgSummary>(`${encodeURIComponent(dashboard)}/summary`)),
    );
  }

  table(ref: TgRef): Promise<TgTable> {
    return this.cache.cached(`tg:table:${ref.dashboard}#${ref.tab}`, 30 * MINUTE, async () =>
      compact(
        await this.json<TgTable>(
          `${encodeURIComponent(ref.dashboard)}/table?tab=${encodeURIComponent(ref.tab)}`,
        ),
      ),
    );
  }

  /** The tab that shows `job`, confirmed by the table's GCS query ending in the job name. null if none of the
   *  known dashboards has it. */
  async resolveJob(job: string): Promise<TgRef | null> {
    const guesses = tabGuesses(job);
    for (const dashboard of DASHBOARDS) {
      let tabs: string[];
      try {
        tabs = await this.tabs(dashboard);
      } catch {
        continue;
      }
      for (const tab of tabs.filter((t) => guesses.includes(t))) {
        const ref = { dashboard, tab };
        const q = (await this.table(ref).catch(() => null))?.query ?? "";
        if (q.split("/").pop() === job) return ref;
      }
    }
    return null;
  }

  /** Every tab an issue points at: its TestGrid links, then the tabs of the Prow jobs it names. */
  async tabsFor(text: string): Promise<TgRef[]> {
    const { tabs, jobs } = refsFrom(text);
    const out = new Map(tabs.map((t) => [`${t.dashboard}#${t.tab}`, t]));
    const known = new Set<string>();
    for (const t of tabs) {
      const q = (await this.table(t).catch(() => null))?.query;
      if (q) known.add(q.split("/").pop()!);
    }
    for (const j of jobs.filter((j) => !known.has(j)).slice(0, 6)) {
      const ref = await this.resolveJob(j);
      if (ref) out.set(`${ref.dashboard}#${ref.tab}`, ref);
    }
    return [...out.values()].slice(0, 6);
  }

  /** Run history for what an issue tracks, per job it names: the named tests' rows when TestGrid has them, and
   *  always the job's Overall row. Jobs come from the title and description; only when those name none, from
   *  `comments` (a job someone merely mentions later is often a different one). `asOf` and `since` as in
   *  rowSignal. */
  async ciSignal(
    title: string,
    body: string,
    comments: string,
    asOf: number,
    since?: number,
  ): Promise<JobSignal[]> {
    const wanted = testsFrom(title, body);
    let tabs = await this.tabsFor(`${title}\n${body}`);
    if (!tabs.length) tabs = await this.tabsFor(comments);
    const out: JobSignal[] = [];
    for (const ref of tabs) {
      const tbl = await this.table(ref).catch(() => null);
      if (!tbl) continue;
      const rows = new Map<string, TgRow>();
      for (const w of wanted) for (const r of matchRows(tbl, w)) rows.set(r.name, r);
      const overall = overallRow(tbl);
      const job = overall ? rowSignal(tbl, overall, ref, asOf, since) : null;
      if (!tbl.timestamps.some((t) => t < asOf)) continue; // nothing TestGrid still has predates asOf
      const name = tbl.query?.split("/").pop() ?? ref.tab;
      out.push({
        job: name,
        testgrid: `${ref.dashboard}#${ref.tab}`,
        named_in_title: title.includes(name) || title.includes(ref.tab),
        tracked_tests: rows.size
          ? [...rows.values()].slice(0, 5).map((r) => strip(rowSignal(tbl, r, ref, asOf, since)))
          : "not found in this job's recent runs",
        whole_job: job && (({ test: _t, ...rest }) => rest)(strip(job)),
      });
    }
    return out;
  }
}

/** Per-row facts without the job/tab fields repeated from the enclosing JobSignal. */
export type RowFacts = Omit<TestSignal, "job" | "tab" | "dashboard">;
const strip = ({ job: _j, tab: _t, dashboard: _d, ...rest }: TestSignal): RowFacts => rest;

export interface JobSignal {
  job: string;
  testgrid: string;
  named_in_title: boolean;
  /** The rows of the tests the issue names, or why there are none. */
  tracked_tests: RowFacts[] | string;
  /** The job's Overall row: a run fails when any test in it fails, including tests this issue is not about. */
  whole_job: Omit<RowFacts, "test"> | null;
}
