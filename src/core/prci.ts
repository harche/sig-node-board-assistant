/** The PR page's CI check: for each presubmit failing on a pull request's head commit, whether the PR's change
 *  broke it, or it fails without the change (a flake, or the job's environment), and so whether to fix the code or
 *  rerun the job.
 *
 *  Code computes the facts: the failed run's junit failures and build log signal lines (as for TestGrid, tgreview.ts),
 *  the job's earlier runs on this PR, and from the job's presubmit tab on TestGrid how often the same tests failed on
 *  other PRs' runs. Jev judges the cause from those facts, and whether each candidate flake issue tracks the failure.
 *  Nothing here writes: the suggested Prow command is shown for the reader to post. */
import type { Reading } from "./readings";
import { PROW, TRACKED_AT, type JunitFailure, type RunEvidence, type Track } from "./tgreview";
import type { JevChoice, JevUsage } from "./types";
import type { CommitStatus } from "./github";

/** A failed Prow presubmit on the head commit. */
export interface FailedCheck {
  job: string;
  /** failure: the job ran and failed; error: Prow could not run it (the description says why). */
  state: "failure" | "error";
  description: string;
  url: string;
  /** `bucket/pr-logs/pull/[org_repo/]<pr>/<job>`: the job's runs on this PR in GCS. */
  gcs: string;
  build: string;
}

const PROW_RUN = new RegExp(`^${PROW.replace(/[.]/g, "\\.")}/(.+/pr-logs/pull/.+)/(\\d+)/?$`);

/** Prow's failed presubmits among a commit's statuses; other contexts (tide, CLA, other CI) are left out. */
export function failedChecks(statuses: CommitStatus[]): FailedCheck[] {
  return statuses.flatMap((s) => {
    const m = PROW_RUN.exec(s.target_url);
    if (!m || (s.state !== "failure" && s.state !== "error")) return [];
    return [
      {
        job: s.context,
        state: s.state,
        // Prow pads the description and appends the base commit: only the words before it say anything.
        description: s.description.replace(/\s+BaseSHA:\S*/, "").trim(),
        url: s.target_url,
        gcs: m[1]!,
        build: m[2]!,
      },
    ];
  });
}

/** One run of the job on this PR. */
export interface PrRun {
  build: string;
  /** SUCCESS, FAILURE, ABORTED, error…; null while it runs or when Prow wrote nothing. */
  result: string | null;
  /** Whether it tested the PR's current head commit; null when the run does not say. */
  current: boolean | null;
}

/** The job's record on other PRs, from its presubmit tab on TestGrid. */
export interface Elsewhere {
  testgrid: string;
  window_days: number;
  /** The whole job: other PRs' runs, and how many failed. */
  job: { runs: number; failed: number };
  /** Each failing test of this PR's run that TestGrid has a row for. */
  tests: { test: string; runs: number; failed: number }[];
}

export interface CiJob {
  check: FailedCheck;
  evidence: RunEvidence;
  this_pr: PrRun[];
  /** null when TestGrid has no presubmit tab for the job. */
  elsewhere: Elsewhere | null;
  cause: JevChoice | null;
  /** Candidate flake issues with Jev's P(tracks), highest first. */
  tracks: Track[];
  readings: Reading[];
  usage: JevUsage;
}

/** Every presubmit's state on the head commit. */
export interface PrChecks {
  sha: string;
  failed: FailedCheck[];
  passing: number;
  pending: string[];
  /** Tide's word on what still blocks the merge ("Needs approved, lgtm labels."), if it reported. */
  tide: string | null;
}

export type CiVerdict = "this_pr" | "flake" | "infra" | "unsure";

/** Jev's top cause counts only at this probability; below, the reader decides. */
export const CAUSE_AT = 0.6;

export const CI_LABEL: Record<CiVerdict, string> = {
  this_pr: "Caused by this PR",
  flake: "Not this PR: a flake",
  infra: "Not this PR: infra",
  unsure: "Your call",
};

export const CI_TINT: Record<CiVerdict, "REMOVE" | "KEEP" | "BORDERLINE"> = {
  this_pr: "REMOVE",
  flake: "KEEP",
  infra: "KEEP",
  unsure: "BORDERLINE",
};

const pct = (p: number) => `${Math.round(p * 100)}%`;

