/** Judging one TestGrid tab: facts from TestGrid, evidence from GCS, candidate issues from GitHub search, Jev's
 *  readings. The pure parts are in tgreview.ts. */
import { isBot } from "./boards";
import { fitHead, fitMiddle, fitText, MAX_STATE_CHARS, size } from "./fit";
import type { RawSearchIssue, SearchQuery, ThreadIssue } from "./github";
import { forever } from "./reads";
import type { JevClient } from "./jev";
import {
  canonicalQuestion,
  coversQuestion,
  failureKindQuestion,
  fixesQuestion,
  namesJobQuestion,
  relationQuestion,
  tracksQuestion,
} from "./prompts/testgrid";
import { distinctive } from "./related";
import { choiceReading, noulReading, type Reading } from "./readings";
import type { TgRef, TgTable } from "./testgrid";
import {
  CANONICAL_AT,
  fragment,
  GCS,
  jobFacts,
  JUNIT_FILES,
  junitFailures,
  MAYBE_AT,
  NAMED_AT,
  POOL_MAX,
  poolMatches,
  PROW,
  RELATED_AT,
  relatedEligible,
  relatedQueries,
  TRACKED_AT,
  umbrellaPool,
  uniqueFailures,
  VERIFY_AT,
  signalLines,
  stripRuns,
  type Candidate,
  type JobFacts,
  type JunitFailure,
  type RunEvidence,
  type TgAnswers,
  type TgResult,
  type TgRelated,
  type Track,
  type TrackAnswer,
} from "./tgreview";
import type { JevChoice, JevUsage } from "./types";

export interface TgDeps {
  table(ref: TgRef): Promise<TgTable>;
  /** Issues matching each query, in order (one batched request). */
  search(queries: SearchQuery[], n?: number): Promise<RawSearchIssue[][]>;
  /** An issue's whole body, then every comment but bots', oldest first (and, in test mode, its mirror's comments). */
  issueText(repo: string, number: number): Promise<string[]>;
  jev: JevClient;
  fetchFn?: typeof fetch;
  /** Issues with their whole threads: what Jev reads of each candidate. Without it, candidates are read by their
   *  body alone and no related issues are looked for. */
  threads?(repo: string, numbers: number[]): Promise<Map<number, ThreadIssue | null>>;
}

/** Candidate issues: updated within this many days, and closed ones only if closed this recently. */
const RECENT_DAYS = 60;

/** JSON, or null for anything that is not (an error page, a truncated read). */
function json<T>(s: string | null): T | null {
  try {
    return s === null ? null : (JSON.parse(s) as T);
  } catch {
    return null;
  }
}

async function text(fetchFn: typeof fetch, url: string): Promise<string | null> {
  const r = await fetchFn(url).catch(() => null);
  return r?.ok ? r.text() : null;
}

/** One failed run's evidence: its result, junit failures and the build log's telling lines (null when the log
 *  could not be read). A finished run never changes, so evidence read completely is kept for the worker's life
 *  (reads.ts `forever`); an unfinished run or a failed read is read again next time. */
export async function runEvidence(
  d: Pick<TgDeps, "fetchFn">,
  gcs: string,
  build: string,
  started: number,
): Promise<RunEvidence> {
  const r = await forever(
    `run:${gcs}/${build}`,
    () => readRun(d, gcs, build, started),
    (x) => x.complete,
  );
  return { ...r.evidence, started };
}

