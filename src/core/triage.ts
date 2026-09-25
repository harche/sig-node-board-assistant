/** Everything for one Triage item: state, Jev answers, verdict, priority, lane, and the actions a reviewer could
 *  take. The actions are *described*; nothing in this module (or this extension) executes them. */
import type { JevClient } from "./jev";
import { decide, prLane, priority } from "./policy";
import { triageQuestions } from "./prompts/triage";
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
  const a = r.answers;
  const { verdict, why } = decide(a, sig);
  const prio = priority(a, sig);
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
    usage: r.usage,
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

export function prowCommand(kind: ItemKind, repo: string, num: number, prio: string): string {
  const tool = kind === "PullRequest" ? "pr" : "issue";
  return `gh ${tool} comment ${num} --repo ${repo} --body ${q(`/triage accepted\n/priority ${prio}`)}`;
}

/** The accept / reject alternatives for a judged item and which one the verdict recommends. */
export function proposedActions(
  item: BoardItem,
  r: TriageResult,
  fields: BoardFields,
): { accept: ProposedAction; reject: ProposedAction; recommended: "accept" | "reject" | null } {
  const { repository: repo, number: num, type: kind } = item;
  const sig = r.signals;
  const needsProw = !(sig.triage_accepted_already && sig.priority_label_already);
  const prowBody = `/triage accepted\n/priority ${r.priority}`;
  const accept: ProposedAction = {
    label: `ACCEPT: /triage accepted + /priority ${r.priority}, move to '${r.lane}'`,
    steps: [
      ...(needsProw ? [{ kind: "comment" as const, repo, number: num, body: prowBody }] : []),
      { kind: "move" as const, itemId: item.id, restId: item.restId, lane: r.lane },
    ],
    ghCommands: [
      ...(needsProw ? [prowCommand(kind, repo, num, r.priority)] : []),
      moveCommand(item.id, r.lane, fields),
    ],
  };
  const reject: ProposedAction = {
    label: "REJECT: move to 'Archive-it'",
    steps: [{ kind: "move", itemId: item.id, restId: item.restId, lane: "Archive-it" }],
    ghCommands: [moveCommand(item.id, "Archive-it", fields)],
  };
  const recommended = r.verdict === "KEEP" ? "accept" : r.verdict === "REMOVE" ? "reject" : null;
  return { accept, reject, recommended };
}
