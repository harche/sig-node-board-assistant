/** The issue page's two checks, on any SIG Node (or DRA) issue.
 *
 *  CI history, for an issue that names CI jobs or tests (a flake or failing-test report): the run history of what it
 *  names (TestGrid, as the To do column reads it), the newest failed run's junit failures and log lines, Jev's read of
 *  whether the problem is resolved (To do's question), and whether that newest failure is still the one the issue
 *  reports (the TestGrid review's tracks question). A closed issue whose test fails again reads as a regression.
 *
 *  Possible duplicates: issues found by GitHub search on its title, tests and jobs, the closest
 *  by shared words, each asked pairwise with To do's duplicate question (CI issues) or the Bugs backlog's (others).
 *  Nothing here writes. */
import type { RawSearchIssue } from "./github";
import type { JevClient } from "./jev";
import { BUG_DUPLICATE_QUESTIONS } from "./prompts/backlog";
import { tracksQuestion } from "./prompts/testgrid";
import { DUPLICATE_QUESTIONS, todoQuestions } from "./prompts/todo";
import { shortTest } from "./prci";
import { choiceReading, noulReading, type Reading } from "./readings";
import {
  matchRows,
  newestFailure,
  overallRow,
  refsFrom,
  testsFrom,
  type JobSignal,
  type TestGridClient,
} from "./testgrid";
import { runEvidence, type TgDeps } from "./tgjudge";
import { fragment, MAYBE_AT, stripRuns, type RunEvidence, type TrackAnswer } from "./tgreview";
import { buildTodoState, DUPLICATE_AT, freshFixGuard, RESOLVED_AT, type TodoAnswers } from "./todo";
import type { ItemDetail, JevChoice, JevNoul, JevUsage, LinkedPr } from "./types";

/** Issues these checks run on: SIG Node's, and DRA's (whose issues often lack sig/node). */
export function inScope(labels: string[]): boolean {
  return labels.some((l) => l === "sig/node" || l === "wg/device-management");
}

/** A CI issue: labelled a flake or failing test, so its duplicates are judged as CI failures. */
export const isCiIssue = (labels: string[]) =>
  labels.some((l) => l === "kind/flake" || l === "kind/failing-test");

const addUsage = (u: JevUsage, x: JevUsage) => {
  u.input_tokens += x.input_tokens;
  u.cost += x.cost;
  u.cached = u.cached && x.cached;
};

// ---------------------------------------------------------------------------------------------------- CI history

export interface IssueCiResult {
  kind: "issueci";
  closed: boolean;
  /** When a closed issue was closed: only a failure after it is "failing again". */
  closed_at: string | null;
  ci: JobSignal[];
  /** The newest failed run of the issue's main job (of its tests when TestGrid has them), and P(the issue tracks
   *  that failure); null when the job has not failed in TestGrid's window. */
  newest: { job: string; testgrid: string; evidence: RunEvidence; tracks: number | null } | null;
  answers: TodoAnswers;
  guard: string | null;
  linked_prs: {
    number: number;
    repository: string;
    title: string;
    state: string;
    merged_days_ago?: number;
  }[];
  readings: Reading[];
  usage: JevUsage;
}

export type IssueCiVerdict = "fixed" | "too_fresh" | "failing" | "changed" | "regressed" | "open" | "quiet";

export const ISSUE_CI_LABEL: Record<IssueCiVerdict, string> = {
  fixed: "Looks fixed",
  too_fresh: "Looks fixed, too soon to close",
  failing: "Still failing",
  changed: "Fails differently now",
  regressed: "Failing again",
  open: "No run history",
  quiet: "Not failing lately",
};

export const ISSUE_CI_TINT: Record<IssueCiVerdict, "KEEP" | "REMOVE" | "BORDERLINE"> = {
  fixed: "KEEP",
  too_fresh: "BORDERLINE",
  failing: "REMOVE",
  changed: "BORDERLINE",
  regressed: "REMOVE",
  open: "BORDERLINE",
  quiet: "BORDERLINE",
};

/** What the main job's history says about the issue: its named tests, most failures first, else the whole job, but
 *  only a job the title names (as freshFixGuard): a job the body merely mentions also fails for tests the issue is
 *  not about. `row` is the one the verdict goes by. */
