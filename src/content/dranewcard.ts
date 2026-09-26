/** What a reviewer sees for a card in the Dynamic Resource Allocation board's New column: for an open issue, Jev's
 *  pick of column as bars and the facts behind it (linked PRs, assignees, the release cycle); for a PR, its state.
 *  One action, the suggested one preselected unless it is the reviewer's call. */
import {
  decideDraNew,
  DRA_NEW_LABEL,
  DRA_NEW_TINT,
  draNewActions,
  draNewSteps,
  type DraNewAction,
  type DraNewResult,
} from "../core/dranew";
import type { ActionStep, BoardItem } from "../core/types";
import type { SidebarAdapter } from "./evidence";
import type { Applied } from "./hovercard";
import { actionBox, allReadings, describe, fact, readingsBlock, select } from "./hcparts";
import { h } from "./ui";

export interface DraNewOverrides {
  action?: string;
}

export function chosenDraNew(r: DraNewResult, o: DraNewOverrides): DraNewAction {
  const a = o.action as DraNewAction | undefined;
  return a && draNewActions(r).includes(a) ? a : decideDraNew(r).action;
}

export function chosenDraNewSteps(item: BoardItem, r: DraNewResult, o: DraNewOverrides): ActionStep[] {
  return draNewSteps(item, chosenDraNew(r, o));
}

function heading(r: DraNewResult, action: DraNewAction, picked = false): HTMLElement {
  const d = decideDraNew(r);
  return h(
    "div.snba-decision",
    {},
    h(
      "div",
      {},
      h(`span.snba-verdict.snba-${DRA_NEW_TINT[action].toLowerCase()}`, {}, DRA_NEW_LABEL[action]),
      action !== d.action
        ? h("span.snba-muted", {}, ` (suggested: ${DRA_NEW_LABEL[d.action].toLowerCase()})`)
        : !d.auto && !picked
          ? h("span.snba-muted", {}, " (your call: Accept skips it until you choose an action)")
          : null,
    ),
    h("p.snba-why", {}, d.why),
  );
}

const lines = (xs: string[]) => h("span.snba-lines", {}, ...xs.map((x) => h("span", {}, x)));

function facts(r: DraNewResult): [string, Node | string][] {
  const out: [string, Node | string][] = [];
  if (r.type === "PullRequest") {
    out.push(["PR", r.state === "open" ? (r.draft ? "open, draft" : "open") : r.state]);
    return out;
  }
  if (r.state !== "open") return [["Issue", r.state]];
  out.push([
    "PRs",
    r.linked_prs.length
      ? lines(
          r.linked_prs.map((p) => `#${p.number} ${p.state}, opened ${p.opened_days_ago}d ago: ${p.title}`),
        )
      : "none reference it",
  ]);
  out.push(["Assigned", r.assignees.join(", ") || "nobody"]);
  if (r.development_cycle) out.push(["Cycle", `${r.development_cycle} in development`]);
  return out;
}

export interface DraNewHoverContent {
  fix(steps: ActionStep[]): ActionStep[];
  item: BoardItem;
  result: DraNewResult;
  overrides: DraNewOverrides;
  setOverride(key: string, value: string): void;
  applied: Applied | undefined;
  canApply: boolean;
  scope: ParentNode;
  apply(): void;
  skip(): void;
}

export function renderDraNewHoverCard(c: DraNewHoverContent): HTMLElement {
  const r = c.result;
  const o = c.overrides;
  const locked = c.applied?.state === "pending" || c.applied?.state === "done" || !c.canApply;
  const action = chosenDraNew(r, o);
  const d = decideDraNew(r);
  const unpicked = !d.auto && !o.action;
  return h(
    "div.snba-hc-body",
    {},
    heading(r, action, Boolean(o.action)),
    readingsBlock(allReadings(r)),
    h(
      "dl.snba-hc-scores.snba-hc-facts",
      {},
      ...facts(r).flatMap(([k, v]) => fact(k, v)),
      ...fact(
        "Action",
        h(
          "span.snba-hc-prio",
          {},
          select(
            "Action",
            "action",
            draNewActions(r).map((a): [string, string] => [
              a,
              a === d.action ? `${DRA_NEW_LABEL[a]} (suggested)` : DRA_NEW_LABEL[a],
            ]),
            unpicked ? null : action,
            locked,
            (v) => c.setOverride("action", v),
            unpicked ? "Choose an action…" : undefined,
          ),
        ),
      ),
    ),
    actionBox({
      scope: c.scope,
      applied: c.applied,
      canApply: c.canApply,
      label: DRA_NEW_LABEL[action],
      steps: c.fix(chosenDraNewSteps(c.item, r, o)),
      where: "in New",
      apply: c.apply,
      skip: c.skip,
    }),
  );
}

export type DraNewPaneState =
  { state: "pending" } | { state: "error"; message: string } | { state: "done"; result: DraNewResult };

export function renderDraNewEvidence(
  adapter: SidebarAdapter,
  item: BoardItem,
  st: DraNewPaneState,
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
  const action = decideDraNew(r).action;
  body.append(
    heading(r, action),
    readingsBlock(allReadings(r)),
    ...facts(r).map(([k, v]) => adapter.row(k, v)),
    h("div.snba-subhead", {}, "What the suggested action does"),
    h("p.snba-muted", {}, describe(draNewSteps(item, action))),
    h("div.snba-foot", {}, again),
  );
  return root;
}