async function readRun(
  d: Pick<TgDeps, "fetchFn">,
  gcs: string,
  build: string,
  started: number,
): Promise<{ evidence: RunEvidence; complete: boolean }> {
  const f = d.fetchFn ?? ((...a) => fetch(...a));
  // A presubmit tab's query is `<bucket>/pr-logs/directory/<job>`, which holds only `<build>.txt`, naming where the
  // run is (`gs://<bucket>/pr-logs/pull/<pr>/<job>/<build>`).
  if (gcs.includes("/pr-logs/directory/")) {
    const at = /^gs:\/\/(\S+)\/(\d+)$/.exec((await text(f, `${GCS}/${gcs}/${build}.txt`))?.trim() ?? "");
    if (!at || at[2] !== build)
      return {
        evidence: {
          build,
          started,
          url: `${PROW}/${gcs}/${build}`,
          result: null,
          junit_failures: [],
          log_signals: null,
        },
        complete: false,
      };
    gcs = at[1]!;
  }
  const base = `${GCS}/${gcs}/${build}`;
  const [bucket, ...rest] = gcs.split("/");
  const prefix = `${rest.join("/")}/${build}/artifacts/`;
  const list = await text(
    f,
    `${GCS}/storage/v1/b/${bucket}/o?${new URLSearchParams({ prefix, matchGlob: "**/junit*.xml", fields: "items(name)" })}`,
  );
  const listed = json<{ items?: { name: string }[] }>(list);
  const names = listed?.items ?? [];
  const files = await Promise.all(
    names.slice(0, JUNIT_FILES).map((n) => text(f, `${GCS}/${bucket}/${n.name}`)),
  );
  const [log, finished] = await Promise.all([
    text(f, `${base}/build-log.txt`),
    text(f, `${base}/finished.json`),
  ]);
  const result = json<{ result?: string }>(finished)?.result ?? null;
  const failures = uniqueFailures(files.flatMap((x) => (x ? junitFailures(x) : [])));
  return {
    evidence: {
      build,
      started,
      url: `${PROW}/${gcs}/${build}`,
      result,
      junit_failures: failures,
      junit_total: failures.length,
      log_signals: log === null ? null : signalLines(log),
    },
    complete: result !== null && log !== null && listed !== null && files.every((x) => x !== null),
  };
}

// ---------------------------------------------------------------------------------------------------- Jev's states

/** Characters of the runs in a state, at most: the rest of MAX_STATE_CHARS is the issue's. Three runs of a broken
 *  build (hundreds of junit failures) are what reach it. */
const RUNS_MAX = 200_000;
/** Characters of the failing tests listed in `history`, at most (a suite timeout fails every row). */
const TESTS_MAX = 40_000;

/** A failed run as Jev reads it. */
export function runState(e: RunEvidence) {
  return {
    build: e.build,
    started: new Date(e.started).toISOString().slice(0, 16).replace("T", " ") + " UTC",
    result: e.result ?? "unknown",
    junit_total: e.junit_total ?? e.junit_failures.length,
    junit_failures: e.junit_failures,
    log_signals: e.log_signals ?? [],
  };
}

/** Runs within `max` characters, an equal share each. Past its share, a run keeps its first junit failures (with a
 *  line saying how many are left out; junit_total counts them all) and the start and end of its log lines. */
export function fitRuns<
  R extends { junit_failures: Pick<JunitFailure, "test" | "message">[]; log_signals: string[] },
>(runs: R[], max = RUNS_MAX): R[] {
  const share = Math.floor(max / Math.max(1, runs.length));
  return runs.map((r) => {
    if (size(r) <= share) return r;
    const log_signals = fitMiddle(
      r.log_signals,
      size,
      Math.min(size(r.log_signals), Math.floor(share / 2)),
      (n) => `… ${n} log lines left out here`,
    );
    const junit_failures = fitHead(
      r.junit_failures,
      (k) => size({ ...r, log_signals, junit_failures: k }),
      share,
      (n) => ({ test: `(${n} more failures left out: junit_total counts them)`, message: "" }),
    );
    return { ...r, log_signals, junit_failures };
  });
}

/** What the TestGrid review's questions read about the job: its status and history, and its failed runs. */
export function jobState(f: JobFacts, evidence: RunEvidence[]) {
  return {
    job: f.job,
    tab: f.tab,
    status: f.status,
    history: {
      runs: f.runs,
      failed_runs: f.failed_runs,
      failed_in_a_row: f.streak,
      first_failure_days_ago: f.first_failure_days_ago,
      last_pass_days_ago: f.last_pass_days_ago,
      failing_tests: fitHead(f.failing_tests, size, TESTS_MAX, (n) => ({
        name: `(${n} more failing tests left out)`,
        failed: 0,
      })),
      harness_only: f.harness_only,
    },
    runs: fitRuns(evidence.filter((e) => e.log_signals !== null || e.junit_failures.length).map(runState)),
  };
}

