/** The SIG Node Bugs board's (kubernetes/185) Triage column: kind/bug issues routed to SIG Node. The board's only
 *  automations are added/reopened -> Triage and closed -> Done; nothing moves a card when its labels change, so
 *  every decision here pairs the Prow comment with the Status move the column descriptions ask for:
 *  triage/accepted -> Triaged, priority critical-urgent or important-soon -> High Priority, triage/needs-information
 *  -> Needs Information, anything leaving the board -> Done (there is no archive column).
 *
 *  The flow is the community issue-triage guide's (kubernetes/community contributors/guide/issue-triage.md): a
 *  support request is redirected and closed, a report another SIG owns is handed over, a feature filed as a bug is
 *  relabelled, a report nobody can act on asks the reporter, and a real SIG Node bug is accepted with a priority.
 *  Labels a human already set decide on their own; Jev reads the rest. On 284 kubernetes/kubernetes node issues
 *  from 2025–26, the decisions Accept applies matched the first human triage decision 8/8 (support), 5/7 (needs
 *  information) and 140/195 (accept, the base rate); feature requests, other SIGs and the less sure calls agreed
 *  far less often, so they wait for the reviewer. */
import { choiceReading, noulReading, type Reading } from "./readings";
import { isBot } from "./boards";
import type { JevClient } from "./jev";
import { f2 } from "./policy";
import {
  BUG_PRIORITIES,
  bugQuestions,
  FACTS,
  missingQuestions,
  OTHER_SIGS,
  priorityQuestion,
  sigQuestion,
  type Fact,
} from "./prompts/bugs";
import type { ProwFix } from "./prowcmds";
import { pyJsonLength } from "./state";
import type { ActionStep, BoardItem, ItemDetail, JevChoice, JevNoul, JevScore, JevUsage } from "./types";

export const BUG_ACTIONS = [
  "accept",
  "needs_info",
  "support",
  "feature",
  "other_sig",
  "done",
  "keep",
] as const;
export type BugAction = (typeof BUG_ACTIONS)[number];

export const BUG_LABEL: Record<BugAction, string> = {
  accept: "Accept",
  needs_info: "Ask for information",
  support: "Close as a support request",
  feature: "Relabel as a feature",
  other_sig: "Hand to another SIG",
  done: "Move to Done",
  keep: "Leave in Triage",
};

export const BUG_TINT: Record<BugAction, "KEEP" | "REMOVE" | "BORDERLINE" | "MOVE"> = {
  accept: "KEEP",
  needs_info: "MOVE",
  support: "REMOVE",
  feature: "REMOVE",
  other_sig: "REMOVE",
  done: "REMOVE",
  keep: "BORDERLINE",
};

export const LANE = {
  high: "High Priority",
  triaged: "Triaged",
  info: "Needs Information",
  done: "Done",
} as const;

/** Thresholds, from the evaluation above. */
export const SUPPORT_AT = 0.7; // P(support request) at or above: Accept closes it
export const SUPPORT_ASK_AT = 0.5; // at or above: suggested, the reviewer decides
export const FEATURE_AT = 0.5; // P(feature request): suggested only; triagers accepted most of these as bugs
export const OTHER_AT = 0.5; // P(another SIG owns it): suggested only
export const INFO_AT = 0.3; // P(enough information) at or below: Accept asks the reporter
export const INFO_ASK_AT = 0.5; // below: asking is suggested, the reviewer decides
export const DRA_AT = 0.5;

/** Prow state labels; they decide on their own. Classification labels (kind, sig) are only read to skip a command
 *  that would change nothing. */
export interface BugLabels {
  triage_accepted: boolean;
  needs_information: boolean;
  not_reproducible: boolean;
  priority: string | null;
  sig_node: boolean;
  wg_device_management: boolean;
  kind_bug: boolean;
}

export function bugLabels(labels: string[]): BugLabels {
  const L = new Set(labels);
  return {
    triage_accepted: L.has("triage/accepted"),
    needs_information: L.has("triage/needs-information"),
    not_reproducible: L.has("triage/not-reproducible"),
    priority: labels.find((l) => l.startsWith("priority/"))?.slice("priority/".length) ?? null,
    sig_node: L.has("sig/node"),
    wg_device_management: L.has("wg/device-management"),
    kind_bug: L.has("kind/bug"),
  };
}

export interface BugAnswers {
  report: JevChoice;
  owner: JevChoice;
  dra: JevNoul;
  enough_information: JevNoul;
}

