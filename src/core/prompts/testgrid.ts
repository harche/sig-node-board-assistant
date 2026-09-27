/** TestGrid review questions (review on testgrid.k8s.io). Shape follows docs.typesafe.ai/primitives/advanced, like
 *  prompts/triage.ts. Code collects the evidence: each failed run's junit failures and the end of its build log. */

const RUN_NOTE =
  "`runs` are failed runs of one CI job, newest first. For each, `junit_failures` are the failed test cases from the run's junit files (empty when the run produced none) and `log_signals` are the lines of its build log that say what failed: Ginkgo's failure markers and summary, timeout and kill messages, or, when no test ran, the job's last lines before it exited. Both are computed by code: use them as given.";

/** What kind of failure a job's recent failed runs show. */
const failureKind = {
  type: "choice",
  instructions: {
    question: "What kind of failure do these runs show?",
    focus:
      "Judge the cause, not the symptom. A suite or job timeout interrupts whatever test was running, so the interrupted test is not the failure. Many tests failing in BeforeEach or setup usually means the node or cluster is broken, not the tests.",
    note: RUN_NOTE,
  },
  criteria: {
    test_failure: {
      what: "A test's own assertion or wait fails: the product or the test has a bug.",
      examples: [
        "[FAILED] Timed out after 300s waiting for the pod resize to complete",
        "--- FAIL: TestComputePodActions: expected ... got ...",
        "the kubelet panics at startup because of a config the test wrote, failing every serial test",
      ],
    },
    suite_timeout: {
      what: "The suite or job ran out of time: Ginkgo's suite timeout, kubetest --timeout, or Prow's deadline cut the run short.",
      examples: [
        "[TIMEDOUT] A suite timeout occurred",
        "kubetest --timeout triggered",
        "the job was killed at its Prow timeout while tests were still running",
      ],
    },
    infra: {
      what: "The environment or the job's own setup broke: cluster or node setup, a missing tool, image or download, the job script failing before the tests, provisioning, quota, network, or the API server unreachable.",
      examples: [
        "the node never came up / kubelet service not found",
        "criu binary not found in the node image",
        "dial tcp ...:6443: i/o timeout",
        "failed to acquire a Boskos project",
        "the job script's download of a release artifact returned NoSuchKey, so the cluster never ran the tests",
      ],
    },
  },
};

export function failureKindQuestion(): { failure_kind: typeof failureKind } {
  return { failure_kind: failureKind };
}

/** Whether one candidate issue tracks the failure the runs show. */
const tracks = {
  type: "noul",
  instructions: {
    question:
      "Does `issue` track the failure these runs show, so the runs are more evidence for it rather than a new problem?",
    focus:
      "Compare the failure itself: the failing test and the error, or the timeout or infra symptom. The same job or the same test with a different error is a different problem. An issue about the same failure on another job still tracks it.",
    note: RUN_NOTE,
  },
  criteria: {
    true: {
      what: "The issue reports this failure: the same test failing the same way, or the same job-level symptom with the same cause.",
    },
    false: {
      what: "A different failure: another test, another error in the same test, or a different cause for a similar symptom.",
    },
  },
};

export function tracksQuestion(): { tracks: typeof tracks } {
  return { tracks };
}

/** How an issue the failure's own words found relates to it: beyond the tracking issue, a bug that causes it or an
 *  umbrella it belongs to. Tried on the 28 issues with runs: the root causes and umbrellas it named all came from
 *  searching the failure's text, which today's tracking search never reaches (docs/design.md). */
const relation = {
  type: "choice",
  instructions: {
    question: "How does `issue` relate to the failure these runs show?",
    focus:
      "Name a relation only when you can say what links them. The same job, component or feature alone is not a link.",
    note: "`runs` are failed runs of one CI job: their junit failures and build log lines, computed by code.",
  },
  criteria: {
    tracks: {
      what: "The issue reports this failure: the same test failing the same way, or the same job-level symptom with the same cause.",
      examples: ["a [Flaking Test] issue for this test with this error"],
    },
    root_cause: {
      what: "The issue reports a bug or change that causes this failure, though it is not about this test or job.",
      not_for: "a bug in the same area with no stated link to this error",
      examples: ["a kubelet bug report whose misbehaviour produces this test's error"],
    },
    umbrella: {
      what: "The issue tracks a group of failures this one belongs to: several tests or jobs failing from one cause, or a list of such failures.",
      examples: ["probe tests flaking often on some jobs, listing this test"],
    },
    unrelated: { what: "A different failure, or no concrete link." },
  },
};

const RELATED_NOTE =
  "`runs` are failed runs of one CI job: their junit failures and build log lines, computed by code.";

/** For a root cause: would fixing it stop these failures? Dropped the same-area bugs with no path to this error. */
const fixes = {
  type: "noul",
  instructions: {
    question:
      "Would fixing the bug, or making the change, that `issue` reports stop the failures these runs show?",
    focus:
      "The issue must explain this error in this test or job: its misbehaviour produces what the runs show. A bug in the same component with no path to this error does not.",
    note: RELATED_NOTE,
  },
  criteria: {
    true: {
      what: "The issue's bug or missing change is what produces these failures; fixing it would stop them.",
    },
    false: {
      what: "These failures have another cause, or nothing in the issue connects its bug to this error.",
    },
  },
};

/** For an umbrella: does it cover this failure? */
const covers = {
  type: "noul",
  instructions: {
    question:
      "Does `issue` track a group of failures that includes this one: does it list or plainly cover this test or job failing this way?",
    focus: "An umbrella for the same area or SIG is not enough: it must cover this failure.",
    note: RELATED_NOTE,
  },
  criteria: {
    true: { what: "It lists this test or job, or its stated scope plainly includes this failure." },
    false: { what: "Its scope is another area, other tests or jobs, or only loosely the same area." },
  },
};

export function relationQuestion(): { relation: typeof relation } {
  return { relation };
}
export function fixesQuestion(): { fixes: typeof fixes } {
  return { fixes };
}
export function coversQuestion(): { covers: typeof covers } {
  return { covers };
}
