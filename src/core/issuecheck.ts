/** The issue page's CI history, on any SIG Node (or DRA) issue.
 *
 *  CI history, for an issue that names CI jobs or tests (a flake or failing-test report): the run history of what it
 *  names (TestGrid, as the To do column reads it), the newest failed run's junit failures and log lines, Jev's read of
 *  whether the problem is resolved (To do's question), and whether that newest failure is still the one the issue
 *  reports (the TestGrid review's tracks question). A closed issue whose test fails again reads as a regression.
 *
 *  Duplicates and related issues are core/related.ts. Nothing here writes. */
import type { JevClient } from "./jev";
import { tracksQuestion } from "./prompts/testgrid";
import { todoQuestions } from "./prompts/todo";
import { shortTest } from "./prci";
import { choiceReading, noulReading, type Reading } from "./readings";
import {
  matchRows,
  newestFailure,
  overallRow,
  testsFrom,
  type JobSignal,
  type TestGridClient,
} from "./testgrid";
import { runEvidence, type TgDeps } from "./tgjudge";
import type { RelatedMatch } from "./related";
import { MAYBE_AT, stripRuns, type RunEvidence, type TrackAnswer } from "./tgreview";
import { buildTodoState, freshFixGuard, RESOLVED_AT, type TodoAnswers } from "./todo";
import type { ItemDetail, JevUsage, LinkedPr } from "./types";

/** Issues these checks run on: SIG Node's, and DRA's (whose issues often lack sig/node). */
export function inScope(labels: string[]): boolean {
  return labels.some((l) => l === "sig/node" || l === "wg/device-management");
}

const addUsage = (u: JevUsage, x: JevUsage) => {
  u.input_tokens += x.input_tokens;
  u.cost += x.cost;
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
  openDup: RelatedMatch | null = null,
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

export interface IssueDeps extends Pick<TgDeps, "fetchFn"> {
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
  now = Date.now(),
): Promise<IssueCiResult | null> {
  const st = await buildTodoState(repo, detail, prs, d.tg, now);
  if (!st.ci_signal.length) return null;
  const usage: JevUsage = { input_tokens: 0, cost: 0 };
  const r = await d.jev.ask<TodoAnswers>(st, todoQuestions());
  addUsage(usage, r.usage);

  // The newest failure of the main job: of its named tests' rows when TestGrid has them, else of the whole job.
  const main = st.ci_signal.find((x) => x.named_in_title) ?? st.ci_signal[0]!;
  const [dashboard, tab] = main.testgrid.split("#") as [string, string];
  let newest: IssueCiResult["newest"] = null;
  const tbl = await d.tg.table({ dashboard, tab }).catch(() => null);
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
      const evidence = await runEvidence(d, gcs, at.build, at.started);
      let tracks: number | null = null;
      if (evidence.junit_failures.length || evidence.log_signals?.length) {
        const a = await d.jev.ask<TrackAnswer>(
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
