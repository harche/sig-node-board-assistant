/** What a reviewer sees for a card in the SIG Node Bugs board's Needs Information column: Jev's readings of the
 *  thread since the ask, the dates behind the wait, and one action, the suggested one preselected. */
import { laneFor } from "../core/bugs";
import {
  decideInfo,
  INFO_LABEL,
  INFO_TINT,
  infoActions,
  infoSteps,
  type InfoAction,
  type InfoResult,
} from "../core/needsinfo";
import { BUG_PRIORITIES } from "../core/prompts/bugs";
import type { ActionStep, BoardItem } from "../core/types";
import type { SidebarAdapter } from "./evidence";
import type { Applied } from "./hovercard";
import { actionBox, allReadings, describe, fact, readingsBlock, select } from "./hcparts";
import { h } from "./ui";

export interface InfoOverrides {
  action?: string;
  priority?: string;
}

export function chosenInfo(r: InfoResult, o: InfoOverrides): InfoAction {
  const a = o.action as InfoAction | undefined;
  return a && infoActions(r).includes(a) ? a : decideInfo(r).action;
}

export function chosenInfoSteps(item: BoardItem, r: InfoResult, o: InfoOverrides): ActionStep[] {
  return infoSteps(item, r, chosenInfo(r, o), o.priority ?? r.priority);
}

function heading(r: InfoResult, action: InfoAction, picked = false): HTMLElement {
  const d = decideInfo(r);
  return h(
    "div.snba-decision",
    {},
    h(
      "div",
      {},
      h(`span.snba-verdict.snba-${INFO_TINT[action].toLowerCase()}`, {}, INFO_LABEL[action]),
      action !== d.action
        ? h("span.snba-muted", {}, ` (suggested: ${INFO_LABEL[d.action].toLowerCase()})`)
        : !d.auto && !picked
          ? h("span.snba-muted", {}, " (your call: Accept skips it until you choose an action)")
          : null,
    ),
    h("p.snba-why", {}, d.why),
  );
}

function facts(r: InfoResult): [string, Node | string][] {
  const out: [string, Node | string][] = [];
  const days = (d: number | null, what: string) => (d === null ? `no ${what}` : `${d}d ago`);
  out.push(["Asked", days(r.asked_days_ago, "ask in the timeline")]);
  out.push([
    "Reporter",
    `${r.reporter}; ${r.reporter_replied_days_ago === null ? "no reply since the ask" : `replied ${r.reporter_replied_days_ago}d ago`}`,
  ]);
  if (r.reminded_days_ago !== null) out.push(["Reminded", `${r.reminded_days_ago}d ago`]);
  const set = [
    r.labels.triage_accepted && "triage/accepted",
    r.labels.needs_information && "triage/needs-information",
    r.labels.not_reproducible && "triage/not-reproducible",
    r.labels.priority && `priority/${r.labels.priority}`,
  ].filter(Boolean);
  out.push(["Labels", set.length ? set.join(", ") : "no triage label"]);
  return out;
}

export interface InfoHoverContent {
  fix(steps: ActionStep[]): ActionStep[];
  item: BoardItem;
  result: InfoResult;
  overrides: InfoOverrides;
  setOverride(key: string, value: string): void;
  applied: Applied | undefined;
  canApply: boolean;
  scope: ParentNode;
  apply(): void;
  skip(): void;
}

export function renderInfoHoverCard(c: InfoHoverContent): HTMLElement {
  const r = c.result;
  const o = c.overrides;
  const locked = c.applied?.state === "pending" || c.applied?.state === "done" || !c.canApply;
  const action = chosenInfo(r, o);
  const d = decideInfo(r);
  const unpicked = !d.auto && !o.action;
  const rows: HTMLElement[] = fact(
    "Action",
    h(
      "span.snba-hc-prio",
      {},
      select(
        "Action",
        "action",
        infoActions(r).map((a): [string, string] => [
          a,
          a === d.action ? `${INFO_LABEL[a]} (suggested)` : INFO_LABEL[a],
        ]),
        unpicked ? null : action,
        locked,
        (v) => c.setOverride("action", v),
        unpicked ? "Choose an action…" : undefined,
      ),
    ),
  );
  const prio = o.priority ?? r.priority;
  if (action === "accept" && prio && !r.labels.priority)
    rows.push(
      ...fact(
        "Priority",
        h(
          "span.snba-hc-prio",
          {},
          select(
            "Priority",
            "priority",
            BUG_PRIORITIES.map((p) => [p, p]),
            prio,
            locked,
            (v) => c.setOverride("priority", v),
          ),
          h(
            "span.snba-muted",
            {},
            `${prio === r.priority ? r.priority_why : `changed from ${r.priority}`}; to '${laneFor(prio)}'`,
          ),
        ),
      ),
    );
  return h(
    "div.snba-hc-body",
    {},
    heading(r, action, Boolean(o.action)),
    readingsBlock(allReadings(r)),
    h("dl.snba-hc-scores.snba-hc-facts", {}, ...facts(r).flatMap(([k, v]) => fact(k, v)), ...rows),
    actionBox({
      scope: c.scope,
      applied: c.applied,
      canApply: c.canApply,
      label: INFO_LABEL[action],
      steps: c.fix(chosenInfoSteps(c.item, r, o)),
      where: "in Needs Information",
      apply: c.apply,
      skip: c.skip,
    }),
  );
}

export type InfoPaneState =
  { state: "pending" } | { state: "error"; message: string } | { state: "done"; result: InfoResult };

export function renderInfoEvidence(
  adapter: SidebarAdapter,
  item: BoardItem,
  st: InfoPaneState,
  rejudge: (i: BoardItem) => Promise<void>,
  title: string,
): HTMLElement {
  const { root, body } = adapter.section(title);
  root.classList.add("snba-evidence");
  root.dataset.snbaItem = String(item.restId);
  const again = h("button.snba-link", { type: "button" }, "Judge again") as HTMLButtonElement;
  again.title = "Re-read the thread and ask Jev again";
  again.addEventListener("click", async () => {
    again.disabled = true;
    try {
      await rejudge(item);
    } finally {
      again.disabled = false;
    }
  });
  if (st.state === "pending") {
    body.append(h("p.snba-muted", {}, "Reading the thread and asking Jev…"));
    return root;
  }
  if (st.state === "error") {
    body.append(h("p.snba-error", {}, st.message), again);
    return root;
  }
  const r = st.result;
  const action = decideInfo(r).action;
  body.append(
    heading(r, action),
    readingsBlock(allReadings(r)),
    ...facts(r).map(([k, v]) => adapter.row(k, v)),
    h("div.snba-subhead", {}, "What the suggested action does"),
    h("p.snba-muted", {}, describe(infoSteps(item, r, action))),
    h("div.snba-foot", {}, again),
  );
  return root;
}
