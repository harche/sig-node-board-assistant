/** Judging one TestGrid tab: facts from TestGrid, evidence from GCS, candidate issues from GitHub search, Jev's
 *  readings. The pure parts are in tgreview.ts. */
import type { RawSearchIssue, SearchQuery, ThreadIssue } from "./github";
import { forever } from "./reads";
import type { JevClient } from "./jev";
import {
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
  fragment,
  GCS,
  jobFacts,
  junitFailures,
  MAYBE_AT,
  NAMED_AT,
  poolMatches,
  PROW,
  RELATED_AT,
  relatedEligible,
  relatedQueries,
  umbrellaPool,
  VERIFY_AT,
  signalLines,
  stripRuns,
  type Candidate,
  type JobFacts,
  type RunEvidence,
  type TgAnswers,
  type TgResult,
  type TgRelated,
  type Track,
  type TrackAnswer,
} from "./tgreview";
import type { JevUsage } from "./types";

export interface TgDeps {
  table(ref: TgRef): Promise<TgTable>;
  /** Issues matching each query, in order (one batched request). */
  search(queries: SearchQuery[], n?: number): Promise<RawSearchIssue[][]>;
  /** An issue's whole body and every comment, as one text (and, in test mode, its mirror's comments). */
  issueText(repo: string, number: number): Promise<string>;
  jev: JevClient;
  fetchFn?: typeof fetch;
  /** Issues with their threads, for the related search; without it, no related issues are looked for. */
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
  const files = await Promise.all(names.slice(0, 15).map((n) => text(f, `${GCS}/${bucket}/${n.name}`)));
  const [log, finished] = await Promise.all([
    text(f, `${base}/build-log.txt`),
    text(f, `${base}/finished.json`),
  ]);
  const result = json<{ result?: string }>(finished)?.result ?? null;
  return {
    evidence: {
      build,
      started,
      url: `${PROW}/${gcs}/${build}`,
      result,
      junit_failures: files.flatMap((x) => (x ? junitFailures(x) : [])).slice(0, 8),
      log_signals: log === null ? null : signalLines(log),
    },
    complete: result !== null && log !== null && listed !== null && files.every((x) => x !== null),
  };
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
  st: { job: string; runs: unknown[] },
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
  const umbrellas = umbrellaPool(repo);
  const found = await d.search([...queries, ...umbrellas], 20);
  const searched: number[] = [];
  for (let i = 0; i < 20; i++)
    for (const r of found.slice(0, queries.length)) {
      const n = r[i]?.number;
      if (n !== undefined && !searched.includes(n)) searched.push(n);
    }
  // The searches' best, capped; the tracking search's other finds and the umbrella pool, whole.
  const nums = [
    ...new Set([
      ...searched.slice(0, MAX_RELATED),
      ...also,
      ...found.slice(queries.length).flatMap((r) => r.map((x) => x.number)),
    ]),
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
        const s = {
          ...st,
          issue: { number: t.number, title: t.title, state: t.state, body: stripRuns(t.body).slice(0, 2500) },
        };
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
  const runs = evidence
    .filter((e) => e.log_signals !== null || e.junit_failures.length)
    .map((e) => ({ junit_failures: e.junit_failures, log_signals: e.log_signals ?? [] }));
  const st = { job: facts.job, runs };
  const cands = await candidates(d, facts, now);
  // Jev reads each candidate's recent comments with its body: that is where jobs get added and where a thread says
  // the failure changed. Without threads (or if the read fails), the body alone.
  const threads = new Map<string, ThreadIssue | null>();
  if (d.threads) {
    const byRepo = new Map<string, number[]>();
    for (const c of cands) byRepo.set(c.repo, [...(byRepo.get(c.repo) ?? []), c.number]);
    await Promise.all(
      [...byRepo].map(async ([repo, ns]) => {
        const m = await d.threads!(repo, ns).catch(() => new Map<number, ThreadIssue | null>());
        for (const [n, t] of m) threads.set(`${repo}#${n}`, t);
      }),
    );
  }
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
              comments: (threads.get(`${c.repo}#${c.number}`)?.comments ?? []).map((x) => ({
                author: x.author,
                created_at: x.created_at,
                body: stripRuns(x.body).slice(0, 1000),
              })),
            },
          },
          tracksQuestion(),
        ),
      ),
    ),
  ]);
  const names = [facts.job, facts.tab].filter(Boolean);
  const scored = cands.map((c, i) => ({ c, p: answers[i]?.tracks?.noul ?? 0 }));
  // Only issues that could be the tracking one are read in full, and Jev says whether the thread already reports
  // this job: that decides comment or not. The rest only show on the card, by the name in their body.
  const named = await Promise.all(
    scored.map(async ({ c, p }) => {
      if (p < MAYBE_AT) return { named: names.some((n) => c.body.includes(n)), p: null };
      const all = stripRuns(await d.issueText(c.repo, c.number).catch(() => c.body));
      // The body and the newest comments, where a job added later is.
      const thread = all.length > 16000 ? `${all.slice(0, 4000)}\n…\n${all.slice(-12000)}` : all;
      const a = await ask<{ names_job?: { noul: number } }>(
        {
          job: facts.job,
          tab: facts.tab,
          issue: { number: c.number, title: c.title, state: c.state, thread },
        },
        namesJobQuestion(),
      );
      const q = a.names_job?.noul ?? 0;
      return { named: q >= NAMED_AT, p: q };
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
    related,
    readings,
    usage,
  };
}