export interface BugResult {
  kind: "bugs";
  item_id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  labels: BugLabels;
  /** Humans who routed it here with /sig node; a topic-ownership hand-over is not suggested over them. */
  routed_by: string[];
  /** Null when the labels already decide and Jev was not asked. */
  answers: BugAnswers | null;
  priority: string | null;
  priority_why: string;
  /** For a report another SIG owns: which one. */
  sig: string | null;
  /** For a report that needs information: what to ask for. */
  missing: Fact[];
  prow_fixes?: ProwFix[];
  /** Every answer Jev gave, labelled, for the bars on the hover card and the pane. */
  readings?: Reading[];
  usage: JevUsage;
  state_chars: number;
}

const p = (c: JevChoice, k: string) => c.probabilities[k] ?? (c.choice === k ? c.confidence : 0);

/** The suggested action, why, and whether the header's Accept may apply it without the reviewer picking it. */
export function decideBug(r: BugResult): { action: BugAction; why: string; auto: boolean } {
  const L = r.labels;
  if (r.state !== "open") return { action: "done", why: "closed", auto: true };
  // A triager's label already decided; the card only needs the move the column descriptions ask for.
  if (L.triage_accepted)
    return {
      action: "accept",
      why: L.priority ? `already triage/accepted, priority/${L.priority}` : "already triage/accepted",
      auto: true,
    };
  if (L.needs_information || L.not_reproducible)
    return {
      action: "needs_info",
      why: `already triage/${L.needs_information ? "needs-information" : "not-reproducible"}`,
      auto: true,
    };
  const a = r.answers;
  if (!a) return { action: "keep", why: "Jev was not asked", auto: false };
  const support = p(a.report, "support_question");
  if (support >= SUPPORT_ASK_AT)
    return {
      action: "support",
      why: `P(support request)=${f2(support)}`,
      auto: support >= SUPPORT_AT,
    };
  const feature = p(a.report, "feature_request");
  if (feature >= FEATURE_AT)
    return { action: "feature", why: `P(feature request, not a bug)=${f2(feature)}`, auto: false };
  const other = p(a.owner, "other");
  if (other >= OTHER_AT) {
    if (r.routed_by.length)
      return {
        action: "accept",
        why: `P(another SIG owns it)=${f2(other)}, but ${r.routed_by.join(", ")} routed it here with /sig node`,
        auto: false,
      };
    return { action: "other_sig", why: `P(SIG ${r.sig} owns it, not SIG Node)=${f2(other)}`, auto: false };
  }
  const info = a.enough_information.noul;
  if (info < INFO_ASK_AT)
    return { action: "needs_info", why: `P(enough information to start)=${f2(info)}`, auto: info <= INFO_AT };
  return { action: "accept", why: `a SIG Node bug; P(enough information)=${f2(info)}`, auto: true };
}

export function laneFor(priority: string | null): string {
  return priority === "critical-urgent" || priority === "important-soon" ? LANE.high : LANE.triaged;
}

/** Actions the reviewer can pick on the card. */
export function bugActions(r: BugResult): BugAction[] {
  if (r.state !== "open") return ["done", "keep"];
  return BUG_ACTIONS.filter((x) => x !== "done" && (x !== "other_sig" || r.sig !== null));
}

export const BUG_PREFIX = {
  info: "Thanks for the report. To look into this, SIG Node needs a few more details:",
  support:
    "Thanks for the report. This reads as a support question rather than a bug in Kubernetes, and GitHub issues are not the place for support. Please ask on the Kubernetes Slack (https://slack.k8s.io, #sig-node or #kubernetes-users) or the forum (https://discuss.kubernetes.io). If it turns out to be a bug, reopen this with the details.",
  other: (sig: string) =>
    `This looks like code SIG ${sig} owns, so handing it over. Add /sig node back if SIG Node is needed.`,
} as const;

const DRA_LINE = "/wg device-management";

/** Whether the /wg line is added: a DRA report without the label. */
const draLine = (r: BugResult) =>
  r.answers && r.answers.dra.noul >= DRA_AT && !r.labels.wg_device_management ? [DRA_LINE] : [];

/** Accept: /triage accepted and the priority, replacing a different one; only what is not already set. */
export function acceptBody(r: BugResult, priority: string): string | null {
  const L = r.labels;
  const lines = [
    ...(L.triage_accepted ? [] : ["/triage accepted"]),
    ...(L.priority && L.priority !== priority ? [`/remove-priority ${L.priority}`] : []),
    ...(L.priority === priority ? [] : [`/priority ${priority}`]),
    ...draLine(r),
  ];
  return lines.length ? lines.join("\n") : null;
}

export function needsInfoBody(r: BugResult): string | null {
  if (r.labels.needs_information || r.labels.not_reproducible) return null;
  const facts = r.missing.length ? r.missing : (["reproduction", "logs"] as Fact[]);
  return [
    BUG_PREFIX.info,
    ...facts.map((f) => `- ${FACTS[f]}`),
    "",
    "/triage needs-information",
    ...draLine(r),
  ].join("\n");
}

