/** Judging one TestGrid tab: facts from TestGrid, evidence from GCS, candidate issues from GitHub search, Jev's
 *  readings. The pure parts are in tgreview.ts. */
import { type Cache, MINUTE } from "./cache";
import type { RawSearchIssue } from "./github";
import type { JevClient } from "./jev";
import { failureKindQuestion, tracksQuestion } from "./prompts/testgrid";
import { choiceReading, noulReading, type Reading } from "./readings";
import type { TgRef, TgTable } from "./testgrid";
import {
  fragment,
  GCS,
  jobFacts,
  junitFailures,
  MAYBE_AT,
  poolMatches,
  PROW,
  signalLines,
  stripRuns,
  type Candidate,
  type JobFacts,
  type RunEvidence,
  type TgAnswers,
  type TgResult,
  type Track,
  type TrackAnswer,
} from "./tgreview";
import type { JevUsage } from "./types";

export interface TgDeps {
  table(ref: TgRef, refresh?: boolean): Promise<TgTable>;
  /** Issues matching each query, in order (one batched request). */
  search(queries: string[], n?: number, refresh?: boolean): Promise<RawSearchIssue[][]>;
  /** An issue's whole body and every comment, as one text (and, in test mode, its mirror's comments). */
  issueText(repo: string, number: number, refresh?: boolean): Promise<string>;
  jev: JevClient;
  cache: Cache;
  fetchFn?: typeof fetch;
}

const HOUR = 60 * MINUTE;
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

/** One failed run's evidence. Runs never change once finished, so complete evidence is kept for a day; evidence a
 *  failed read left incomplete is not kept, and `refresh` reads it again. */
export async function runEvidence(
  d: Pick<TgDeps, "cache" | "fetchFn">,
  gcs: string,
  build: string,
  started: number,
  refresh = false,
): Promise<RunEvidence> {
  const f = d.fetchFn ?? ((...a) => fetch(...a));
  const key = `tgrun:${gcs}/${build}`;
  if (!refresh) {
    const hit = await d.cache.get<RunEvidence>(key, 24 * HOUR);
    if (hit) return hit;
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
  const files = await Promise.all(names.slice(0, 15).map((n) => text(f, `${GCS}/${bucket}/${n.name}`)));
  const [log, finished] = await Promise.all([
    text(f, `${base}/build-log.txt`),
    text(f, `${base}/finished.json`),
  ]);
  const e: RunEvidence = {
    build,
    started,
    url: `${PROW}/${gcs}/${build}`,
    result: json<{ result?: string }>(finished)?.result ?? null,
    junit_failures: files.flatMap((x) => (x ? junitFailures(x) : [])).slice(0, 8),
    log_signals: log === null ? null : signalLines(log),
  };
  if (log !== null && listed !== null && files.every((x) => x !== null)) await d.cache.set(key, e);
  return e;
}

const brief = (x: RawSearchIssue, repo: string, via: string): Candidate => ({
  repo,
  number: x.number,
  title: x.title,
  state: x.state,
  closed_at: x.closed_at ?? null,
  url: x.html_url,
  body: x.body ?? "",
  via,
});

/** Candidate tracking issues: searches by job, tab and test name in kubernetes/kubernetes, by job in
 *  kubernetes/test-infra (job and infra problems are filed there), and SIG Node's failing-test and flake issues that
 *  share words with the job. All in one batched search. At most `max`, searches first. */
export async function candidates(
  d: Pick<TgDeps, "search">,
  f: JobFacts,
  now: number,
  refresh = false,
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
    refresh,
  );
  const hits = q.map((x, i) => (found[i] ?? []).map((r) => brief(r, x.repo, x.via)).filter(recent));
  const out = new Map<string, Candidate>();
  const add = (cs: Candidate[]) =>
    cs.forEach((c) => out.has(`${c.repo}#${c.number}`) || out.set(`${c.repo}#${c.number}`, c));
  hits.forEach((cs, i) => q[i]!.via !== "label pool" && add(cs));
  add(poolMatches(f, hits.filter((_, i) => q[i]!.via === "label pool").flat()));
  return [...out.values()].slice(0, max);
}

export async function judgeTg(
  d: TgDeps,
  ref: TgRef,
  status: "FAILING" | "FLAKY",
  refresh = false,
  now = Date.now(),
): Promise<TgResult> {
  const facts = jobFacts(ref.dashboard, ref.tab, status, await d.table(ref, refresh), now);
  const evidence = await Promise.all(
    facts.failed_builds.map((b) => runEvidence(d, facts.gcs, b.build, b.started)),
  );
  const usage: JevUsage = { input_tokens: 0, cost: 0, cached: true };
  const ask = async <A>(state: unknown, q: Record<string, unknown>): Promise<A> => {
    const res = await d.jev.askCached<A>(state, q, 4, refresh);
    usage.input_tokens += res.usage.input_tokens;
    usage.cost += res.usage.cost;
    usage.cached = usage.cached && res.usage.cached;
    return res.answers;
  };
  const runs = evidence
    .filter((e) => e.log_signals !== null || e.junit_failures.length)
    .map((e) => ({ junit_failures: e.junit_failures, log_signals: e.log_signals ?? [] }));
  const st = { job: facts.job, runs };
  const cands = await candidates(d, facts, now, refresh);
  const [kind, answers] = await Promise.all([
    runs.length ? ask<TgAnswers>(st, failureKindQuestion()) : Promise.resolve(null),
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
  const names = [facts.job, facts.tab].filter(Boolean);
  const scored = cands.map((c, i) => ({ c, p: answers[i]?.tracks?.noul ?? 0 }));
  // Only issues that could be the tracking one are read in full: whether they name the job decides comment or not.
  const named = await Promise.all(
    scored.map(async ({ c, p }) => {
      if (p < MAYBE_AT) return names.some((n) => c.body.includes(n));
      const all = await d.issueText(c.repo, c.number, refresh).catch(() => c.body);
      return names.some((n) => all.includes(n));
    }),
  );
  const tracks: Track[] = scored
    .map(({ c, p }, i) => ({
      repo: c.repo,
      number: c.number,
      title: c.title,
      state: c.state,
      url: c.url,
      via: c.via,
      p,
      names_job: named[i]!,
    }))
    .sort((a, b) => b.p - a.p);
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
  ];
  return { kind: "tg", facts, evidence, failure_kind: kind?.failure_kind ?? null, tracks, readings, usage };
}