function mainRow(ci: JobSignal[]) {
  const j = ci.find((x) => x.named_in_title) ?? ci[0];
  if (!j) return null;
  const tests = [...(typeof j.tracked_tests === "string" ? [] : j.tracked_tests)].sort(
    (a, b) => b.failures - a.failures,
  );
  const row = tests[0] ?? (j.named_in_title ? j.whole_job : null);
  return row ? { job: j.job, row, tests } : null;
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : s);

/** "on <job>, 179 runs in 15d: <test> failed 10, last yesterday; <test> failed 3, last 2d ago", or the job's own. */
function recordOf(m: NonNullable<ReturnType<typeof mainRow>>): string {
  const when = (d: number | null) => (d === null ? "" : `, last ${ago(d)}`);
  const head = `On ${m.job}, ${m.row.runs} runs in ${m.row.window_days}d`;
  if (!m.tests.length)
    return m.row.failures
      ? `${head}: the job failed ${m.row.failures}${when(m.row.last_failure_days_ago)}`
      : `${head}: the job passed every run`;
  const parts = m.tests
    .slice(0, 2)
    .map((t) =>
      t.failures
        ? `"${cut(shortTest(t.test), 70)}" failed ${t.failures}${when(t.last_failure_days_ago)}`
        : `"${cut(shortTest(t.test), 70)}" passed every run`,
    );
  return `${head}: ${parts.join("; ")}`;
}

const ago = (d: number) => (d === 0 ? "today" : d === 1 ? "yesterday" : `${d}d ago`);

/** The verdict and a one-line why, from the history, Jev's readings and the fresh-fix guard. */
export function decideIssueCi(
  r: IssueCiResult,
  /** An open issue Jev reads as this one's duplicate: a closed issue failing again is then tracked there. */
  openDup: IssueDup | null = null,
): {
  verdict: IssueCiVerdict;
  why: string;
  suggest: string | null;
} {
  const m = mainRow(r.ci);
  const p = r.answers.resolved.noul;
  const record = m ? recordOf(m) : "No run history for what it names";
  const failingNow = !!m && m.row.failures > 0 && (m.row.last_failure_days_ago ?? 99) <= 3;
  const differs = r.newest?.tracks !== null && r.newest?.tracks !== undefined && r.newest.tracks < MAYBE_AT;
  if (r.closed) {
    // Failing again only if what the verdict goes by failed after the issue closed (the newest failure is of the
    // same tests, or of the job when the title names it). Without a close time, the last three days stand in.
    const closedAt = r.closed_at ? Date.parse(r.closed_at) : null;
    const failedSince =
      !!m &&
      m.row.failures > 0 &&
      (closedAt !== null
        ? !!r.newest && r.newest.evidence.started > closedAt
        : (m.row.last_failure_days_ago ?? 99) <= 3);
    if (failedSince && !differs && openDup)
      return {
        verdict: "regressed",
        why: `Closed, but failing again. ${record}. Tracked again in #${openDup.number}.`,
        suggest: null,
      };
    if (failedSince && !differs)
      return {
        verdict: "regressed",
        why: `Closed, but failing again. ${record}.`,
        suggest: "/reopen, or file a new issue if the cause differs",
      };
    if (failedSince)
      return {
        verdict: "changed",
        why: `Closed; failing again with a different error. ${record}.`,
        suggest: null,
      };
    return { verdict: "quiet", why: `Closed. ${record}.`, suggest: null };
  }
  if (p >= RESOLVED_AT && !r.guard)
    return {
      verdict: "fixed",
      why: `Resolved at P ${p.toFixed(2)}. ${record}.`,
      suggest: "/close, with the fix and the clean runs",
    };
  if (p >= RESOLVED_AT) return { verdict: "too_fresh", why: r.guard!, suggest: null };
  if (failingNow && differs)
    return {
      verdict: "changed",
      why: `${record}. The newest failure does not look like what the issue reports (P ${r.newest!.tracks!.toFixed(2)}).`,
      suggest: null,
    };
  if (m && m.row.failures) return { verdict: "failing", why: `${record}.`, suggest: null };
  return { verdict: m ? "quiet" : "open", why: `${record}. P(resolved) ${p.toFixed(2)}.`, suggest: null };
}

export interface IssueDeps extends Pick<TgDeps, "cache" | "fetchFn" | "search"> {
  tg: TestGridClient;
  jev: JevClient;
}

