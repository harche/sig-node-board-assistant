/** The worker's allow-list for comments: only the shapes the extension drafts, in every column. Command lines
 *  (lines starting with "/") are limited to the Prow commands those drafts use. Only the nudge and the unassign
 *  mention anyone, one assignee each; every other shape is refused if it mentions someone. */
import { PROGRESS_PREFIX } from "./inprogress";
import { isFixComment } from "./prowcmds";
import { APPROVE_PREFIX } from "./approver";
import { AUTHOR_PREFIX } from "./author";
import { isBugComment } from "./bugs";
import { isInfoComment } from "./needsinfo";
import { REVIEW_PREFIX } from "./reviewer";
import { PRIORITY_CHOICES } from "./policy";
import { COMMENT_PREFIX } from "./todo";

/** Triage's Accept: the triage acceptance and a priority, replacing a different one if set. */
const TRIAGE = /^\/triage accepted\n(\/remove-priority [a-z-]+\n)?\/priority [a-z-]+$/;
const LOGIN = /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const MENTION = /(^|[^\w`])@[A-Za-z0-9]/;

export function isDraftedComment(body: string): boolean {
  if (!body.trim()) return false;
  if (TRIAGE.test(body)) return true;
  // SIG Node Bugs' Triage: accept, ask for information, support, feature, hand to another SIG.
  if (isBugComment(body)) return true;
  // SIG Node Bugs' Needs Information: remind the reporter, close without an answer, accept once answered.
  if (isInfoComment(body)) return true;
  // Any column: a fix for Prow commands someone mistyped (routing, labels, assignment; never /lgtm or /approve).
  if (isFixComment(body)) return true;
  const lines = body.split("\n");
  const commands = lines.filter((l) => l.startsWith("/"));
  const text = lines.filter((l) => !l.startsWith("/")).join("\n");
  const labelCommand = (l: string) =>
    l === "/triage accepted" || PRIORITY_CHOICES.some((p) => l === `/priority ${p}`);
  // To do: the missing labels, and nothing else.
  if (!text) return commands.every(labelCommand);
  // To do: close as fixed or as a duplicate, with /close on its own last line.
  if (text.startsWith(COMMENT_PREFIX.fixed) || text.startsWith(COMMENT_PREFIX.duplicate))
    return lines.length === 2 && lines[1] === "/close" && !MENTION.test(text);
  // Needs Reviewer: /cc up to three people, one "@login: reason" line each, then the drafted closing line.
  if (lines[0]?.startsWith("/cc ")) {
    const cc = lines[0].slice(4).split(" ");
    if (!cc.length || cc.length > 3 || !cc.every((x) => LOGIN.test(x))) return false;
    const reasons = lines.slice(1, -1);
    return (
      (lines.at(-1) === REVIEW_PREFIX.ask || lines.at(-1) === APPROVE_PREFIX.ask) &&
      reasons.length === cc.length &&
      reasons.every((l, i) => l.startsWith(`${cc[i]}: `) && !MENTION.test(l.slice(cc[i]!.length + 2)))
    );
  }
  // In progress: /unassign one assignee, then the drafted reason.
  if (lines[0]?.startsWith("/unassign "))
    return (
      lines.length === 2 &&
      LOGIN.test(lines[0].slice("/unassign ".length)) &&
      lines[1]!.startsWith(PROGRESS_PREFIX.unassign) &&
      !MENTION.test(lines[1]!)
    );
  if (commands.length) return false;
  // In progress: the nudge to one assignee, who is its only mention.
  const [first, ...rest] = text.split(" ");
  const after = rest.join(" ");
  if (LOGIN.test(first ?? "") && after.startsWith(PROGRESS_PREFIX.nudge)) return !MENTION.test(after);
  // Waiting on Author: the nudge to the PR's author.
  if (LOGIN.test(first ?? "") && after.startsWith(AUTHOR_PREFIX.nudge)) return !MENTION.test(after);
  // Needs Reviewer: a re-ping of one reviewer.
  if (
    LOGIN.test(first ?? "") &&
    [REVIEW_PREFIX.reping, REVIEW_PREFIX.asked, REVIEW_PREFIX.hold, APPROVE_PREFIX.reping].includes(
      after as never,
    )
  )
    return true;
  // To do and In progress: asking the thread what is left.
  return (text.startsWith(COMMENT_PREFIX.ask) || text.startsWith(PROGRESS_PREFIX.ask)) && !MENTION.test(text);
}
