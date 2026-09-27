/** The PR page's CI question: is a failing presubmit the PR's doing? Shape follows docs.typesafe.ai/primitives/advanced,
 *  like prompts/testgrid.ts. Code collects the evidence: the failed run's junit failures and build log signal lines,
 *  the job's earlier runs on this PR, how often the same tests fail on other PRs' runs of the job, and Jev's own
 *  file-by-file reading of the PR's diff (SUSPECT_QUESTION): asking per file found 51 of 84 PR-caused failures where one
 *  question over the paths found 38 (docs/design.md). */

const NOTE =
  "`pr` is the pull request: its title and the paths it changes. `run` is the newest failed run of one presubmit job on it: `junit_failures` are its failed test cases (Go tests are named by package, e2e tests by their Ginkgo text) and `log_signals` the build log lines that say what failed, or the job's last lines when no test ran. `this_pr` lists the job's runs on this PR, newest first, and whether each tested the PR's current commit. `elsewhere` is TestGrid's record of the same job on other PRs over the last days: for each failing test, how many of their runs ran it and how many failed, and the job as a whole; it is missing when TestGrid has no tab for the job. All computed by code: use them as given. `suspect_changes` lists the PR's changed files with P(this file's change could cause this failure), judged file by file, highest first, with the hunks of the top ones; `not_judged` lists changed files that were not (no text diff, generated or vendored, or no answer), which are neither likely nor unlikely; `suspect_changes` is missing when the diff could not be read.";

/** Whose failure a failed presubmit run is. */
const cause = {
  type: "choice",
  instructions: {
    question: "Is this job failing because of this pull request's change?",
    focus:
      "Weigh `elsewhere` first: a test that fails on several other PRs' runs is failing without this change, unless the error here differs from theirs. A test that fails on no other PR, touches code the PR changes, or fails the same way on every run of this PR points at the change. A verify or lint check that names generated files, formatting or a feature list the PR touches is the change's doing. A job that fails the same test on several of this PR's commits, while other PRs pass it, is the change's doing too. Weigh `suspect_changes`: a changed file judged likely to cause the failure points at the PR; all judged files unlikely points away from it, unless a file in `not_judged` could explain the failure or the failure is one the PR's kind of change produces (verify, lint, typecheck).",
    note: NOTE,
  },
  criteria: {
    this_pr: {
      what: "The PR's change breaks it: its code, its tests, or files it forgot to regenerate or update.",
      examples: [
        "verify-gofmt lists a file the PR changes; or: generated files are out of date, please run hack/update-codegen.sh",
        "a unit test in a package the PR changes fails with a diff of the values the PR changed",
        "an e2e test for the feature the PR adds fails on every run of this PR and on no other PR",
      ],
    },
    flake: {
      what: "A test that fails without this change: it fails on other PRs' runs too, or intermittently in code the PR does not touch.",
      examples: [
        "a volume test that failed on 12 of 300 other PRs' runs this week, in a PR that only changes the scheduler",
        "a test that passed on this PR's previous run of the same commit",
      ],
    },
    infra: {
      what: "The job's environment broke, not a test: the cluster or node never came up, a download or image pull failed, a quota or Boskos error, the pod was never scheduled, or the job hit its timeout before tests ran.",
      examples: [
        "Pod scheduling timeout, with no build log",
        "failed to acquire a Boskos project",
        "the node image could not be pulled, so no test ran",
      ],
    },
  },
};

export function causeQuestion(): { cause: typeof cause } {
  return { cause };
}

/** One changed file of the PR against the failed run: could it cause the failure? Asked per file, so a huge diff is
 *  read whole, a file at a time. */
const suspect = {
  type: "noul",
  instructions: {
    question: "Could this change to this one file cause the job's failure?",
    focus:
      "Connect the hunk to what fails: the failing test or the code it exercises, a value in the error, a generated, vendored or listed file a verify or lint step checks, a type or signature the compiler rejects. A change with no path to the failure cannot, however large.",
    note: "`run` is the failed job run: its failed junit cases and build log lines, computed by code. `change` is one file of the pull request: its path, status and diff hunk (cut when long).",
  },
  criteria: {
    true: { what: "This file's change plausibly produces this failure." },
    false: { what: "This file's change has no path to this failure." },
  },
};

export function suspectQuestion(): { suspect: typeof suspect } {
  return { suspect };
}