type Thread = { author: string; created_at: string; body: string }[];

/** A thread as Jev reads it: people's comments in full, bots' (stale and triage notices, Prow's replies) left out,
 *  run links and build ids stripped. */
export const humanThread = (cs: Thread = []): Thread =>
  cs
    .filter((c) => !isBot(c.author) && c.body.trim())
    .map((c) => ({ author: c.author, created_at: c.created_at, body: stripRuns(c.body) }));

/** An issue with its whole body and thread within `max` characters: past it, the oldest comments after the first
 *  give way (a line says how many), and a body over half of it keeps its start and end. */
export function fitIssue<I extends { body: string }>(
  issue: I,
  comments: Thread,
  max: number,
): I & { comments: Thread } {
  const body =
    size({ ...issue, comments: [] }) > max / 2 ? fitText(issue.body, Math.floor(max / 2)) : issue.body;
  const it = { ...issue, body };
  return {
    ...it,
    comments: fitMiddle(
      comments,
      (kept) => size({ ...it, comments: kept }),
      max,
      (n) => ({
        author: "",
        created_at: "",
        body: `(${n} comments left out here: the thread is too long)`,
      }),
    ),
  };
}

/** `st` with a candidate issue in full: its body and every person's comment, in what MAX_STATE_CHARS leaves. */
export function withIssue<S extends object>(
  st: S,
  issue: { number: number; title: string; state: string; body: string },
  comments: Thread | undefined,
): S & { issue: object } {
  return {
    ...st,
    issue: fitIssue(
      { number: issue.number, title: issue.title, state: issue.state, body: stripRuns(issue.body) },
      humanThread(comments),
      MAX_STATE_CHARS - size(st),
    ),
  };
}

/** Each candidate's thread, by `repo#number`, read in one request per repository. A failed read leaves those
 *  candidates out (read by their body alone). */
export async function candidateThreads(
  d: Pick<TgDeps, "threads">,
  cands: { repo: string; number: number }[],
): Promise<Map<string, ThreadIssue | null>> {
  const threads = new Map<string, ThreadIssue | null>();
  if (!d.threads) return threads;
  const byRepo = new Map<string, number[]>();
  for (const c of cands) byRepo.set(c.repo, [...(byRepo.get(c.repo) ?? []), c.number]);
  await Promise.all(
    [...byRepo].map(async ([repo, ns]) => {
      const m = await d.threads!(repo, ns).catch(() => new Map<number, ThreadIssue | null>());
      for (const [n, t] of m) threads.set(`${repo}#${n}`, t);
    }),
  );
  return threads;
}

const brief = (x: RawSearchIssue, repo: string, via: string): Candidate => ({
  repo,
  number: x.number,
  title: x.title,
  state: x.state,
  closed_at: x.closed_at ?? null,
  url: x.html_url,
  body: x.body ?? "",
  updated_at: x.updated_at ?? null,
  via,
});

/** Candidate tracking issues: searches by job, tab and test name in kubernetes/kubernetes, by job in
 *  kubernetes/test-infra (job and infra problems are filed there), and SIG Node's failing-test and flake issues that
 *  share words with the job. All in one batched search. At most `max`, searches first. */
