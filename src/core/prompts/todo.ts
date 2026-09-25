/** The 'Issues - To do' questions: is the problem an issue tracks already resolved, and how. Shape as in
 *  prompts/triage.ts (docs.typesafe.ai/primitives/advanced).
 *
 *  Tuned offline against 66 kubernetes/151 issues (35 open, 31 closed in the two months before 2026-09-25, each
 *  closed one cut just before its closing comment): no open issue scored >= 0.65, and injecting fresh failures
 *  into `ci_signal` pushed every resolved one below 0.35. Longer criteria lists and a four-way decomposition
 *  scored worse than this wording. */
export const TODO_EVIDENCE = ["title", "description", "human_comments", "linked_prs", "ci_signal"];

const NOTE = {
  computed_by_code:
    "`ci_signal` and `linked_prs` are facts computed by code: use them as given. `days_ago` values are relative to now.",
  ci_signal: [
    "one entry per CI job the issue names; `named_in_title` marks the job the issue is mainly about",
    "`tracked_tests`: run history of the tests the issue names; `whole_job`: the job as a whole, which also fails for tests this issue is not about",
    "`runs_after_fix` / `failures_after_fix`: runs since the most recent merged linked PR",
    "covers only about the last two weeks; an empty `ci_signal` means no run history is available, not that the test passes",
  ],
};

/** The decision. policy thresholds: >= RESOLVED_AT recommends closing, <= OPEN_AT keeps, between asks the thread. */
const resolved = {
  type: "noul",
  instructions: {
    question: "Is the problem this issue tracks already resolved, so the issue could be closed?",
    focus: "Judge the tracked failure or task, not whether every idea in the thread was done.",
    note: NOTE,
    evidence: TODO_EVIDENCE,
  },
  criteria: {
    true: {
      what: "A fix or change for exactly this problem has landed, or it is reported gone, and nothing later says it is still happening.",
      includes: [
        "a merged PR that targets this failure: it fixes, deflakes, reverts the cause of, or raises the timeout or resources for this test or job",
        "a commenter reports the test or job is green or not flaky any more, and `ci_signal` (when present) shows no recent failures",
        "the test, job or code the issue is about was removed or replaced",
        "a coverage or cleanup task whose PR merged",
      ],
      note: "A timeout or resource increase counts as a fix when the failure was that timeout or limit.",
    },
    false: {
      what: "The problem still happens, the fix has not landed, or work is explicitly left.",
      includes: [
        "`ci_signal` shows the test or job failing after the fix merged, or in the last few days",
        "the fix PR is still open, was closed without merging, or is only proposed",
        "the test was skipped or disabled pending a real fix",
        "a later comment says it still fails or that more work remains",
        "an umbrella or tracking issue with remaining sub-items",
        "no fix and no report that it passes",
      ],
    },
  },
};

/** Shown to the reviewer and picks the wording of the drafted closing comment. */
const resolution = {
  type: "choice",
  instructions: {
    question: "What resolved it, or why is it still open?",
    note: NOTE,
    evidence: TODO_EVIDENCE,
  },
  criteria: {
    fixed_by_change:
      "A merged PR or commit fixed, deflaked, reverted the cause of, or raised the timeout or resources for this test or job.",
    went_green:
      "Reported passing, or ci_signal clean, with no identifiable fix (an infra or dependency change, or a change elsewhere).",
    obsolete: "The test, job or feature was removed, renamed or replaced.",
    still_open: "Not resolved.",
  },
};

export function todoQuestions(): { resolved: typeof resolved; resolution: typeof resolution } {
  return { resolved, resolution };
}

/** Pairwise duplicate check, the CLI's sweep DUP_Q. */
export const DUPLICATE_QUESTIONS = {
  duplicate: {
    type: "noul",
    instructions: "Are issue_A and issue_B tracking the same failure? Same title alone is not proof.",
    criteria: {
      true: "Same test (or same job-level failure) on the same job or job family, with the same failure signature/assertion; one could be closed in favour of the other with nothing lost.",
      false:
        "Different tests, different jobs with different causes, or the same assertion but clearly different root causes or scope.",
    },
  },
  survivor: {
    type: "choice",
    instructions:
      "If they are duplicates, which issue should stay open? Prefer the newer or superset issue (covers more variants, has triage links, more discussion).",
    criteria: {
      A: "issue_A should stay open; close issue_B.",
      B: "issue_B should stay open; close issue_A.",
    },
  },
};
