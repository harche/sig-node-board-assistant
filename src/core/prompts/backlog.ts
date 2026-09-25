/** The SIG Node Bugs board's accepted backlog (Triaged and High Priority): is the bug already fixed, and is it the
 *  same bug as another card. The To-do questions (prompts/todo.ts) are about a failing test or CI job; these are
 *  about product behaviour, where the evidence is a merged fix, a reporter or maintainer confirming it no longer
 *  happens, or the code involved having changed. Shape as in prompts/triage.ts. */
export const BACKLOG_EVIDENCE = ["title", "description", "human_comments", "linked_prs"];

const NOTE =
  "`linked_prs` are the pull requests that reference this issue, computed by code: use them as given. A PR that only mentions the issue is not necessarily a fix for it. `days_ago` values are relative to now.";

const resolved = {
  type: "noul",
  instructions: {
    question: "Is the bug this issue reports already fixed, or otherwise gone, so the issue could be closed?",
    focus: "Judge the reported behaviour, not whether every idea in the thread was done.",
    note: NOTE,
    evidence: BACKLOG_EVIDENCE,
  },
  criteria: {
    true: {
      what: "A fix for exactly this behaviour has merged, or it is reported gone, and nothing later says it still happens.",
      includes: [
        "a merged PR whose description says it fixes this issue or this exact behaviour",
        "the reporter or a maintainer confirms it no longer happens on a current release",
        "the code or feature involved was removed or rewritten so the behaviour cannot happen",
      ],
    },
    false: {
      what: "The bug still happens, the fix has not landed, or work is explicitly left.",
      includes: [
        "the fix PR is open, closed without merging, or only proposed",
        "a merged PR is only related: a test, a refactor, a partial fix, or a different bug",
        "a later comment says it still happens, or that more work remains (a backport, a follow-up)",
        "no fix and no report that it is gone",
      ],
    },
  },
};

const resolution = {
  type: "choice",
  instructions: {
    question: "What resolved it, or why is it still open?",
    note: NOTE,
    evidence: BACKLOG_EVIDENCE,
  },
  criteria: {
    fixed_by_change: "A merged PR or commit fixed this behaviour.",
    gone: "Reported no longer happening, with no identifiable fix (fixed elsewhere, a dependency or runtime change).",
    obsolete: "The code or feature involved was removed or replaced.",
    still_open: "Not resolved.",
  },
};

export function backlogQuestions(): { resolved: typeof resolved; resolution: typeof resolution } {
  return { resolved, resolution };
}

/** Pairwise: the same bug? Asked only for pairs whose titles or components overlap (backlog.ts). */
export const BUG_DUPLICATE_QUESTIONS = {
  duplicate: {
    type: "noul",
    instructions:
      "Do issue_A and issue_B report the same bug? Same area or similar words alone are not proof.",
    criteria: {
      true: "The same misbehaviour in the same component with the same cause or trigger; closing one in favour of the other loses nothing.",
      false:
        "Different symptoms, different components, or the same symptom from clearly different causes or configurations.",
    },
  },
  survivor: {
    type: "choice",
    instructions:
      "If they are the same bug, which issue should stay open? Prefer the one with the fix in progress, the better reproduction, or more discussion.",
    criteria: {
      A: "issue_A should stay open; close issue_B.",
      B: "issue_B should stay open; close issue_A.",
    },
  },
};