/** CI history for an issue, or null when it names no job TestGrid has. */
export async function judgeIssueCi(
  d: IssueDeps,
  repo: string,
  number: number,
  detail: ItemDetail,
  prs: LinkedPr[],
  refresh = false,
  now = Date.now(),
): Promise<IssueCiResult | null> {
  const st = await buildTodoState(repo, detail, prs, d.tg, now);
  if (!st.ci_signal.length) return null;
  const usage: JevUsage = { input_tokens: 0, cost: 0, cached: true };
  const r = await d.jev.askCached<TodoAnswers>(st, todoQuestions(), 4, refresh);
  addUsage(usage, r.usage);

  // The newest failure of the main job: of its named tests' rows when TestGrid has them, else of the whole job.
  const main = st.ci_signal.find((x) => x.named_in_title) ?? st.ci_signal[0]!;
  const [dashboard, tab] = main.testgrid.split("#") as [string, string];
  let newest: IssueCiResult["newest"] = null;
  const tbl = await d.tg.table({ dashboard, tab }, refresh).catch(() => null);
  if (tbl) {
    const wanted = testsFrom(detail.title, detail.body);
    const rows = wanted.flatMap((w) => matchRows(tbl, w));
    const at =
      (rows.length ? rows : [overallRow(tbl)])
        .flatMap((row) => (row ? [newestFailure(tbl, row)] : []))
        .filter((x) => x !== null)
        .sort((a, b) => b.started - a.started)[0] ?? null;
    const gcs = (tbl.query ?? "").replace(/\/$/, "");
    if (at && gcs) {
      const evidence = await runEvidence(d, gcs, at.build, at.started, refresh);
      let tracks: number | null = null;
      if (evidence.junit_failures.length || evidence.log_signals?.length) {
        const a = await d.jev.askCached<TrackAnswer>(
          {
            job: main.job,
            runs: [{ junit_failures: evidence.junit_failures, log_signals: evidence.log_signals ?? [] }],
            issue: {
              number,
              title: detail.title,
              state: detail.state,
              body: stripRuns(detail.body).slice(0, 2500),
            },
          },
          tracksQuestion(),
          4,
          refresh,
        );
        addUsage(usage, a.usage);
        tracks = a.answers.tracks?.noul ?? null;
      }
      newest = { job: main.job, testgrid: main.testgrid, evidence, tracks };
    }
  }
  return {
    kind: "issueci",
    closed: detail.state.toLowerCase() === "closed",
    closed_at: detail.closedAt ?? null,
    ci: st.ci_signal,
    newest,
    answers: r.answers,
    guard: freshFixGuard(st.ci_signal),
    linked_prs: st.linked_prs,
    readings: [
      ...noulReading("Resolved", r.answers.resolved),
      ...choiceReading("How it was resolved", r.answers.resolution),
      ...(newest?.tracks !== null && newest?.tracks !== undefined
        ? noulReading("Newest failure is this issue's", { type: "noul", noul: newest.tracks })
        : []),
    ],
    usage,
  };
}

// ---------------------------------------------------------------------------------------------------- duplicates

export interface IssueDup {
  repository: string;
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  p: number;
  /** Which of the two Jev would keep open. */
  keep: "this" | "that";
}

export interface IssueDupsResult {
  kind: "issuedups";
  /** Every candidate asked about, highest P first. */
  candidates: IssueDup[];
  usage: JevUsage;
}

/** Candidates are updated within this many days. */
const DUP_DAYS = 365;
/** Candidates Jev is asked about. */
const DUP_ASK = 5;

const STOP = new Set(
  "the and for with when from that this into after before should does not are was were has have been failing failed fails flaky flake flaking test tests job jobs issue kubernetes kubelet node pod pods e2e sig".split(
    " ",
  ),
);
const words = (s: string) =>
  new Set((s.toLowerCase().match(/[a-z0-9][a-z0-9_.-]{2,}/g) ?? []).filter((w) => !STOP.has(w)));

/** Searches for issues like this one: its tests' and jobs' names, and its title's most telling words. */
export function dupQueries(repo: string, title: string, body: string, since: string): string[] {
  const r = refsFrom(`${title}\n${body}`);
  const tests = testsFrom(title, body)
    .map(fragment)
    .filter(Boolean)
    .slice(0, 2)
    .map((f) => `"${f.replace(/"/g, " ")}"`);
  const jobs = [...r.jobs, ...r.tabs.map((t) => t.tab)].slice(0, 2).map((j) => `"${j}"`);
  const t = [...words(title.replace(/\[[^\]]*\]/g, " "))].sort((a, b) => b.length - a.length);
  const titles = [t.slice(0, 4), t.slice(0, 3), t.slice(0, 2)]
    .filter((w) => w.length >= 2)
    .map((w) => `in:title ${w.join(" ")}`);
  return [...new Set([...tests, ...jobs, ...titles])].map(
    (q) => `repo:${repo} is:issue ${q} updated:>=${since}`,
  );
}