export async function candidates(
  d: Pick<TgDeps, "search">,
  f: JobFacts,
  now: number,
  max = 10,
): Promise<Candidate[]> {
  const since = new Date(now - RECENT_DAYS * 86_400_000).toISOString().slice(0, 10);
  const recent = (c: Candidate) => c.state === "open" || (c.closed_at ?? "") >= since;
  const q: { repo: string; q: string; via: string }[] = [
    { repo: "kubernetes/kubernetes", q: `"${f.job}"`, via: "job name" },
    ...(f.tab !== f.job ? [{ repo: "kubernetes/kubernetes", q: `"${f.tab}"`, via: "tab name" }] : []),
    ...f.failing_tests
      .slice(0, 2)
      .map((t) => fragment(t.name))
      .filter(Boolean)
      .map((frag) => ({ repo: "kubernetes/kubernetes", q: `"${frag}"`, via: "test name" })),
    { repo: "kubernetes/test-infra", q: `"${f.job}"`, via: "job name (test-infra)" },
    ...["kind/failing-test", "kind/flake"].flatMap((l) => [
      { repo: "kubernetes/kubernetes", q: `label:sig/node label:${l} is:open`, via: "label pool" },
      { repo: "kubernetes/kubernetes", q: `label:sig/node label:${l} closed:>=${since}`, via: "label pool" },
    ]),
  ];
  const found = await d.search(
    q.map((x) => `repo:${x.repo} is:issue ${x.q} updated:>=${since}`),
    10,
  );
  const hits = q.map((x, i) => (found[i] ?? []).map((r) => brief(r, x.repo, x.via)).filter(recent));
  const out = new Map<string, Candidate>();
  const add = (cs: Candidate[]) =>
    cs.forEach((c) => out.has(`${c.repo}#${c.number}`) || out.set(`${c.repo}#${c.number}`, c));
  hits.forEach((cs, i) => q[i]!.via !== "label pool" && add(cs));
  add(poolMatches(f, hits.filter((_, i) => q[i]!.via === "label pool").flat()));
  return [...out.values()].slice(0, max);
}

/** Candidates the related search reads, at most. */
const MAX_RELATED = 30;

/** Issues that cause this failure or group it, beyond the tracking issue: found by the failure's own words
 *  (relatedQueries) and among the tracking search's finds Jev did not read as tracking, read by Jev for their
 *  relation, and shown only when a second question confirms it: fixing a root cause would stop these failures, an
 *  umbrella covers this one. Tried on 28 issues with runs: nearly every root cause and umbrella came from the
 *  failure's words, which the tracking search never reaches (docs/design.md). */
export async function relatedRuns(
  d: TgDeps,
  f: JobFacts,
  st: object,
  evidence: RunEvidence[],
  skip: Set<number>,
  /** Tracking candidates Jev did not read as tracking: read for a relation too. */
  also: number[],
  ask: <A>(state: unknown, q: Record<string, unknown>) => Promise<A>,
  now: number,
): Promise<TgRelated[]> {
  if (!d.threads) return [];
  const repo = "kubernetes/kubernetes";
  const tests = f.failing_tests.map((t) => t.name);
  const queries = relatedQueries(repo, evidence, tests, f.job, distinctive);
  // The umbrella pool page by page: all of it, not the searches' first 20.
  const [found, pool] = await Promise.all([d.search(queries, 20), d.search(umbrellaPool(repo), POOL_MAX)]);
  const searched: number[] = [];
  for (let i = 0; i < 20; i++)
    for (const r of found) {
      const n = r[i]?.number;
      if (n !== undefined && !searched.includes(n)) searched.push(n);
    }
  // The searches' best, capped; the tracking search's other finds and the umbrella pool, whole.
  const nums = [
    ...new Set([...searched.slice(0, MAX_RELATED), ...also, ...pool.flatMap((r) => r.map((x) => x.number))]),
  ].filter((n) => !skip.has(n));
  const threads = await d.threads(repo, nums);
  const cands = [...threads.values()].filter(
    (t): t is ThreadIssue => !!t && relatedEligible(t.state, t.closed_at, now),
  );
  // Every candidate at once: rate limits are the Jev client's retries' job. A candidate whose calls still fail is
  // dropped on its own, so it does not take the others with it.
  const out = await Promise.all(
    cands
      .map(async (t): Promise<TgRelated | null> => {
        const s = withIssue(st, t, t.comments);
        const rel = await ask<{ relation?: { probabilities: Record<string, number> } }>(
          s,
          relationQuestion(),
        );
        const pr = rel.relation?.probabilities ?? {};
        const kind = (["root_cause", "umbrella"] as const).find((k) => (pr[k] ?? 0) >= RELATED_AT);
        // A closed umbrella groups failures that are over.
        if (!kind || (kind === "umbrella" && t.state !== "open")) return null;
        const v =
          kind === "root_cause"
            ? (await ask<{ fixes?: { noul: number } }>(s, fixesQuestion())).fixes?.noul
            : (await ask<{ covers?: { noul: number } }>(s, coversQuestion())).covers?.noul;
        if ((v ?? 0) < VERIFY_AT[kind]) return null;
        return {
          repo,
          number: t.number,
          title: t.title,
          url: t.url,
          state: t.state,
          kind,
          p: pr[kind]!,
          verify: v!,
        };
      })
      .map((p) => p.catch(() => null)),
  );
  return out.filter((x): x is TgRelated => x !== null).sort((a, b) => b.verify - a.verify);
}

