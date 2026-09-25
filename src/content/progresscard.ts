/** What a reviewer sees for an 'Issues - In progress' card: each assignee with Jev's reading of them (active,
 *  waiting out a check-in, quiet), and one action, the suggested one preselected, that the reviewer can change. */
import {
  decideProgressCard,
  PROGRESS_LABEL,
  PROGRESS_TINT,
  progressActions,
  progressSteps,
  type AssigneeVerdict,
  type ProgressAction,
  type ProgressResult,
} from "../core/inprogress";
import type { ActionStep, BoardItem } from "../core/types";
import { actionBox, allReadings, describe, readingsBlock, select } from "./hcparts";
import type { SidebarAdapter } from "./evidence";
import type { Applied } from "./hovercard";
import { h } from "./ui";

export function chosenProgress(r: ProgressResult, o: { action?: string }): ProgressAction {
  const a = o.action as ProgressAction | undefined;
  return a && progressActions(r).includes(a) ? a : decideProgressCard(r).action;
}

function assigneeLine(a: AssigneeVerdict): string {
  const last =
    a.last_activity_days_ago === null ? "no activity" : `last active ${a.last_activity_days_ago}d ago`;
  return a.verdict === "active"
    ? `${a.login}: active, ${last}`
    : `${a.login}: ${a.verdict === "wait" ? "waiting on a check-in" : "quiet"}, ${last}. ${a.why}`;
}

function heading(r: ProgressResult, action: ProgressAction): HTMLElement {
  const d = decideProgressCard(r);
  const tint = PROGRESS_TINT[action].toLowerCase();
  return h(
    "div.snba-decision",
    {},
    h(
      "div",
      {},
      h(`span.snba-verdict.snba-${tint}`, {}, PROGRESS_LABEL[action]),
      action !== d.action
        ? h("span.snba-muted", {}, ` (suggested: ${PROGRESS_LABEL[d.action].toLowerCase()})`)
        : null,
    ),
    h("p.snba-why", {}, d.why),
  );
}

function facts(r: ProgressResult): [string, Node | string][] {
  const out: [string, Node | string][] = [];
  out.push([
    "Assignees",
    r.assignees.length
      ? h("span.snba-lines", {}, ...r.assignees.map((a) => h("span", {}, assigneeLine(a))))
      : "none",
  ]);
  if (!r.sig_node) out.push(["Labels", "no sig/node"]);
  return out;
}

export interface ProgressHoverContent {
  /** The action\'s steps with the Prow fixes added. */
  fix(steps: ActionStep[]): ActionStep[];
  item: BoardItem;
  result: ProgressResult;
  overrides: { action?: string };
  setOverride(key: string, value: string): void;
  applied: Applied | undefined;
  canApply: boolean;
  scope: ParentNode;
  apply(): void;
  skip(): void;
}

export function renderProgressHoverCard(c: ProgressHoverContent): HTMLElement {
  const r = c.result;
  const locked = c.applied?.state === "pending" || c.applied?.state === "done" || !c.canApply;
  const action = chosenProgress(r, c.overrides);
  const suggested = decideProgressCard(r).action;
  const sel = select(
    "Action",
    "action",
    progressActions(r).map((a): [string, string] => [
      a,
      a === suggested ? `${PROGRESS_LABEL[a]} (suggested)` : PROGRESS_LABEL[a],
    ]),
    action,
    locked,
    (v) => c.setOverride("action", v),
  );
  const body = h(
    "div.snba-hc-body",
    {},
    heading(r, action),
    readingsBlock(allReadings(r)),
    h(
      "dl.snba-hc-scores.snba-hc-facts",
      {},
      ...facts(r).flatMap(([k, v]) => [h("dt", {}, k), h("dd.snba-hc-text", {}, v)]),
      h("dt", {}, "Action"),
      h("dd.snba-hc-text", {}, h("span.snba-hc-prio", {}, sel)),
    ),
  );
  const box = actionBox({
    scope: c.scope,
    applied: c.applied,
    canApply: c.canApply,
    label: PROGRESS_LABEL[action],
    steps: c.fix(progressSteps(c.item, r, action)),
    where: "",
    apply: c.apply,
    skip: c.skip,
  });
  body.append(box);
  return body;
}

export type ProgressPaneState =
  { state: "pending" } | { state: "error"; message: string } | { state: "done"; result: ProgressResult };

export function renderProgressEvidence(
  adapter: SidebarAdapter,
  item: BoardItem,
  st: ProgressPaneState,
  rejudge: (i: BoardItem) => Promise<void>,
  title: string,
): HTMLElement {
  const { root, body } = adapter.section(title);
  root.classList.add("snba-evidence");
  root.dataset.snbaItem = String(item.restId);
  const again = h("button.snba-link", { type: "button" }, "Judge again") as HTMLButtonElement;
  again.title = "Re-read the thread and linked PRs and ask Jev again";
  again.addEventListener("click", async () => {
    again.disabled = true;
    try {
      await rejudge(item);
    } finally {
      again.disabled = false;
    }
  });
  if (st.state === "pending") {
    body.append(h("p.snba-muted", {}, "Reading the thread and linked PRs, and asking Jev…"));
    return root;
  }
  if (st.state === "error") {
    body.append(h("p.snba-error", {}, st.message), again);
    return root;
  }
  const r = st.result;
  const action = decideProgressCard(r).action;
  body.append(
    heading(r, action),
    readingsBlock(allReadings(r)),
    ...facts(r).map(([k, v]) => adapter.row(k, v)),
    h("div.snba-subhead", {}, "What the suggested action does"),
    h("p.snba-muted", {}, describe(progressSteps(item, r, action))),
    h("div.snba-foot", {}, again),
  );
  return root;
}
