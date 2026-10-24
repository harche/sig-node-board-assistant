/** TestGrid review questions (review on testgrid.k8s.io). Shape follows docs.typesafe.ai/primitives/advanced, like
 *  prompts/triage.ts. Code collects the evidence: the job's run history from TestGrid, and each failed run's junit
 *  failures and the build log lines that say what failed. */

const RUN_NOTE =
  "`runs` are failed runs of one CI job, newest first. For each: its `build` id, when it `started` and its `result`; `junit_failures`, every failed test case in the run's junit files, each once (empty when the run produced none), with `junit_total` counting them, and a line saying so where a very long list leaves some out; and `log_signals`, the lines of its build log that say what failed: Ginkgo's failure markers with the lines after them (the expected and actual values, where it failed), its failure summary and how the run ended, timeout and kill messages, or, when no test ran, the job's last lines before it exited. When present, `status` is TestGrid's word for the job now (FAILING: its newest runs fail; FLAKY: some runs fail among passes) and `history` its runs over TestGrid's window: how many ran and failed, how many of the newest failed in a row, days since the first failure and since the last pass, every test row that failed with its count of failed runs, and `harness_only` when only the harness's own rows failed (the job breaks around its tests, not in them). All computed by code: use them as given.";

const ISSUE_NOTE =
  "`issue` is a GitHub issue: its title, state, whole body and every comment, oldest first, with bots' comments left out and run links and build ids stripped.";

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
      "Compare the failure itself: the failing test and the error, or the timeout or infra symptom. The same job or the same test with a different error is a different problem. An issue about the same failure on another job still tracks it. For an infra failure, an issue reporting the same breakage from the same cause on other jobs tracks it, such as the same zone out of the same VM type or the same node image never coming up; the same job failing for another infra reason does not.",
    note: `${RUN_NOTE} ${ISSUE_NOTE}`,
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

/** Whether a tracking issue's thread already reports this job, so a comment adding it would repeat it. */
const namesJob = {
  type: "noul",
  instructions: {
    question:
      "Does `issue` already report that the CI job `job` (TestGrid tab `tab`) fails, in its body or in any comment?",
    focus:
      "Look for this job among the jobs the issue says are failing, or a comment reporting it failing too, under its job or tab name, even shortened. A job with a similar name that is another job (another branch, release, runtime, OS or feature set) is not this one. A mention of this job only as passing, fixed or unaffected does not count.",
    note: "`issue.thread` is the issue's body followed by every comment, oldest first; bots' comments are left out and run links stripped.",
  },
  criteria: {
    true: { what: "The issue or a comment on it reports this job failing." },
    false: { what: "It never reports this job failing, or only a different job with a similar name." },
  },
};

export function namesJobQuestion(): { names_job: typeof namesJob } {
  return { names_job: namesJob };
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
    note: `${RUN_NOTE} ${ISSUE_NOTE}`,
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

const RELATED_NOTE = `${RUN_NOTE} ${ISSUE_NOTE}`;

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

/** Several open issues each read as tracking the failure: which one is the main one, where a report of this job
 *  belongs. Replaces a code tie-break (the one already naming the job, else the latest activity) that could not tell
 *  the issue people work on from a duplicate someone touched last. */
export function canonicalQuestion(issues: { key: string; repo: string; number: number; title: string }[]): {
  canonical: Record<string, unknown>;
} {
  return {
    canonical: {
      type: "choice",
      instructions: {
        question:
          "Which of `issues` is the main tracking issue for the failure these runs show: the one a report that this job fails this way belongs on?",
        focus:
          "Read the threads, not only the titles. The main issue is where this failure is worked on: the others were closed or linked as its duplicates, it holds the investigation or the fix, or it already lists this job among those failing. Prefer the issue about this exact test and error over a broader one that also covers it. An issue whose thread points to another as the place to follow, or that went quiet once a newer one was filed, is not the main one. Choose none only when they are equally live and nothing in them sets one apart.",
        note: `${RUN_NOTE} \`issues\` are the candidates, each with its \`key\`, repository, title, state, when it was last active, whole body and every comment, oldest first, with bots' comments left out and run links and build ids stripped.`,
      },
      criteria: {
        ...Object.fromEntries(
          issues.map((i) => [
            i.key,
            {
              what: `${i.repo === "kubernetes/kubernetes" ? "" : i.repo}#${i.number}, "${i.title}", is the main tracking issue.`,
            },
          ]),
        ),
        none: {
          what: "None of them stands out as the main one: they are equally live, or the same report filed twice with nothing to tell them apart.",
        },
      },
    },
  };
}

/** Whether two groups of a job's failed runs, grouped by code (their failing tests, else their error line), fail for
 *  one cause: two error lines that differ in a word can still be one breakage. */
const sameCause = {
  type: "noul",
  instructions: {
    question: "Do the runs in `runs_a` and the runs in `runs_b` fail for the same cause?",
    focus:
      "Compare what broke, not the wording: the same test failing the same way, or the same environment breakage (the same zone out of the same VM type, the same node image never coming up). Different tests, a different error in one test, or a different infra breakage are different causes, even on the same job.",
    note: `\`runs_a\` and \`runs_b\` are two groups of failed runs of the CI job \`job\` (TestGrid tab \`tab\`), each in the shape below. ${RUN_NOTE}`,
  },
  criteria: {
    true: { what: "Both groups fail for one cause: fixing it would stop the runs of both." },
    false: { what: "They fail for different causes." },
  },
};

export function sameCauseQuestion(): { same_cause: typeof sameCause } {
  return { same_cause: sameCause };
}

export function relationQuestion(): { relation: typeof relation } {
  return { relation };
}
export function fixesQuestion(): { fixes: typeof fixes } {
  return { fixes };
}
export function coversQuestion(): { covers: typeof covers } {
  return { covers };
}
