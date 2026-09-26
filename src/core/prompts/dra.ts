/** The Dynamic Resource Allocation board's (kubernetes/95) questions. Shape follows docs.typesafe.ai/primitives/advanced,
 *  like prompts/triage.ts. Tuned against the board's own history: where its maintainers moved each issue out of
 *  New (Ready, Backlog or In progress). */

export const DRA_BOARD = {
  name: "Dynamic Resource Allocation (DRA) board",
  tracks:
    "DRA work across kubernetes/kubernetes, kubernetes/enhancements (KEPs), kubernetes/website and kubernetes-sigs/dra-example-driver: bugs, flakes, features, KEPs, cleanups and docs",
  columns: {
    in_progress: "someone is working on it now",
    ready: "well-defined and wanted soon; anyone could pick it up",
    backlog: "later: deferred to a future release, an idea or exploration, or waiting on something else",
  },
};

const NOTE =
  "`linked_prs`, `assignees` and `labels` are computed by code: use them as given. `development_cycle` is the Kubernetes release being developed now. `days_ago` values are relative to now.";

/** Where a new issue belongs on the board. */
const lane = {
  type: "choice",
  instructions: {
    board: DRA_BOARD,
    question: "Which column does this issue belong in now?",
    focus:
      "Judge whether work is under way now, whether it is ready to be picked up this cycle, or whether it waits for later.",
    note: NOTE,
  },
  criteria: {
    in_progress: {
      what: "Someone is working on it: an open PR addresses it, an assignee or commenter says they are on it, or it is a CI break or flake being chased.",
      examples: [
        "a bug with an open fix PR from the assignee",
        "a KEP for this development cycle with its implementation PRs open",
        "a flake the DRA maintainers are investigating",
      ],
    },
    ready: {
      what: "Concrete and wanted now, but nobody has started: a clear bug, a follow-up or sub-task of current work, an example or docs gap with a clear scope.",
      examples: [
        "a sub-task split out of an umbrella issue for this cycle's KEP",
        "an example the driver should add for a feature that already shipped",
        "a confirmed bug with no fix yet",
      ],
    },
    backlog: {
      what: "Deliberately later: planned for a future release, an idea or a KEP not targeted yet, or blocked on something else.",
      examples: [
        "remove a feature gate or an old API version in a later release",
        "a new KEP proposal nobody is driving this cycle",
        "an exploration or design question with no agreed direction",
      ],
    },
  },
};

export function laneQuestion(): { lane: typeof lane } {
  return { lane };
}
