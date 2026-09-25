/** The SIG Node Bugs board's (kubernetes/185) Triage questions. Shape follows docs.typesafe.ai/primitives/advanced,
 *  like prompts/triage.ts. Tuned against 2025–26 kubernetes/kubernetes node issues and the first triage decision a
 *  human made on each (support, other SIG, not a bug, needs information, accepted with a priority). */

export const BUGS_BOARD = {
  name: "SIG Node Bugs board",
  tracks: "bug reports in SIG Node owned code",
  node_owns: [
    "kubelet",
    "CRI and container runtimes (containerd, CRI-O) as the kubelet drives them",
    "pod and container lifecycle on the node: start, restart, probes, termination, status",
    "CPU, memory and topology managers; in-place pod resize",
    "eviction, cgroups, node resource accounting",
    "device plugins and the kubelet side of Dynamic Resource Allocation",
    "static pods, node status and node registration, kubelet configuration",
  ],
  evidence: ["title", "description", "human_comments"],
};

/** What kind of report it is. */
const report = {
  type: "choice",
  instructions: {
    board: BUGS_BOARD,
    question: "What kind of report is this?",
    focus:
      "Judge what the reporter needs, not what they called it: many feature asks and questions are filed as bugs.",
  },
  criteria: {
    bug: {
      what: "Behaviour that deviates from documented or clearly intended behaviour, in any component.",
      examples: [
        "kubelet panics when a pod's volume is removed during restart",
        "Pods stuck in Terminating after the container runtime restarts",
        "CPU manager assigns the same exclusive CPU to two containers",
        "Regression in 1.34: startup probe ignored for sidecar containers",
      ],
    },
    feature_request: {
      what: "Asks for new behaviour, an option, an improvement, a cleanup or better docs; nothing is broken.",
      examples: [
        "kubelet should expose a metric for image pull duration",
        "Allow configuring the eviction threshold per pod",
        "Document how memory QoS interacts with cgroup v2",
      ],
    },
    support_question: {
      what: "Help with a cluster: configuration, a how-to, a user error, or an environment problem outside Kubernetes code.",
      examples: [
        "My pods are OOMKilled, how do I set limits?",
        "kubelet fails to start after I edited the systemd unit",
        "Is swap supported on my distro?",
      ],
      not_for: "A reproducible defect in Kubernetes code, even if the reporter phrases it as a question.",
    },
  },
};

/** Who owns the component the report is about. */
const owner = {
  type: "choice",
  instructions: {
    board: BUGS_BOARD,
    question: "Which group owns the code this report is about?",
    focus:
      "A human /sig comment in `human_comments` is strong evidence; a label the reporter or a bot set is not.",
  },
  criteria: {
    node: { areas: BUGS_BOARD.node_owns },
    other: {
      areas: [
        "scheduler, preemption and scheduling of DRA claims",
        "apiserver, admission, validation, client-go, kubectl",
        "controllers: deployments, jobs, daemonsets, statefulsets, garbage collection",
        "storage: CSI drivers, volume attach and mount controllers, PV/PVC",
        "network: kube-proxy, services, DNS, CNI plugins",
        "auth, cluster-lifecycle (kubeadm), cloud providers, autoscaling",
        "volumes on the node: the kubelet's volume manager, mount and unmount, subPath, emptyDir and projected volume contents (SIG Storage)",
        "anything that only fails on Windows nodes (SIG Windows)",
      ],
    },
    unclear: "The report does not say enough to tell which component is at fault.",
  },
};

/** For a report another SIG owns: which one, for the /sig line. */
export const OTHER_SIGS = [
  "api-machinery",
  "apps",
  "auth",
  "autoscaling",
  "cli",
  "cloud-provider",
  "cluster-lifecycle",
  "instrumentation",
  "network",
  "scheduling",
  "storage",
  "windows",
] as const;

const sig = {
  type: "choice",
  instructions: {
    question: "Which Kubernetes SIG owns the code this report is about?",
    evidence: BUGS_BOARD.evidence,
  },
  criteria: {
    "api-machinery": "apiserver, admission, validation, CRDs, client-go, garbage collection",
    apps: "workload controllers: deployments, jobs, cronjobs, daemonsets, statefulsets",
    auth: "authentication, authorization, RBAC, service account tokens, secrets encryption",
    autoscaling: "HPA, VPA, cluster autoscaler",
    cli: "kubectl",
    "cloud-provider": "cloud controller manager and provider integrations",
    "cluster-lifecycle": "kubeadm, cluster setup and upgrades",
    instrumentation: "metrics pipelines, logging, events, tracing infrastructure",
    network: "kube-proxy, services, endpoints, DNS, CNI, network policy",
    scheduling: "kube-scheduler, preemption, scheduling of DRA claims",
    storage: "CSI, volume plugins, attach/detach and mount, PV/PVC",
    windows: "Windows nodes and Windows-specific kubelet code",
  },
};