/** When two or more open candidates track the failure: Jev reads them side by side, each with its whole thread, for
 *  the main tracking issue. null when it names none at CANONICAL_AT, or could not answer; the reading either way. */
async function mainTracker(
  st: object,
  tracking: Candidate[],
  threads: Map<string, ThreadIssue | null>,
  ask: <A>(state: unknown, q: Record<string, unknown>) => Promise<A>,
): Promise<{ canonical: TgResult["canonical"]; reading: Reading[] }> {
  const keyed = tracking.map((c, i) => ({ key: `c${i}`, c }));
  const share = Math.floor((MAX_STATE_CHARS - size(st)) / keyed.length);
  const issues = keyed.map(({ key, c }) =>
    fitIssue(
      {
        key,
        repo: c.repo,
        number: c.number,
        title: c.title,
        state: c.state,
        updated_at: c.updated_at,
        body: stripRuns(c.body),
      },
      humanThread(threads.get(`${c.repo}#${c.number}`)?.comments),
      share,
    ),
  );
  const q = canonicalQuestion(
    keyed.map(({ key, c }) => ({ key, repo: c.repo, number: c.number, title: c.title })),
  );
  const a = await ask<{ canonical?: JevChoice }>({ ...st, issues }, q).catch(
    () => ({}) as { canonical?: JevChoice },
  );
  const pr = a.canonical?.probabilities ?? {};
  const top = keyed.map((x) => ({ ...x, p: pr[x.key] ?? 0 })).sort((x, y) => y.p - x.p)[0]!;
  const canonical =
    top.p >= CANONICAL_AT && top.p > (pr.none ?? 0)
      ? { repo: top.c.repo, number: top.c.number, p: top.p }
      : null;
  const reading = choiceReading("Main tracking issue", {
    type: "choice",
    choice: "",
    confidence: 0,
    probabilities: Object.fromEntries([
      ...keyed.map(({ key, c }): [string, number] => [`#${c.number}`, pr[key] ?? 0]),
      ["none clearly", pr.none ?? 0],
    ]),
  });
  return { canonical, reading: a.canonical ? reading : [] };
}