/** Share of words two issues have in common (Jaccard), over title and the start of the body. */
export function overlap(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  const inter = [...x].filter((w) => y.has(w)).length;
  return inter / (x.size + y.size - inter || 1);
}

export async function judgeIssueDups(
  d: Pick<IssueDeps, "search" | "jev">,
  repo: string,
  number: number,
  detail: ItemDetail,
  refresh = false,
  now = Date.now(),
): Promise<IssueDupsResult> {
  const since = new Date(now - DUP_DAYS * 86_400_000).toISOString().slice(0, 10);
  const found = (await d.search(dupQueries(repo, detail.title, detail.body, since), 10, refresh)).flat();
  const text = (t: string, b: string) => `${t}\n${b.slice(0, 1500)}`;
  const me = text(detail.title, detail.body);
  const seen = new Map<number, RawSearchIssue>();
  for (const x of found) if (x.number !== number && !seen.has(x.number)) seen.set(x.number, x);
  const pool = [...seen.values()]
    .map((x) => ({ x, j: overlap(me, text(x.title, x.body ?? "")) }))
    .filter((c) => c.j >= 0.08)
    .sort((a, b) => b.j - a.j)
    .slice(0, DUP_ASK)
    .map((c) => c.x);
  const labels = detail.labels.map((l) => l.name);
  const ci = isCiIssue(labels);
  const facet = (x: {
    number: number;
    created: string;
    title: string;
    author: string;
    assignees: string[];
    body: string;
  }) => {
    const r = refsFrom(x.body);
    return {
      number: x.number,
      repository: repo,
      created: x.created.slice(0, 10),
      title: x.title,
      author: x.author,
      assignees: x.assignees,
      ...(ci
        ? { tests: testsFrom(x.title, x.body), jobs: [...r.jobs, ...r.tabs.map((t) => t.tab)].slice(0, 8) }
        : {}),
      body: x.body.slice(0, ci ? 5000 : 3000),
    };
  };
  const a = facet({
    number,
    created: detail.createdAt,
    title: detail.title,
    author: detail.author.login,
    assignees: detail.assignees ?? [],
    body: detail.body,
  });
  const usage: JevUsage = { input_tokens: 0, cost: 0, cached: true };
  const answers = await Promise.all(
    pool.map(async (x) => {
      const b = facet({
        number: x.number,
        created: x.created_at ?? "",
        title: x.title,
        author: x.author ?? "ghost",
        assignees: x.assignees ?? [],
        body: x.body ?? "",
      });
      const s = {
        issue_A: a,
        issue_B: b,
        "precomputed (use as given)": {
          same_author: a.author === b.author,
          shared_assignee: a.assignees.some((x) => b.assignees.includes(x)),
          ...(ci ? { shared_job: (a.jobs ?? []).some((j) => (b.jobs ?? []).includes(j)) } : {}),
        },
      };
      const res = await d.jev.askCached<{ duplicate: JevNoul; survivor: JevChoice }>(
        s,
        ci ? DUPLICATE_QUESTIONS : BUG_DUPLICATE_QUESTIONS,
        4,
        refresh,
      );
      addUsage(usage, res.usage);
      return res.answers;
    }),
  );
  const candidates: IssueDup[] = pool
    .map((x, i) => ({
      repository: repo,
      number: x.number,
      title: x.title,
      url: x.html_url,
      state: x.state,
      p: answers[i]?.duplicate?.noul ?? 0,
      keep: answers[i]?.survivor?.choice === "B" ? ("that" as const) : ("this" as const),
    }))
    .sort((x, y) => y.p - x.p);
  return { kind: "issuedups", candidates, usage };
}

/** The duplicate to name, if Jev is sure of one (`open`: only an open one); the threshold is To do's. */
export function likelyDuplicate(r: IssueDupsResult | null, open = false): IssueDup | null {
  return r?.candidates.find((c) => c.p >= DUPLICATE_AT && (!open || c.state === "open")) ?? null;
}
