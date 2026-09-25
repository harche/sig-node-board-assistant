/** Everything for one Triage item: state, Jev answers, verdict, priority, lane, and the actions a reviewer could
 *  take. The actions are *described*; nothing in this module (or this extension) executes them. */
import type { JevClient } from "./jev";
import { decide, prLane, priority } from "./policy";
import { priorityQuestion, triageQuestions } from "./prompts/triage";
import { signals } from "./signals";
import { buildState, pyJsonLength } from "./state";
import type {
  BoardFields,
  BoardItem,
  ItemDetail,
  ItemKind,
  ProposedAction,
  TriageAnswers,
  TriageResult,
} from "./types";

export async function judge(
  item: BoardItem,
  d: ItemDetail,
  jev: JevClient,
  refresh = false,
): Promise<TriageResult> {
  const kind = item.type;
  const sig = signals(d, kind);
  const state = buildState(item, d, kind);
  const r = await jev.askCached<TriageAnswers>(state, triageQuestions(kind), 4, refresh);
  const a: TriageAnswers = { ...r.answers };
  const usage = { ...r.usage };
  const { verdict, why } = decide(a, sig);
  // Priority only matters for an item that stays on the board, and a label a human already set wins anyway.
  const keeping = verdict !== "REMOVE";
  if (keeping && !sig.priority_label_already) {
    const p = await jev.askCached<Pick<TriageAnswers, "priority">>(state, priorityQuestion(kind), 4, refresh);
    a.priority = p.answers.priority;
    usage.input_tokens += p.usage.input_tokens;
    usage.cost += p.usage.cost;
    usage.cached = usage.cached && p.usage.cached;
  }
  const prio = keeping ? priority(a, sig) : { priority: null, why: "" };
  return {
    item_id: item.id,
    repo: item.repository,
    number: item.number,
    kind,
    title: d.title,
    url: item.url,
    verdict,
    why,
    priority: prio.priority,
    priority_why: prio.why,
    lane: kind === "PullRequest" ? prLane(sig) : "Issues - To do",
    answers: a,
    signals: sig,
    usage,
    state_chars: pyJsonLength(state),
  };
}

const q = (s: string) => (/[\s"'$`\\]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s);

export function moveCommand(itemId: string, lane: string, f: BoardFields): string {
  const opt = f.options[lane];
  return [
    "gh project item-edit --id",
    itemId,
    "--project-id",
    f.project_id,
    "--field-id",
    f.status_field_id,
    "--single-select-option-id",
    opt ?? `<no option named ${q(lane)}>`,
  ].join(" ");
}

/** The Prow comment that accepts an item at `prio`. Prow's /priority only adds a label, so a different priority
 *  already on the item (`from`) is removed in the same comment. */
export function prowBody(prio: string, from: string | null = null): string {
  const remove = from && from !== prio ? `/remove-priority ${from}\n` : "";
  return `/triage accepted\n${remove}/priority ${prio}`;
}

export function prowCommand(
  kind: ItemKind,
  repo: string,
  num: number,
  prio: string,
  from: string | null = null,
): string {
  const tool = kind === "PullRequest" ? "pr" : "issue";
  return `gh ${tool} comment ${num} --repo ${repo} --body ${q(prowBody(prio, from))}`;
}

/** The accept / reject alternatives for a judged item and which one the verdict recommends. */
export function proposedActions(
  item: BoardItem,
  r: TriageResult,
  fields: BoardFields,
): { accept: ProposedAction | null; reject: ProposedAction; recommended: "accept" | "reject" | null } {
  const { repository: repo, number: num, type: kind } = item;
  const sig = r.signals;
  const reject: ProposedAction = {
    label: "REJECT: move to 'Archive-it'",
    steps: [{ kind: "move", itemId: item.id, restId: item.restId, lane: "Archive-it" }],
    ghCommands: [moveCommand(item.id, "Archive-it", fields)],
  };
  // An item Jev says to remove is only ever archived: no /triage accepted, no priority.
  if (r.priority === null) return { accept: null, reject, recommended: "reject" };
  // r.priority may be the reviewer's pick rather than the label already there; then the comment changes it.
  const existing = sig.priority_label_already?.split("/").slice(1).join("/") ?? null;
  const needsProw = !(sig.triage_accepted_already && existing === r.priority);
  const prio = r.priority;
  const accept: ProposedAction = {
    label: `ACCEPT: /triage accepted + /priority ${prio}, move to '${r.lane}'`,
    steps: [
      ...(needsProw ? [{ kind: "comment" as const, repo, number: num, body: prowBody(prio, existing) }] : []),
      { kind: "move" as const, itemId: item.id, restId: item.restId, lane: r.lane },
    ],
    ghCommands: [
      ...(needsProw ? [prowCommand(kind, repo, num, prio, existing)] : []),
      moveCommand(item.id, r.lane, fields),
    ],
  };
  const recommended = r.verdict === "KEEP" ? "accept" : r.verdict === "REMOVE" ? "reject" : null;
  return { accept, reject, recommended };
}
