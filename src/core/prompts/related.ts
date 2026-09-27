/** The issue page's duplicates and related check (core/related.ts): how a candidate relates to the issue, then, for
 *  a match shown as a duplicate, whether one could be closed in favour of the other and what links them. Shape as
 *  in prompts/triage.ts (docs.typesafe.ai/primitives/advanced).
 *
 *  Tuned offline on 153 SIG Node issues people marked as duplicates (2016-2026), each judged as of the day it was
 *  filed, and 449 hard negatives (the top semantic-search results that were not the original); see docs/design.md.
 *  The relation choice with both threads ranked the original well (AUC 0.95); the verification removes mostly
 *  same-area pairs that need separate fixes. Splitting the question into symptom, cause and conditions did no better. */

const NOTE =
  "issue_A was filed first. Compare what each issue reports, not how it is worded: titles are written by different people and often name the same problem differently. Labels are as they are now.";

/** B: one relation choice. Only the relations a reader of issue_B would act on; everything else is unrelated. */
export const RELATION_QUESTION = {
  relation: {
    type: "choice",
    instructions: {
      question: "How is issue_B related to issue_A?",
      focus:
        "Name a relation only when you can say concretely what links them: the same failure, the same bug, one being part of or a consequence of the other. Being about the same component, feature or area is not a relation.",
      note: NOTE,
    },
    criteria: {
      duplicate: {
        what: "Both report the same problem: the same misbehaviour or failure with the same cause; closing issue_B in favour of issue_A loses nothing.",
        not_for: "the same symptom from a clearly different cause, configuration or version",
        examples: [
          "two reports of the same kubelet panic with the same stack",
          "the same flaky test failing the same way, filed twice",
          "a user question answered by the other issue's bug",
        ],
      },
      same_root_cause: {
        what: "Different symptoms, tests or components, but one bug underneath: one fix would resolve both.",
        not_for: "two bugs in the same area with separate fixes",
        examples: [
          "an eviction test flake and a user report of pods evicted early, both from the same stats bug",
        ],
      },
      regression: {
        what: "issue_B reports issue_A's problem coming back after issue_A was fixed.",
        not_for: "issue_A still being open and unfixed (that is a duplicate)",
        examples: ["issue_A fixed in 1.30; issue_B reports the same failure again in 1.33"],
      },
      part_of: {
        what: "One tracks the other: an umbrella and one of its items, or a feature and a sub-task.",
        examples: [
          "issue_A: probe tests flake on several jobs (umbrella); issue_B: one probe test flakes on one job",
        ],
      },
      follow_up: {
        what: "One arose from the other's fix or discussion: a gap it left, a cleanup it deferred, a side effect of its fix.",
        examples: ["issue_B: the fix for issue_A broke the Windows path"],
      },
      unrelated: {
        what: "No concrete link: different problems, even in the same component, feature or test file.",
        examples: [
          "two different probe bugs",
          "two different tests failing on the same job",
          "the same error message from unrelated causes",
        ],
      },
    },
  },
};

/** Verification of a shown match, two shapes. */
export const VERIFY_QUESTIONS = {
  closable: {
    type: "noul",
    instructions: {
      question:
        "Could one of these issues be closed in favour of the other with nothing lost, because fixing the problem one reports fixes the other's?",
      focus:
        "Judge the problems, not the wording. Two problems in the same component that need separate fixes are not.",
      note: NOTE,
    },
    criteria: {
      true: {
        what: "One fix resolves both: the same bug, request or failure, or one's cause is the other's.",
      },
      false: { what: "Each needs its own fix, or the texts do not show that one fix would resolve both." },
    },
  },
  link: {
    type: "choice",
    instructions: {
      question: "What concretely links issue_A and issue_B, as their texts show it?",
      focus:
        "Pick the strongest link the texts actually show. A shared component, feature or area alone is `none`.",
      note: NOTE,
    },
    criteria: {
      same_error: { what: "The same error message, panic, stack or failing assertion." },
      same_test: { what: "The same test or job failing the same way." },
      same_code_path: { what: "The same function, code path or mechanism misbehaving, named or described." },
      same_request: { what: "The same feature or change requested." },
      same_trigger: { what: "The same trigger or reproduction producing the same misbehaviour." },
      none: { what: "No concrete link beyond topic: the same component, feature or area." },
    },
  },
};