export async function judgeTg(
  d: TgDeps,
  ref: TgRef,
  status: "FAILING" | "FLAKY",
  now = Date.now(),
): Promise<TgResult> {
  const facts = jobFacts(ref.dashboard, ref.tab, status, await d.table(ref), now);
  const evidence = await Promise.all(
    facts.failed_builds.map((b) => runEvidence(d, facts.gcs, b.build, b.started)),
  );
  const usage: JevUsage = { input_tokens: 0, cost: 0 };
  const ask = async <A>(state: unknown, q: Record<string, unknown>): Promise<A> => {
    const res = await d.jev.ask<A>(state, q);
    usage.input_tokens += res.usage.input_tokens;
    usage.cost += res.usage.cost;
    return res.answers;
  };
  const st = jobState(facts, evidence);
  const runs = st.runs;
  const cands = await candidates(d, facts, now);
  // Jev reads each candidate's whole thread with its body: that is where jobs get added and where a thread says
  // the failure changed. Without threads (or if the read fails), the body alone.
  const threads = await candidateThreads(d, cands);
  const [kind, answers] = await Promise.all([
    runs.length ? ask<TgAnswers>(st, failureKindQuestion()) : Promise.resolve(null),
    Promise.all(
      cands.map((c) =>
        ask<TrackAnswer>(withIssue(st, c, threads.get(`${c.repo}#${c.number}`)?.comments), tracksQuestion()),
      ),
    ),
  ]);
  const names = [facts.job, facts.tab].filter(Boolean);
  const scored = cands.map((c, i) => ({ c, p: answers[i]?.tracks?.noul ?? 0 }));
  // Only issues that could be the tracking one are read in full, and Jev says whether the thread already reports
  // this job: that decides comment or not. The rest only show on the card, by the name in their body. With two or
  // more open tracking issues, Jev also says which is the main one: the one to comment on.
  const tracking = scored.filter(({ c, p }) => c.state === "open" && p >= TRACKED_AT).map(({ c }) => c);
  const [named, main] = await Promise.all([
    Promise.all(
      scored.map(async ({ c, p }) => {
        if (p < MAYBE_AT) return { named: names.some((n) => c.body.includes(n)), p: null };
        const [body, ...comments] = (await d.issueText(c.repo, c.number).catch(() => [c.body])).map(
          stripRuns,
        );
        const issue = { number: c.number, title: c.title, state: c.state };
        const base = { job: facts.job, tab: facts.tab, issue: { ...issue, thread: "" } };
        // The whole thread; one too long for a state loses its oldest comments after the first.
        const kept = fitMiddle(
          comments,
          (k) => size(base) + size([body ?? "", ...k].join("\n")),
          MAX_STATE_CHARS,
          (n) => `(${n} comments left out here: the thread is too long)`,
        );
        const a = await ask<{ names_job?: { noul: number } }>(
          { ...base, issue: { ...issue, thread: [body ?? "", ...kept].join("\n") } },
          namesJobQuestion(),
        );
        const q = a.names_job?.noul ?? 0;
        return { named: q >= NAMED_AT, p: q };
      }),
    ),
    tracking.length > 1 ? mainTracker(st, tracking, threads, ask) : Promise.resolve(null),
  ]);
  const tracks: Track[] = scored
    .map(({ c, p }, i) => ({
      repo: c.repo,
      number: c.number,
      title: c.title,
      state: c.state,
      url: c.url,
      via: c.via,
      p,
      names_job: named[i]!.named,
      updated_at: c.updated_at,
    }))
    .sort((a, b) => b.p - a.p);
  // Only with evidence: the related search is the failure's own words.
  const related = runs.length
    ? await relatedRuns(
        d,
        facts,
        st,
        evidence,
        // Issues Jev reads as tracking are the tracking candidates; the rest of them may still be a root cause
        // or an umbrella, and are read like the related search's own finds.
        new Set(
          tracks.filter((t) => t.repo === "kubernetes/kubernetes" && t.p >= MAYBE_AT).map((t) => t.number),
        ),
        tracks.filter((t) => t.repo === "kubernetes/kubernetes" && t.p < MAYBE_AT).map((t) => t.number),
        ask,
        now,
      ).catch(() => [])
    : [];
  const readings: Reading[] = [
    ...choiceReading("Kind of failure", kind?.failure_kind),
    ...tracks
      .filter((t) => t.p >= 0.02)
      .slice(0, 5)
      .flatMap((t) =>
        noulReading(`#${t.number} tracks it${t.state === "closed" ? " (closed)" : ""}`, {
          type: "noul",
          noul: t.p,
        }),
      ),
    ...(main?.reading ?? []),
    ...scored.flatMap(({ c }, i) =>
      named[i]!.p === null
        ? []
        : noulReading(`#${c.number} already names the job`, { type: "noul", noul: named[i]!.p! }),
    ),
  ];
  readings.push(
    ...related.flatMap((r) =>
      noulReading(r.kind === "root_cause" ? `#${r.number} may cause it` : `part of #${r.number}`, {
        type: "noul",
        noul: r.verify,
      }),
    ),
  );
  return {
    kind: "tg",
    facts,
    evidence,
    failure_kind: kind?.failure_kind ?? null,
    tracks,
    ...(main ? { canonical: main.canonical } : {}),
    related,
    readings,
    usage,
  };
}
