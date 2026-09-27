/** What a reviewer sees for a card in the SIG Node Bugs board's Triaged and High Priority columns: Jev's readings
 *  (fixed?, each assignee, the priority), the linked PRs and a likely duplicate, and one action, the suggested one
 *  preselected, with the priority that decides the column. */
import { pageButton } from "./adapters";
import {
  BACKLOG_LABEL,
  BACKLOG_TINT,
  backlogActions,
  backlogSteps,
  decideBacklog,
  type BacklogAction,
  type BacklogResult,
} from "../core/backlog";
import { laneFor } from "../core/bugs";
import { BUG_PRIORITIES } from "../core/prompts/bugs";
import type { ActionStep, BoardItem } from "../core/types";
import type { SidebarAdapter } from "./evidence";
import type { Applied } from "./hovercard";
import { actionBox, allReadings, describe, fact, readingsBlock, select } from "./hcparts";
import { h } from "./ui";

export interface BacklogOverrides {
  action?: string;
  priority?: string;
}

export function chosenBacklog(r: BacklogResult, o: BacklogOverrides): BacklogAction {
  const a = o.action as BacklogAction | undefined;
  return a && backlogActions(r).includes(a) ? a : decideBacklog(r).action;
}

export function chosenBacklogSteps(item: BoardItem, r: BacklogResult, o: BacklogOverrides): ActionStep[] {
  return backlogSteps(item, r, chosenBacklog(r, o), o.priority ?? r.priority);
}

const STAYS: BacklogAction[] = ["keep", "nudge", "unassign"];

function heading(r: BacklogResult, action: BacklogAction, picked = false): HTMLElement {
  const d = decideBacklog(r);
  return h(
    "div.snba-decision",
    {},
    h(
      "div",
      {},
      h(`span.snba-verdict.snba-${BACKLOG_TINT[action].toLowerCase()}`, {}, BACKLOG_LABEL[action]),
      action !== d.action
        ? h("span.snba-muted", {}, ` (suggested: ${BACKLOG_LABEL[d.action].toLowerCase()})`)
        : !d.auto && !picked
          ? h("span.snba-muted", {}, " (your call: Accept skips it until you choose an action)")
          : null,
    ),
    h("p.snba-why", {}, d.why),
  );
}

const lines = (xs: string[]) => h("span.snba-lines", {}, ...xs.map((x) => h("span", {}, x)));

function facts(r: BacklogResult): [string, Node | string][] {
  const out: [string, Node | string][] = [];
  const merged = r.linked_prs.filter((p) => p.state === "merged");
  const open = r.linked_prs.filter((p) => p.state === "open");
  if (merged.length || open.length)
    out.push([
      "PRs",
      lines([
        ...merged.slice(-3).map((p) => `#${p.number} merged ${p.merged_days_ago}d ago: ${p.title}`),
        ...open.slice(-2).map((p) => `#${p.number} open: ${p.title}`),
      ]),
    ]);
  out.push([
    "Assigned",
    r.progress?.assignees.length
      ? lines(
          r.progress.assignees.map(
            (a) =>
              `${a.login}${r.self_assigned.includes(a.login) ? "" : " (assigned by a triager, not pinged)"}: ${a.verdict === "active" ? "active" : a.verdict === "wait" ? "waiting on a check-in" : "quiet"}, ${
                a.last_activity_days_ago === null
                  ? "no activity"
                  : `last active ${a.last_activity_days_ago}d ago`
              }`,
          ),
        )
      : r.assignees.join(", ") || "nobody",
  ]);
  if (r.duplicate)
    out.push(["Duplicate of", `#${r.duplicate.number} (${r.duplicate.status}): ${r.duplicate.title}`]);
  const set = [
    r.labels.triage_accepted && "triage/accepted",
    r.labels.needs_information && "triage/needs-information",
    r.labels.priority && `priority/${r.labels.priority}`,
  ].filter(Boolean);
  out.push(["Labels", set.length ? set.join(", ") : "no triage or priority label"]);
  return out;
}

export interface BacklogHoverContent {
  fix(steps: ActionStep[]): ActionStep[];
  item: BoardItem;
  result: BacklogResult;
  overrides: BacklogOverrides;
  setOverride(key: string, value: string): void;
  applied: Applied | undefined;
  canApply: boolean;
  scope: ParentNode;
  apply(): void;
  skip(): void;
}

export function renderBacklogHoverCard(c: BacklogHoverContent): HTMLElement {
  const r = c.result;
  const o = c.overrides;
  const locked = c.applied?.state === "pending" || c.applied?.state === "done" || !c.canApply;
  const action = chosenBacklog(r, o);
  const d = decideBacklog(r);
  const unpicked = !d.auto && !o.action;
  const rows: HTMLElement[] = fact(
    "Action",
    h(
      "span.snba-hc-prio",
      {},
      select(
        "Action",
        "action",
        backlogActions(r).map((a): [string, string] => [
          a,
          a === d.action ? `${BACKLOG_LABEL[a]} (suggested)` : BACKLOG_LABEL[a],
        ]),
        unpicked ? null : action,
        locked,
        (v) => c.setOverride("action", v),
        unpicked ? "Choose an action…" : undefined,
      ),
    ),
  );
  // The priority decides the column; it can be changed for any card that stays.
  const prio = o.priority ?? r.priority;
  if (STAYS.includes(action) && prio)
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
            `${prio === r.priority ? r.priority_why : `changed from ${r.priority}`}; in '${laneFor(prio)}'`,
          ),
        ),
      ),
    );
  return h(
    "div.snba-hc-body",
    {},
    heading(r, action, Boolean(o.action)),
    readingsBlock(allReadings(r, dupReading(r))),
    h("dl.snba-hc-scores.snba-hc-facts", {}, ...facts(r).flatMap(([k, v]) => fact(k, v)), ...rows),
    actionBox({
      scope: c.scope,
      applied: c.applied,
      canApply: c.canApply,
      label: BACKLOG_LABEL[action],
      steps: c.fix(chosenBacklogSteps(c.item, r, o)),
      where: `in ${r.status}`,
      apply: c.apply,
      skip: c.skip,
    }),
  );
}

const dupReading = (r: BacklogResult) =>
  r.duplicate ? [{ label: `Same bug as #${r.duplicate.number}`, p: r.duplicate.p }] : [];

export type BacklogPaneState =
  { state: "pending" } | { state: "error"; message: string } | { state: "done"; result: BacklogResult };

export function renderBacklogEvidence(
  adapter: SidebarAdapter,
  item: BoardItem,
  st: BacklogPaneState,
  rejudge: (i: BoardItem) => Promise<void>,
  title: string,
): HTMLElement {
  const { root, body } = adapter.section(title);
  root.classList.add("snba-evidence");
  root.dataset.snbaItem = String(item.restId);
  const again = pageButton("Judge again");
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
  const action = decideBacklog(r).action;
  body.append(
    heading(r, action),
    readingsBlock(allReadings(r, dupReading(r))),
    ...facts(r).map(([k, v]) => adapter.row(k, v)),
    h("div.snba-subhead", {}, "What the suggested action does"),
    h("p.snba-muted", {}, describe(backlogSteps(item, r, action))),
    h("div.snba-foot", {}, again),
  );
  return root;
}
