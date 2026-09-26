/** What a reviewer sees for a card in the Dynamic Resource Allocation board's New and Backlog columns: for an open
 *  issue, Jev's pick of column as bars and the facts behind it (linked PRs, assignees, the release); for a PR, its
 *  state.
 *  One action, the suggested one preselected unless it is the reviewer's call. */
import {
  decideDra,
  COLUMN_TITLE,
  draLabel,
  DRA_TINT,
  draActions,
  draSteps,
  type DraAction,
  type DraColumn,
  type DraResult,
} from "../core/dra";
import type { ActionStep, BoardItem } from "../core/types";
import type { SidebarAdapter } from "./evidence";
import type { Applied } from "./hovercard";
import { actionBox, allReadings, describe, fact, readingsBlock, select } from "./hcparts";
import { h } from "./ui";

export interface DraOverrides {
  action?: string;
}

export function chosenDra(r: DraResult, o: DraOverrides): DraAction {
  const a = o.action as DraAction | undefined;
  return a && draActions(r).includes(a) ? a : decideDra(r).action;
}

export function chosenDraSteps(item: BoardItem, r: DraResult, o: DraOverrides): ActionStep[] {
  return draSteps(item, chosenDra(r, o));
}

function heading(r: DraResult, action: DraAction, picked = false): HTMLElement {
  const d = decideDra(r);
  return h(
    "div.snba-decision",
    {},
    h(
      "div",
      {},
      h(`span.snba-verdict.snba-${DRA_TINT[action].toLowerCase()}`, {}, draLabel(action, r.column)),
      action !== d.action
        ? h("span.snba-muted", {}, ` (suggested: ${draLabel(d.action, r.column).toLowerCase()})`)
        : !d.auto && !picked
          ? h("span.snba-muted", {}, " (your call: Accept skips it until you choose an action)")
          : null,
    ),
    h("p.snba-why", {}, d.why),
  );
}

const lines = (xs: string[]) => h("span.snba-lines", {}, ...xs.map((x) => h("span", {}, x)));

function facts(r: DraResult): [string, Node | string][] {
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
  if (r.milestone || r.opted_in)
    out.push([
      "Release",
      [r.milestone ?? "no milestone", r.opted_in && "lead-opted-in"].filter(Boolean).join(", "),
    ]);
  if (r.development_cycle) out.push(["Cycle", `${r.development_cycle} in development`]);
  return out;
}

export interface DraHoverContent {
  fix(steps: ActionStep[]): ActionStep[];
  item: BoardItem;
  result: DraResult;
  overrides: DraOverrides;
  setOverride(key: string, value: string): void;
  applied: Applied | undefined;
  canApply: boolean;
  scope: ParentNode;
  apply(): void;
  skip(): void;
}

export function renderDraHoverCard(c: DraHoverContent): HTMLElement {
  const r = c.result;
  const o = c.overrides;
  const locked = c.applied?.state === "pending" || c.applied?.state === "done" || !c.canApply;
  const action = chosenDra(r, o);
  const d = decideDra(r);
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
            draActions(r).map((a): [string, string] => [
              a,
              a === d.action ? `${draLabel(a, r.column)} (suggested)` : draLabel(a, r.column),
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
      label: draLabel(action, r.column),
      steps: c.fix(chosenDraSteps(c.item, r, o)),
      where: `in ${COLUMN_TITLE[r.column]}`,
      apply: c.apply,
      skip: c.skip,
    }),
  );
}

export type DraPaneState =
  { state: "pending" } | { state: "error"; message: string } | { state: "done"; result: DraResult };

export function renderDraEvidence(
  adapter: SidebarAdapter,
  item: BoardItem,
  st: DraPaneState,
  rejudge: (i: BoardItem) => Promise<void>,
  title: string,
  column: DraColumn,
): HTMLElement {
  const { root, body } = adapter.section(title);
  root.classList.add("snba-evidence");
  root.dataset.snbaItem = String(item.restId);
  const again = h("button.snba-link", { type: "button" }, "Judge again") as HTMLButtonElement;
  // In progress and In review are placed by state alone (dra.ts): no Jev there.
  const jev = column !== "progress" && column !== "review";
  again.title = jev ? "Re-read the thread and linked PRs and ask Jev again" : "Re-read the item";
  again.addEventListener("click", async () => {
    again.disabled = true;
    try {
      await rejudge(item);
    } finally {
      again.disabled = false;
    }
  });
  if (st.state === "pending") {
    body.append(
      h("p.snba-muted", {}, jev ? "Reading the thread and linked PRs, and asking Jev…" : "Reading the item…"),
    );
    return root;
  }
  if (st.state === "error") {
    body.append(h("p.snba-error", {}, st.message), again);
    return root;
  }
  const r = st.result;
  const action = decideDra(r).action;
  body.append(
    heading(r, action),
    readingsBlock(allReadings(r)),
    ...facts(r).map(([k, v]) => adapter.row(k, v)),
    h("div.snba-subhead", {}, "What the suggested action does"),
    h("p.snba-muted", {}, describe(draSteps(item, action))),
    h("div.snba-foot", {}, again),
  );
  return root;
}