export function supportBody(r: BugResult): string {
  return [
    BUG_PREFIX.support,
    "",
    "/kind support",
    ...(r.labels.kind_bug ? ["/remove-kind bug"] : []),
    "/close",
  ].join("\n");
}

export function featureBody(r: BugResult): string {
  return ["/kind feature", ...(r.labels.kind_bug ? ["/remove-kind bug"] : [])].join("\n");
}

export function otherSigBody(sig: string, r: BugResult): string {
  return [BUG_PREFIX.other(sig), "", ...(r.labels.sig_node ? ["/remove-sig node"] : []), `/sig ${sig}`].join(
    "\n",
  );
}

/** What an action writes. `priority` and `sig` are the reviewer's picks where they changed Jev's. */
export function bugSteps(
  item: BoardItem,
  r: BugResult,
  action: BugAction,
  priority: string | null = r.priority,
  sig: string | null = r.sig,
): ActionStep[] {
  const { repository: repo, number } = item;
  const comment = (body: string | null): ActionStep[] =>
    body ? [{ kind: "comment", repo, number, body }] : [];
  const move = (lane: string): ActionStep => ({ kind: "move", itemId: item.id, restId: item.restId, lane });
  switch (action) {
    case "keep":
      return [];
    case "done":
      return [move(LANE.done)];
    case "accept": {
      const prio = priority ?? r.labels.priority;
      if (!prio) return [];
      return [...comment(acceptBody(r, prio)), move(laneFor(prio))];
    }
    case "needs_info":
      return [...comment(needsInfoBody(r)), move(LANE.info)];
    case "support":
      return [...comment(supportBody(r)), move(LANE.done)];
    case "feature":
      return [...comment(featureBody(r)), move(LANE.done)];
    case "other_sig":
      return sig ? [...comment(otherSigBody(sig, r)), move(LANE.done)] : [];
  }
}

/** The comment shapes above, and nothing else (comments.ts). */
export function isBugComment(body: string): boolean {
  const lines = body.split("\n");
  const cmds = lines.filter((l) => l.startsWith("/"));
  const text = lines.filter((l) => !l.startsWith("/") && l !== "");
  const onlyCmds = (allowed: (l: string) => boolean) => cmds.length > 0 && cmds.every(allowed);
  const prio = (l: string, cmd: string) => BUG_PRIORITIES.some((x) => l === `${cmd} ${x}`);
  if (!text.length)
    return (
      onlyCmds(
        (l) =>
          l === "/triage accepted" || prio(l, "/priority") || prio(l, "/remove-priority") || l === DRA_LINE,
      ) || onlyCmds((l) => l === "/kind feature" || l === "/remove-kind bug")
    );
  if (text[0] === BUG_PREFIX.info) {
    const bullets = new Set(Object.values(FACTS).map((f) => `- ${f}`));
    return (
      text.slice(1).length > 0 &&
      text.slice(1).every((l) => bullets.has(l)) &&
      cmds.includes("/triage needs-information") &&
      cmds.every((l) => l === "/triage needs-information" || l === DRA_LINE)
    );
  }
  if (text.length === 1 && text[0] === BUG_PREFIX.support)
    return (
      cmds.at(-1) === "/close" &&
      cmds.every((l) => ["/kind support", "/remove-kind bug", "/close"].includes(l))
    );
  const sig = OTHER_SIGS.find((s) => text.length === 1 && text[0] === BUG_PREFIX.other(s));
  return (
    Boolean(sig) &&
    cmds.at(-1) === `/sig ${sig}` &&
    cmds.every((l) => l === "/remove-sig node" || l === `/sig ${sig}`)
  );
}

// ---------------------------------------------------------------------------------------------------- judging

const SIG_NODE = /^\s*\/sig\s+node\b/im;

/** What Jev reads: the report and the human thread, never labels (bot- and reporter-set, unreliable). */
export function bugState(item: BoardItem, d: ItemDetail) {
  const reporter = d.author.login;
  const human = d.comments
    .filter((c) => !isBot(c.author.login) && c.body.trim())
    .map((c) => ({
      author: c.author.login === reporter ? `${c.author.login} (reporter)` : c.author.login,
      text: c.body.slice(0, 1000),
    }))
    .slice(-10);
  const routing = d.comments
    .filter((c) => !isBot(c.author.login))
    .flatMap((c) =>
      [...c.body.matchAll(/^\s*\/(remove-)?(sig|area|wg)\s+([\w-]+)/gim)].map((m) => ({
        author: c.author.login,
        command: `/${m[1] ?? ""}${m[2]!.toLowerCase()} ${m[3]!.toLowerCase()}`,
      })),
    );
  return {
    type: "issue",
    repository: item.repository,
    title: d.title,
    description: (d.body ?? "").slice(0, 8000),
    human_comments: human,
    ...(routing.length ? { human_routing: routing } : {}),
  };
}