/** Dynamic Resource Allocation: SIG Node keeps it, WG Device Management is added. */
const dra = {
  type: "noul",
  instructions: {
    question: "Is this report about Dynamic Resource Allocation (DRA)?",
    evidence: BUGS_BOARD.evidence,
  },
  criteria: {
    true: "It involves ResourceClaims, ResourceSlices, DeviceClasses, DRA drivers or the kubelet's DRA plugin manager.",
    false: "It is about something else, including classic device plugins that do not use DRA.",
  },
};

/** Whether a maintainer can start on it without going back to the reporter. */
const enough_information = {
  type: "noul",
  instructions: {
    board: BUGS_BOARD,
    question:
      "Is there enough here for a SIG Node maintainer to start investigating without asking the reporter anything first?",
  },
  criteria: {
    true: {
      what: "A maintainer could act on it now.",
      includes: [
        "reproduction steps or a failing configuration",
        "logs, a stack trace or an error message that points at the fault",
        "a clear expected-versus-actual that a maintainer can check against the code",
        "a later comment that supplies these, from the reporter or someone who reproduced it",
        "a maintainer in the thread already found the cause",
      ],
    },
    false: {
      what: "The first step would be to ask the reporter what they did and saw.",
      includes: [
        "no reproduction, no logs and only a vague symptom",
        "no Kubernetes or container runtime version when the behaviour plainly depends on it",
        "a maintainer asked for details and the reporter has not answered",
      ],
    },
  },
};

/** The facts a needs-information comment asks for. */
export const FACTS = {
  version: "the Kubernetes version, and the container runtime and its version",
  reproduction: "steps to reproduce it, with the pod spec or kubelet configuration involved",
  logs: "the kubelet (and container runtime) logs around the failure",
  expected: "what was expected to happen and what happened instead",
} as const;
export type Fact = keyof typeof FACTS;

const missing = Object.fromEntries(
  (Object.keys(FACTS) as Fact[]).map((k) => [
    `missing_${k}`,
    {
      type: "noul",
      instructions: {
        question: `Would a maintainer need to ask the reporter for ${FACTS[k]}?`,
        evidence: BUGS_BOARD.evidence,
      },
      criteria: {
        true: "It is missing, and investigating the report needs it.",
        false: "The report or a later comment already gives it, or this report does not need it.",
      },
    },
  ]),
);

/** Priority labels, most urgent first. */
export const BUG_PRIORITIES = ["critical-urgent", "important-soon", "important-longterm", "backlog"] as const;

/** Score levels run backlog (0) to critical-urgent (3); bugs.ts turns the most likely one into the label. A score
 *  matched the triagers' pick as often as always answering important-longterm (39%), and caught backlog bugs a
 *  choice did not; triagers disagree with each other a lot, hence the easy override on the card. */
const priority = {
  type: "score",
  instructions: {
    question: "How urgent is fixing this SIG Node bug?",
    focus: "Judge the impact on users from the evidence, not the reporter's own urgency claims.",
    evidence: BUGS_BOARD.evidence,
  },
  criteria: [
    {
      summary: "backlog",
      signals: [
        "a rare edge case",
        "a misleading log, event or error message",
        "an inefficiency",
        "a cosmetic problem",
        "a code-reading finding with no user impact seen",
      ],
    },
    {
      summary: "important-longterm",
      signals: [
        "a real defect with a workaround",
        "affects some configurations",
        "incorrect status or accounting users can live with",
      ],
    },
    {
      summary: "important-soon",
      signals: [
        "a regression against an earlier release",
        "a kubelet crash, hang, leak or data race users hit",
        "pods stuck or failing in a common configuration without a workaround",
      ],
    },
    {
      summary: "critical-urgent",
      signals: [
        "data loss or corruption",
        "a security hole",
        "nodes broken for everyone on a supported setup",
      ],
    },
  ],
};

const withEvidence = <Q extends { instructions: Record<string, unknown> }>(q: Q) => ({
  ...q,
  instructions: { ...q.instructions, evidence: BUGS_BOARD.evidence },
});

/** The decision's questions, asked for every item in one call. */
export function bugQuestions() {
  return {
    report: withEvidence(report),
    owner: withEvidence(owner),
    dra,
    enough_information: withEvidence(enough_information),
  };
}

/** Asked only for what the first answers leave open: the priority of a bug SIG Node keeps, the missing facts of
 *  one that needs information, and the SIG of one another SIG owns. */
export const priorityQuestion = () => ({ priority });
export const missingQuestions = () => missing;
export const sigQuestion = () => ({ sig });
