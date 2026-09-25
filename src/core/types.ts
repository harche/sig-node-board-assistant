/** Shared domain types. Field names mirror the reference Python implementation (sig-node-ci-assistant) so the
 *  parity fixtures generated from it compare 1:1. */
import type { ProwFix } from "./prowcmds";

export type ItemKind = "Issue" | "PullRequest";

export interface BoardRef {
  owner: string;
  number: number;
}

/** One project item as the column listing returns it (REST projectsV2 `items?q=status:"…"`). */
export interface BoardItem {
  /** Project item node id (PVTI_…), what `gh project item-edit --id` wants. */
  id: string;
  /** Numeric project item id; the board UI puts it in `data-board-card-id`. */
  restId: number;
  status: string;
  type: ItemKind;
  number: number;
  url: string;
  repository: string;
  title: string;
  state: string;
  merged: boolean;
  draft: boolean;
  labels: string[];
  assignees: string[];
  updatedAt: string;
  closedAt: string | null;
}

export interface Comment {
  author: { login: string };
  body: string;
  createdAt: string;
}

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | null;

/** Full issue / PR detail: what the signals and the Jev state are computed from. */
export interface ItemDetail {
  title: string;
  body: string;
  labels: { name: string }[];
  state: string;
  author: { login: string };
  createdAt: string;
  url: string;
  comments: Comment[];
  isDraft?: boolean;
  additions?: number;
  deletions?: number;
  files?: ChangedFile[];
  reviewDecision?: ReviewDecision;
}

export interface RoutingComment {
  who: string;
  cmd: string;
}

/** Facts the code computes itself; Jev never infers these. */
export interface Signals {
  human_slash_routing_comments: RoutingComment[];
  manual_sig_node_routing_present: boolean;
  human_comment_count: number;
  triage_accepted_already: boolean;
  priority_label_already: string | null;
  // pull requests only
  is_draft?: boolean;
  file_count?: number;
  test_or_ci_file_count?: number;
  test_or_ci_file_share_percent?: number;
  has_lgtm_label?: boolean;
  blocked_labels?: string[];
  review_decision?: ReviewDecision;
}

/** The JSON object Jev reads. */
/** A PR that references an issue. */
export interface LinkedPr {
  repository: string;
  number: number;
  title: string;
  author: string;
  state: "open" | "closed" | "merged";
  createdAt: string;
  mergedAt: string | null;
  body: string;
}

export interface TriageState {
  type: "issue" | "pull request";
  repository: string;
  title: string;
  description: string;
  human_comments: { author: string; text: string }[];
  human_routing?: { author: string; command: string }[];
  changed_files?: { test_or_ci: string[]; other: string[] };
}

export interface JevNoul {
  type: "noul";
  noul: number;
}
export interface JevChoice {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}
export interface JevScore {
  type: "score";
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface TriageAnswers {
  in_scope: JevNoul;
  bucket: JevChoice;
  owner: JevChoice;
  /** Asked only when the item is not being removed. */
  priority?: JevScore;
}

export interface JevUsage {
  input_tokens: number;
  output_tokens?: number;
  cost: number;
  cached?: boolean;
}

export type Verdict = "KEEP" | "REMOVE" | "BORDERLINE";

export interface TriageResult {
  item_id: string;
  repo: string;
  number: number;
  kind: ItemKind;
  title: string;
  url: string;
  verdict: Verdict;
  why: string;
  /** Null when Jev says remove: the item is only ever archived, so Jev is not asked and Accept is not offered. */
  priority: string | null;
  priority_why: string;
  lane: string;
  answers: TriageAnswers;
  signals: Signals;
  /** Prow commands someone mistyped in the thread, with their fixes (prowcmds.ts). */
  prow_fixes?: ProwFix[];
  usage: JevUsage;
  state_chars: number;
}

/** One board mutation, described but never executed by this extension. */
export type ActionStep =
  | { kind: "comment"; repo: string; number: number; body: string }
  | { kind: "move"; itemId: string; restId: number; lane: string };

export interface ProposedAction {
  label: string;
  steps: ActionStep[];
  /** The exact `gh` command lines the CLI would print for the same decision. */
  ghCommands: string[];
}

export interface BoardFields {
  title: string;
  project_id: string;
  status_field_id: string;
  status_field_rest_id: number;
  options: Record<string, string>;
}
