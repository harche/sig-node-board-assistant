/** Known SIG Node boards and the column semantics of the CI/Test board (kubernetes/151), the only board the
 *  triage workflow is written for. Other boards get no decoration until their workflows exist. */
import type { BoardRef } from "./types";

export interface KnownBoard extends BoardRef {
  title: string;
  about: string;
  /** Columns the extension decorates on this board, by workflow. */
  workflows: Record<string, string>;
  /** Whether Accept may write to this board (Status moves, Prow comments). Only the test board, for now. */
  writable?: boolean;
}

export const KNOWN_BOARDS: KnownBoard[] = [
  {
    owner: "kubernetes",
    number: 151,
    title: "SIG Node CI/Test Board",
    about: "CI health: failing and flaky tests, coverage gaps, test-infra jobs",
    workflows: { triage: "Triage", todo: "Issues - To do", progress: "Issues - In progress" },
  },
  {
    owner: "kubernetes",
    number: 185,
    title: "SIG Node Bugs",
    about: "kind/bug issues routed to SIG Node: triage, needs-information, priority",
    workflows: {},
  },
  {
    owner: "kubernetes",
    number: 95,
    title: "Dynamic Resource Allocation",
    about: "DRA feature work: KEPs, implementation issues and PRs, new to in-review",
    workflows: {},
  },
  {
    // Private copy of kubernetes/151 (same Status columns, views and workflows) over fake items in
    // harche/sig-node-board-test, for testing writes without touching the real board.
    owner: "harche",
    number: 5,
    title: "SIG Node CI/Test Board (test)",
    about: "Test copy of kubernetes/151",
    workflows: { triage: "Triage", todo: "Issues - To do", progress: "Issues - In progress" },
    writable: true,
  },
];

export function knownBoard(ref: BoardRef): KnownBoard | undefined {
  return KNOWN_BOARDS.find((b) => b.owner === ref.owner && b.number === ref.number);
}

/** `https://github.com/orgs/kubernetes/projects/151/views/1` -> { owner, number }; undefined for other pages. */
export function boardFromUrl(url: string): BoardRef | undefined {
  const m = /^https:\/\/github\.com\/(?:orgs|users)\/([^/]+)\/projects\/(\d+)(?:[/?#]|$)/.exec(url);
  return m ? { owner: m[1]!, number: Number(m[2]) } : undefined;
}

export const BOTS = new Set([
  "k8s-ci-robot",
  "kubernetes-prow",
  "k8s-triage-robot",
  "kubernetes-triage-robot",
  "github-actions",
]);

/** REST reports app accounts as "name[bot]". */
export function isBot(login: string): boolean {
  return login.endsWith("[bot]") || BOTS.has(login);
}
