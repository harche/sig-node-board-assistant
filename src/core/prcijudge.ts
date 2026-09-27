/** Judging one failed presubmit on a PR page: evidence from GCS (as for TestGrid, tgjudge.ts), the job's runs on
 *  this PR, its record on other PRs from TestGrid, candidate flake issues from GitHub search, Jev's readings. The
 *  pure parts are in prci.ts. */
import type { ChangedFile, PullChecks } from "./github";
import type { JevClient } from "./jev";
import { causeQuestion, suspectQuestion } from "./prompts/prci";
import { tracksQuestion } from "./prompts/testgrid";
import {
  failedChecks,
  neverRan,
  SUSPECT_AT,
  type CiJob,
  type Elsewhere,
  type FailedCheck,
  type PrChecks,
  type PrRun,
  type Suspect,
} from "./prci";
import { choiceReading, noulReading, type Reading } from "./readings";
import { matchRows, tally, type TgRef, type TgTable } from "./testgrid";
import { candidates, runEvidence, type TgDeps } from "./tgjudge";
import {
  GCS,
  MAYBE_AT,
  stripRuns,
  type JobFacts,
  type JunitFailure,
  type Track,
  type TrackAnswer,
} from "./tgreview";
import type { JevChoice, JevUsage } from "./types";

export interface CiDeps extends Pick<TgDeps, "search" | "cache" | "fetchFn"> {
  pull(repo: string, number: number, refresh?: boolean): Promise<PullChecks>;
  /** The PR's diff at `sha`, its head; null once the head has moved on. */
  diff(repo: string, number: number, sha: string, refresh?: boolean): Promise<ChangedFile[] | null>;
  resolvePresubmit(job: string): Promise<TgRef | null>;
  failedTable(ref: TgRef, refresh?: boolean): Promise<TgTable>;
  jev: JevClient;
}

/** suspect_changes: the files listed, and those given with their hunks (within HUNKS characters). */
const SUSPECTS = 20;
const WITH_HUNKS = 5;
const HUNKS = 20_000;

/** Generated and vendored files: listed as not judged rather than asked about one by one (a vendor bump changes
 *  hundreds), since a check that fails over them names them anyway. */
const GENERATED =
  /(^|\/)vendor\/|(^|\/)zz_generated[^/]*$|\.pb\.go$|(^|\/)generated[^/]*\.go$|^api\/(openapi-spec|discovery)\/|(^|\/)go\.sum$/;

/** Runs of the job on this PR read for `this_pr`, newest first. */
const RUNS = 6;
const DAY = 86_400_000;

export function prChecks(p: PullChecks): PrChecks {
  const prow = p.statuses.filter((s) => s.target_url.includes("/pr-logs/pull/"));
  const tide = p.statuses.find((s) => s.context === "tide");
  return {
    sha: p.sha,
    failed: failedChecks(p.statuses),
    passing: prow.filter((s) => s.state === "success").length,
    pending: prow.filter((s) => s.state === "pending").map((s) => s.context),
    tide: tide && tide.state !== "success" ? tide.description : null,
  };
}

async function text(f: typeof fetch, url: string): Promise<string | null> {
  const r = await f(url).catch(() => null);
  return r?.ok ? r.text() : null;
}

function json<T>(s: string | null): T | null {
  try {
    return s === null ? null : (JSON.parse(s) as T);
  } catch {
    return null;
  }
}

/** Every build of the job on this PR (GCS "directories" under its prefix), oldest first. */
async function builds(d: CiDeps, gcs: string): Promise<string[] | null> {
  const f = d.fetchFn ?? ((...a) => fetch(...a));
  const [bucket, ...rest] = gcs.split("/");
  const q = new URLSearchParams({ prefix: `${rest.join("/")}/`, delimiter: "/", fields: "prefixes" });
  const listed = json<{ prefixes?: string[] }>(await text(f, `${GCS}/storage/v1/b/${bucket}/o?${q}`));
  if (!listed) return null;
  return (listed.prefixes ?? [])
    .map((p) => p.replace(/\/$/, "").split("/").pop()!)
    .filter((b) => /^\d+$/.test(b))
    .sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
}

