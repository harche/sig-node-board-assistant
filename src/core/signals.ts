/** Signal extraction: facts the code computes itself, which Jev must not be asked to infer. */
import { isBot } from "./boards";
import type { ItemDetail, ItemKind, RoutingComment, Signals } from "./types";

const SIG_RE = /^\s*\/(sig|area)\s+([\w-]+)/gim;
export const TEST_PATH = /(^|\/)test\/|_test\.go$|^hack\/|^cluster\/|^build\/|jobs\//;

export function signals(d: ItemDetail, kind: ItemKind): Signals {
  const labels = d.labels.map((l) => l.name);
  const routing: RoutingComment[] = [];
  for (const c of d.comments) {
    const who = c.author.login;
    if (isBot(who)) continue;
    for (const m of (c.body ?? "").matchAll(SIG_RE)) {
      routing.push({ who, cmd: `/${m[1]!.toLowerCase()} ${m[2]!.toLowerCase()}` });
    }
  }
  const s: Signals = {
    human_slash_routing_comments: routing,
    manual_sig_node_routing_present: routing.some((r) => r.cmd === "/sig node"),
    human_comment_count: d.comments.filter((c) => !isBot(c.author.login)).length,
    // Prow *state* labels decide whether a /triage accepted comment is still needed. Classification labels
    // (sig/*, kind/*, area/*) are bot-applied and unreliable: never sent to Jev, never shown.
    triage_accepted_already: labels.includes("triage/accepted"),
    priority_label_already: labels.find((l) => l.startsWith("priority/")) ?? null,
  };
  if (kind === "PullRequest") {
    const files = d.files ?? [];
    const testFiles = files.filter((f) => TEST_PATH.test(f.path));
    s.is_draft = Boolean(d.isDraft);
    s.file_count = files.length;
    s.test_or_ci_file_count = testFiles.length;
    s.test_or_ci_file_share_percent = Math.round((100 * testFiles.length) / (files.length || 1));
    s.has_lgtm_label = labels.includes("lgtm"); // reviewer-issued Prow state, not a bot classification
    s.blocked_labels = labels.filter((l) => l.startsWith("do-not-merge/") || l === "needs-rebase").sort();
    s.review_decision = d.reviewDecision ?? null;
  }
  return s;
}