function scorePriority(s: JevScore | undefined): { priority: string; why: string } {
  // Score levels run backlog (0) to critical-urgent (3).
  const levels = [...BUG_PRIORITIES].reverse();
  if (!s) return { priority: "important-longterm", why: "default; Jev gave no level" };
  let best = 0;
  let level = -1;
  for (let i = 0; i < levels.length; i++) {
    const v = s.probabilities[String(i)] ?? 0;
    if (v > best) [best, level] = [v, i];
  }
  if (level < 0) return { priority: "important-longterm", why: "default; Jev gave no level" };
  return { priority: levels[level]!, why: "Jev's pick" };
}

function setPriority(r: BugResult, a: { priority: JevScore }): void {
  const s = scorePriority(a.priority);
  r.priority = s.priority;
  r.priority_why = s.why;
  r.readings = [
    ...(r.readings ?? []),
    ...choiceReading("Priority", a.priority, [...BUG_PRIORITIES].reverse()),
  ];
}

export async function judgeBug(
  item: BoardItem,
  d: ItemDetail,
  jev: JevClient,
  refresh = false,
): Promise<BugResult> {
  const labels = bugLabels(d.labels.map((l) => l.name));
  const routed_by = [
    ...new Set(
      d.comments.filter((c) => !isBot(c.author.login) && SIG_NODE.test(c.body)).map((c) => c.author.login),
    ),
  ].sort();
  const state = bugState(item, d);
  const usage: JevUsage = { input_tokens: 0, cost: 0, cached: true };
  const ask = async <A>(q: Record<string, unknown>): Promise<A> => {
    const r = await jev.askCached<A>(state, q, 4, refresh);
    usage.input_tokens += r.usage.input_tokens;
    usage.cost += r.usage.cost;
    usage.cached = usage.cached && r.usage.cached;
    return r.answers;
  };
  const r: BugResult = {
    kind: "bugs",
    item_id: item.id,
    repo: item.repository,
    number: item.number,
    title: d.title,
    url: item.url,
    state: d.state.toLowerCase() === "open" ? "open" : "closed",
    labels,
    routed_by,
    answers: null,
    priority: labels.priority,
    priority_why: labels.priority ? "already labelled" : "",
    sig: null,
    missing: [],
    usage,
    state_chars: pyJsonLength(state),
  };
  if (r.state !== "open") return r;
  // Needs information already decided, unless triage/accepted is also set: then accepted wins (decideBug). Only the
  // priority is asked, for a reviewer who accepts it because the reporter has since answered.
  if (!labels.triage_accepted && (labels.needs_information || labels.not_reproducible)) {
    if (!labels.priority) setPriority(r, await ask<{ priority: JevScore }>(priorityQuestion()));
    return r;
  }
  if (!labels.triage_accepted) {
    // Which SIG would own it is asked every time (Jev calls are near free), so the reviewer can hand any card over.
    const [answers, sig] = await Promise.all([
      ask<BugAnswers>(bugQuestions()),
      ask<{ sig: JevChoice }>(sigQuestion()),
    ]);
    r.answers = answers;
    r.sig = OTHER_SIGS.includes(sig.sig.choice as never) ? sig.sig.choice : null;
    r.readings = [
      ...choiceReading("Kind of report", answers.report),
      ...choiceReading("Owner", answers.owner),
      ...choiceReading("If not SIG Node, which SIG", sig.sig),
      ...noulReading(
        "Enough information",
        answers.enough_information,
        answers.enough_information.noul < INFO_ASK_AT,
      ),
      ...noulReading("About DRA", answers.dra),
    ];
  }
  const first = decideBug(r);
  // The follow-up questions only for the actions that use them. The priority is asked for any open card without
  // one, since the reviewer may still pick Accept.
  const [prio, missing] = await Promise.all([
    labels.priority ? null : ask<{ priority: JevScore }>(priorityQuestion()),
    first.action === "needs_info" ? ask<Record<string, JevNoul>>(missingQuestions()) : null,
  ]);
  if (prio) setPriority(r, prio);
  if (missing)
    r.readings = [
      ...(r.readings ?? []),
      ...(Object.keys(FACTS) as Fact[]).flatMap((f) =>
        noulReading(`Needs ${FACTS[f]}`, missing[`missing_${f}`]),
      ),
    ];
  if (missing)
    r.missing = (Object.keys(FACTS) as Fact[]).filter((f) => (missing[`missing_${f}`]?.noul ?? 0) >= 0.5);
  return r;
}