/** One run's result and commit; a finished run never changes, so it is kept a day. */
async function prRun(d: CiDeps, gcs: string, build: string, sha: string): Promise<PrRun> {
  const key = `prrun:${gcs}/${build}`;
  type Fin = { result?: string; revision?: string };
  let fin = await d.cache.get<Fin>(key, DAY);
  if (!fin) {
    const f = d.fetchFn ?? ((...a) => fetch(...a));
    fin = json<Fin>(await text(f, `${GCS}/${gcs}/${build}/finished.json`)) ?? undefined;
    if (fin?.result) await d.cache.set(key, { result: fin.result, revision: fin.revision });
  }
  return {
    build,
    result: fin?.result ?? null,
    current: fin?.revision ? fin.revision === sha : null,
  };
}

/** A junit failure's TestGrid row name: Go tests are `<classname>.<name>`, Ginkgo's are their text. */
const rowName = (j: JunitFailure) => (j.classname ? `${j.classname}.${j.test}` : j.test);

/** The job's record on other PRs: TestGrid's presubmit tab, with this PR's own runs left out. */
async function elsewhere(
  d: CiDeps,
  job: string,
  failures: JunitFailure[],
  ours: Set<string>,
  now: number,
  refresh: boolean,
): Promise<Elsewhere | null> {
  const ref = await d.resolvePresubmit(job).catch(() => null);
  if (!ref) return null;
  const tbl = await d.failedTable(ref, refresh).catch(() => null);
  if (!tbl?.timestamps.length) return null;
  const overall = tbl.tests.find((r) => /(^|\.)Overall$/.test(r.name));
  const tests = new Map<string, { test: string; runs: number; failed: number }>();
  for (const j of failures.slice(0, 8)) {
    const row = matchRows(tbl, rowName(j))[0];
    if (row && !tests.has(row.name)) tests.set(row.name, { test: row.name, ...tally(tbl, row, ours) });
  }
  return {
    testgrid: `${ref.dashboard}#${ref.tab}`,
    window_days: Math.max(1, Math.round((now - tbl.timestamps[tbl.timestamps.length - 1]!) / DAY)),
    job: overall ? tally(tbl, overall, ours) : { runs: 0, failed: 0 },
    tests: [...tests.values()].slice(0, 5),
  };
}

/** Facts candidates() searches with: the job and its failing tests. */
function searchFacts(c: FailedCheck, failures: JunitFailure[]): JobFacts {
  return {
    dashboard: "",
    tab: c.job,
    status: "FAILING",
    job: c.job,
    gcs: c.gcs,
    runs: 0,
    failed_runs: 0,
    streak: 0,
    first_failure_days_ago: null,
    last_pass_days_ago: null,
    failing_tests: failures.slice(0, 2).map((j) => ({ name: j.test, failed: 1 })),
    harness_only: !failures.length,
    failed_builds: [],
  };
}