/** Prow never ran the job (no log, no junit): its description ("Pod scheduling timeout.") is all there is. */
export function neverRan(j: Pick<CiJob, "check" | "evidence">): boolean {
  return j.check.state === "error" && j.evidence.log_signals === null && !j.evidence.junit_failures.length;
}

/** What the job's record on other PRs says, as a phrase: the failing test that fails most there, else the job. */
function elsewherePhrase(e: Elsewhere | null): string | null {
  if (!e) return null;
  const t = [...e.tests].sort((a, b) => b.failed - a.failed)[0];
  if (t)
    return `${shortTest(t.test)} failed on ${t.failed} of ${t.runs} other PRs' runs in ${e.window_days}d`;
  return e.job.runs
    ? `the job failed ${e.job.failed} of ${e.job.runs} other PRs' runs in ${e.window_days}d`
    : null;
}

/** The name a failed case is known by: a Go test's own name from its output (`--- FAIL: TestX`, else the first `=== RUN`;
 *  the case is named after its package), else the case's. */
export function failName(j: JunitFailure): string {
  const go = (/--- FAIL: (\S+)/.exec(j.message) ?? /=== RUN\s+(\S+)/.exec(j.message))?.[1];
  return go ?? shortTest(j.test);
}

/** A test's name without its suite prefix and Ginkgo tags, for reading. */
export function shortTest(name: string): string {
  return (
    name
      .replace(/^[\w.-]+ Suite\.?\s*/, "")
      .replace(/^\[It\]\s*/, "")
      .replace(/\s*\[[A-Z][\w:-]*\]/g, "")
      .trim()
      .slice(0, 100) || name.slice(0, 100)
  );
}

/** The tracking issue for a failure that is not the PR's: an open one Jev is sure of. */
export function trackedBy(j: CiJob): Track | null {
  return j.tracks.find((t) => t.state === "open" && t.p >= TRACKED_AT) ?? null;
}

/** The verdict, why, and the Prow command that reruns the job when the PR is not to blame. */
export function decideCi(j: CiJob): { verdict: CiVerdict; why: string; command: string | null } {
  const rerun = `/test ${j.check.job}`;
  if (neverRan(j))
    return {
      verdict: "infra",
      why: `Prow could not run it: ${j.check.description || "no log"}`,
      command: rerun,
    };
  const probs = Object.entries(j.cause?.probabilities ?? {}).sort((a, b) => b[1] - a[1]);
  const [top, p] = probs[0] ?? ["", 0];
  const elsewhere = elsewherePhrase(j.elsewhere);
  if (!j.cause || p < CAUSE_AT)
    return {
      verdict: "unsure",
      why: j.cause
        ? `Jev is unsure: ${probs
            .slice(0, 2)
            .map(([k, v]) => `${k.replace("_", " ")} ${pct(v)}`)
            .join(", ")}`
        : "Jev could not read this run",
      command: null,
    };
  if (top === "this_pr") {
    const first = j.evidence.junit_failures[0];
    const what = first ? failName(first) : "the job";
    const clean = j.elsewhere?.tests.length && j.elsewhere.tests.every((t) => t.failed === 0);
    return {
      verdict: "this_pr",
      why: `${pct(p)}: ${what} fails here${clean ? " and on no other PR's runs" : ""}`,
      command: null,
    };
  }
  const t = trackedBy(j);
  const issue = t ? `; tracked by ${t.repo === "kubernetes/kubernetes" ? "" : t.repo}#${t.number}` : "";
  // Infra is said by the run itself (the log's first signal line); a flake by its record on other PRs.
  const said = j.evidence.log_signals?.[0] ?? j.evidence.junit_failures[0]?.message;
  const infra = top === "infra";
  const detail = infra ? (said?.slice(0, 140) ?? elsewhere) : (elsewhere ?? said?.slice(0, 140));
  return {
    verdict: infra ? "infra" : "flake",
    why: `${pct(p)}${detail ? `: ${detail}` : ""}${issue}`,
    command: rerun,
  };
}

/** One command for everything the PR is not to blame for: /retest reruns every failed job, so it fits only when
 *  all `failed` jobs were judged and none of them is the PR's (or undecided); otherwise one /test per job. */
export function rerunCommand(jobs: CiJob[], failed = jobs.length): string | null {
  const ds = jobs.map(decideCi);
  const cmds = ds.flatMap((d) => (d.command ? [d.command] : []));
  if (!cmds.length) return null;
  if (cmds.length === failed && cmds.length > 1) return "/retest";
  return cmds.join("\n");
}
