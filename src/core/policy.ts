/** Decision policy: code-owned and transparent. Jev supplies calibrated probabilities; these functions turn them
 *  into a verdict, a priority and a lane, and say why in one line. */
import type { Signals, TriageAnswers, Verdict } from "./types";

export const KEEP_AT = 0.65; // P(in scope) outside this band decides; inside it, the tie-breaker does
export const REMOVE_AT = 0.35;
export const CI_WORK = new Set(["failing_or_flaking_test", "test_coverage", "ci_infrastructure"]);
export const PRIORITIES = ["backlog", "important-longterm", "important-soon"]; // the priority Score's levels, in order
export const PRIORITY_DEFAULT = "important-longterm";
export const OWNER_OTHER_AT = 0.6; // a confident "another SIG owns it" turns a KEEP into BORDERLINE

/** Two decimals the way Python's f"{x:.2f}" prints them: correctly rounded from the exact binary value, ties to
 *  even. JS toFixed rounds ties up and V8 mis-rounds some values (0.665 -> "0.66"), which would make the "why"
 *  text disagree with the CLI for the same numbers. */
export function f2(n: number): string {
  const [int, frac = ""] = n.toFixed(20).split("."); // toFixed(20) is the exact decimal expansion, 20 places
  const keep = frac.slice(0, 2).padEnd(2, "0");
  const rest = frac.slice(2);
  let up: boolean;
  if (rest[0]! > "5") up = true;
  else if (rest[0]! < "5") up = false;
  else if (/[1-9]/.test(rest.slice(1))) up = true;
  else up = Number(keep[1]) % 2 === 1; // exact tie: to even
  const v = Number(`${int!.replace("-", "")}${keep}`) + (up ? 1 : 0);
  const sign = n < 0 && v !== 0 ? "-" : "";
  const str = String(v).padStart(3, "0");
  return `${sign}${str.slice(0, -2)}.${str.slice(-2)}`;
}

/** Grey-zone score: P(the deliverable is CI work) x P(SIG Node owns it), from two independent questions. */
export function tieBreak(a: TriageAnswers): { m: number; ci: number } {
  const ci = Object.entries(a.bucket.probabilities)
    .filter(([k]) => CI_WORK.has(k))
    .reduce((s, [, p]) => s + p, 0);
  return { m: ci * (a.owner.probabilities.node ?? 0), ci };
}

export function decide(a: TriageAnswers, sig: Signals): { verdict: Verdict; why: string } {
  const p = a.in_scope.noul;
  let verdict: Verdict;
  let why: string;
  if (p >= KEEP_AT) {
    verdict = "KEEP";
    why = `P(in scope)=${f2(p)}`;
  } else if (p <= REMOVE_AT) {
    verdict = "REMOVE";
    why = `P(in scope)=${f2(p)}`;
  } else {
    const { m, ci } = tieBreak(a);
    verdict = m >= KEEP_AT ? "KEEP" : m <= REMOVE_AT ? "REMOVE" : "BORDERLINE";
    why =
      `P(in scope)=${f2(p)} is in the grey zone; tie-break P(CI work)=${f2(ci)} x ` +
      `P(node owns it)=${f2(a.owner.probabilities.node ?? 0)} = ${f2(m)}`;
  }
  if (verdict === "REMOVE" && sig.manual_sig_node_routing_present) {
    const who = [
      ...new Set(sig.human_slash_routing_comments.filter((r) => r.cmd === "/sig node").map((r) => r.who)),
    ]
      .sort()
      .join(", ");
    verdict = "BORDERLINE";
    why += `; but a human (${who}) routed it with /sig node, which the rules say overrides a topic-ownership REMOVE`;
  }
  if (verdict === "KEEP" && a.owner.choice === "other" && a.owner.confidence >= OWNER_OTHER_AT) {
    // In scope by topic but Jev is confident another SIG owns the component: a human should look before it is accepted.
    verdict = "BORDERLINE";
    why += `; but Jev thinks another SIG owns it (conf ${f2(a.owner.confidence)})`;
  }
  return { verdict, why };
}

/** A priority/* label a human already set wins; otherwise the default. Jev's Score is shown as a hint only: on
 *  past board decisions it never beat always answering the default, at any confidence gate. */
export function priority(a: TriageAnswers, sig: Signals): { priority: string; why: string } {
  if (sig.priority_label_already) {
    return { priority: sig.priority_label_already.split("/").slice(1).join("/"), why: "already labelled" };
  }
  const s = a.priority;
  let level = 0;
  for (let i = 1; i < PRIORITIES.length; i++)
    if ((s.probabilities[String(i)] ?? 0) > (s.probabilities[String(level)] ?? 0)) level = i;
  return {
    priority: PRIORITY_DEFAULT,
    why: `default; Jev leans ${PRIORITIES[level]} (conf ${f2(s.confidence)})`,
  };
}

/** Review lane from Prow/GitHub state; code, not Jev (it matched the board as well as Jev did). */
export function prLane(sig: Signals): string {
  if (sig.is_draft || (sig.blocked_labels?.length ?? 0) > 0 || sig.review_decision === "CHANGES_REQUESTED") {
    return "PRs Waiting on Author";
  }
  if (sig.has_lgtm_label || sig.review_decision === "APPROVED") return "PRs - Needs Approver";
  return "PRs - Needs Reviewer";
}