export async function judgeCi(
  d: CiDeps,
  repo: string,
  number: number,
  check: FailedCheck,
  refresh = false,
  now = Date.now(),
): Promise<CiJob> {
  const pr = await d.pull(repo, number, refresh);
  const [evidence, all] = await Promise.all([
    runEvidence(d, check.gcs, check.build, now, refresh),
    builds(d, check.gcs),
  ]);
  const ours = new Set(all ?? [check.build]);
  const recent = (all ?? [check.build]).slice(-RUNS).reverse();
  const [this_pr, other] = await Promise.all([
    Promise.all(recent.map((b) => prRun(d, check.gcs, b, pr.sha))),
    elsewhere(d, check.job, evidence.junit_failures, ours, now, refresh),
  ]);
  const usage: JevUsage = { input_tokens: 0, cost: 0, cached: true };
  const base = { check, evidence, this_pr, elsewhere: other };
  if (neverRan({ check, evidence }))
    return { ...base, cause: null, suspects: [], tracks: [], readings: [], usage };

  const ask = async <A>(state: unknown, q: Record<string, unknown>): Promise<A> => {
    const res = await d.jev.askCached<A>(state, q, 4, refresh);
    usage.input_tokens += res.usage.input_tokens;
    usage.cost += res.usage.cost;
    usage.cached = usage.cached && res.usage.cached;
    return res.answers;
  };
  const failures = evidence.junit_failures.map((j) => ({ test: rowName(j), message: j.message }));
  const run = { junit_failures: failures, log_signals: evidence.log_signals ?? [] };
  const state = {
    pr: { title: pr.title, files: pr.files.slice(0, 150), files_total: pr.files_total },
    job: check.job,
    run,
    this_pr: this_pr.map((r) => ({
      result: r.result ?? "unknown",
      tested: r.current === null ? "unknown" : r.current ? "the current commit" : "an earlier commit",
    })),
    elsewhere: other
      ? {
          window_days: other.window_days,
          job: { other_prs_runs: other.job.runs, failed: other.job.failed },
          tests: other.tests.map((t) => ({ test: t.test, other_prs_runs: t.runs, failed: t.failed })),
        }
      : "TestGrid has no presubmit tab for this job",
  };
  const cands = await candidates(d, searchFacts(check, evidence.junit_failures), now, refresh, 6).catch(
    () => [],
  );
  // Every changed file with a text diff, judged on its own against the run. A file that was not judged (no text diff,
  // generated, or Jev did not answer) is listed as such, never as unlikely; an unreadable diff leaves the question out.
  const files = await d.diff(repo, number, pr.sha, refresh).catch(() => null);
  const unjudged: { file: string; why: string }[] = [];
  const judged = (
    await Promise.all(
      (files ?? []).map(async (f) => {
        if (f.patch === null) return void unjudged.push({ file: f.file, why: "no text diff" });
        if (GENERATED.test(f.file)) return void unjudged.push({ file: f.file, why: "generated or vendored" });
        const patch = f.patch;
        try {
          const a = await ask<{ suspect?: { noul: number } }>(
            { run: { job: check.job, ...run }, change: { file: f.file, status: f.status, hunks: patch } },
            suspectQuestion(),
          );
          if (a.suspect) return { file: f.file, p: a.suspect.noul, patch };
        } catch {
          // counted below as not judged
        }
        unjudged.push({ file: f.file, why: "Jev did not answer" });
      }),
    )
  ).filter((x) => x !== undefined);
  judged.sort((a, b) => b.p - a.p);
  let room = HUNKS;
  const suspect_changes = judged.slice(0, SUSPECTS).map((x, i) => {
    const hunks = i < WITH_HUNKS && room > 0 ? x.patch.slice(0, room) : "";
    room -= hunks.length;
    return { file: x.file, p: Math.round(x.p * 100) / 100, ...(hunks ? { hunks } : {}) };
  });
  const suspects: Suspect[] = judged.map((x) => ({ file: x.file, p: x.p }));
  const cstate = files
    ? {
        ...state,
        suspect_changes,
        suspect_note: `${judged.length} changed files judged; ${Math.max(0, judged.length - SUSPECTS)} lowest left out`,
        ...(unjudged.length ? { not_judged: { files: unjudged.slice(0, 50), total: unjudged.length } } : {}),
      }
    : state;
  const st = { job: check.job, runs: [run] };
  const [cause, answers] = await Promise.all([
    ask<{ cause: JevChoice }>(cstate, causeQuestion()).then((a) => a.cause ?? null),
    Promise.all(
      cands.map((c) =>
        ask<TrackAnswer>(
          {
            ...st,
            issue: {
              number: c.number,
              title: c.title,
              state: c.state,
              body: stripRuns(c.body).slice(0, 2500),
            },
          },
          tracksQuestion(),
        ),
      ),
    ),
  ]);
  const tracks: Track[] = cands
    .map((c, i) => ({
      repo: c.repo,
      number: c.number,
      title: c.title,
      state: c.state,
      url: c.url,
      via: c.via,
      p: answers[i]?.tracks?.noul ?? 0,
      names_job: c.body.includes(check.job),
    }))
    .sort((a, b) => b.p - a.p);
  const readings: Reading[] = [
    ...choiceReading("Cause", cause),
    ...suspects
      .filter((x) => x.p >= SUSPECT_AT)
      .slice(0, 3)
      .flatMap((x) => noulReading(`${x.file} could cause it`, { type: "noul", noul: x.p })),
    ...tracks
      .filter((t) => t.p >= MAYBE_AT)
      .slice(0, 3)
      .flatMap((t) =>
        noulReading(`#${t.number} tracks it${t.state === "closed" ? " (closed)" : ""}`, {
          type: "noul",
          noul: t.p,
        }),
      ),
  ];
  return { ...base, cause, suspects, tracks, readings, usage };
}
