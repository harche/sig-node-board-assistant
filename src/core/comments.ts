/** The worker's allow-list for comments: only the shapes the extension drafts, in every column. Command lines
 *  (lines starting with "/") are limited to the Prow commands those drafts use. Only the nudge and the unassign
 *  mention anyone, one assignee each; every other shape is refused if it mentions someone. */
import { PROGRESS_PREFIX } from "./inprogress";
import { PRIORITY_CHOICES } from "./policy";
import { COMMENT_PREFIX } from "./todo";

/** Triage's Accept: the triage acceptance and a priority, replacing a different one if set. */
const TRIAGE = /^\/triage accepted\n(\/remove-priority [a-z-]+\n)?\/priority [a-z-]+$/;
const LOGIN = /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const MENTION = /(^|[^\w`])@[A-Za-z0-9]/;

export function isDraftedComment(body: string): boolean {
  if (!body.trim()) return false;
  if (TRIAGE.test(body)) return true;
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
  // To do and In progress: asking the thread what is left.
  return (text.startsWith(COMMENT_PREFIX.ask) || text.startsWith(PROGRESS_PREFIX.ask)) && !MENTION.test(text);
}
