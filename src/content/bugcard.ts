/** What a reviewer sees for a card in the SIG Node Bugs board's Triage column: Jev's reading of the report (what
 *  kind it is, who owns it, whether a maintainer can start on it), the labels a triager already set, and one
 *  action, the suggested one preselected, with the priority or the SIG it sets. */
import { pageButton } from "./adapters";
import {
  BUG_LABEL,
  BUG_TINT,
  bugActions,
  bugSteps,
  decideBug,
  laneFor,
  type BugAction,
  type BugResult,
} from "../core/bugs";
import { BUG_PRIORITIES, FACTS, OTHER_SIGS } from "../core/prompts/bugs";
import type { ActionStep, BoardItem } from "../core/types";
import { actionBox, allReadings, describe, fact, readingsBlock, select } from "./hcparts";
import type { SidebarAdapter } from "./evidence";
import type { Applied } from "./hovercard";
import { h } from "./ui";

export interface BugOverrides {
  action?: string;
  priority?: string;
  sig?: string;
}

export function chosenBug(r: BugResult, o: BugOverrides): BugAction {
  const a = o.action as BugAction | undefined;
  return a && bugActions(r).includes(a) ? a : decideBug(r).action;
}

export function chosenBugSteps(item: BoardItem, r: BugResult, o: BugOverrides): ActionStep[] {
  return bugSteps(item, r, chosenBug(r, o), o.priority ?? r.priority, o.sig ?? r.sig);
}

function heading(r: BugResult, action: BugAction, picked = false): HTMLElement {
  const d = decideBug(r);
  const tint = BUG_TINT[action].toLowerCase();
  return h(
    "div.snba-decision",
    {},
    h(
      "div",
      {},
      h(`span.snba-verdict.snba-${tint}`, {}, BUG_LABEL[action]),
      action !== d.action
        ? h("span.snba-muted", {}, ` (suggested: ${BUG_LABEL[d.action].toLowerCase()})`)
        : !d.auto && !picked
          ? h("span.snba-muted", {}, " (your call: Accept skips it until you choose an action)")
          : null,
    ),
    h("p.snba-why", {}, d.why),
  );
}

function facts(r: BugResult): [string, Node | string][] {
  const out: [string, Node | string][] = [];
  if (r.missing.length) out.push(["Missing", r.missing.map((f) => FACTS[f]).join("; ")]);
  const set = [
    r.labels.triage_accepted && "triage/accepted",
    r.labels.needs_information && "triage/needs-information",
    r.labels.not_reproducible && "triage/not-reproducible",
    r.labels.priority && `priority/${r.labels.priority}`,
  ].filter(Boolean);
  out.push(["Labels", set.length ? set.join(", ") : "no triage or priority label yet"]);
  if (r.routed_by.length) out.push(["Routed by", `${r.routed_by.join(", ")} (/sig node)`]);
  return out;
}

export interface BugHoverContent {
  /** The action's steps with the Prow fixes added. */
  fix(steps: ActionStep[]): ActionStep[];
  item: BoardItem;
  result: BugResult;
  overrides: BugOverrides;
  setOverride(key: string, value: string): void;
  applied: Applied | undefined;
  canApply: boolean;
  scope: ParentNode;
  apply(): void;
  skip(): void;
}

/** The facts that are not probabilities. */
function notes(r: BugResult): HTMLElement[] {
  const set = [
    r.labels.triage_accepted && "triage/accepted",
    r.labels.needs_information && "triage/needs-information",
    r.labels.not_reproducible && "triage/not-reproducible",
    r.labels.priority && `priority/${r.labels.priority}`,
  ].filter(Boolean);
  return [
    ...(r.missing.length ? fact("Missing", r.missing.map((f) => FACTS[f]).join("; ")) : []),
    ...fact("Labels", set.length ? set.join(", ") : "no triage or priority label yet"),
    ...(r.routed_by.length ? fact("Routed by", `${r.routed_by.join(", ")} (/sig node)`) : []),
  ];
}

export function renderBugHoverCard(c: BugHoverContent): HTMLElement {
  const r = c.result;
  const o = c.overrides;
  const locked = c.applied?.state === "pending" || c.applied?.state === "done" || !c.canApply;
  const action = chosenBug(r, o);
  const d = decideBug(r);
  // On a card Jev was unsure of, nothing is picked until the reviewer chooses, the suggestion included: re-picking
  // an option the select already shows fires no change event.
  const unpicked = !d.auto && !o.action;
  const rows: HTMLElement[] = fact(
    "Action",
    h(
      "span.snba-hc-prio",
      {},
      select(
        "Action",
        "action",
        bugActions(r).map((a): [string, string] => [
          a,
          a === d.action ? `${BUG_LABEL[a]} (suggested)` : BUG_LABEL[a],
        ]),
        unpicked ? null : action,
        locked,
        (v) => c.setOverride("action", v),
        unpicked ? "Choose an action…" : undefined,
      ),
    ),
  );
  const prio = o.priority ?? r.priority;
  // The priority an Accept sets, unless a triager already set one.
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
  const sig = o.sig ?? r.sig;
  if (action === "other_sig" && sig)
    rows.push(
      ...fact(
        "SIG",
        h(
          "span.snba-hc-prio",
          {},
          select(
            "SIG",
            "sig",
            OTHER_SIGS.map((s) => [s, s]),
            sig,
            locked,
            (v) => c.setOverride("sig", v),
          ),
        ),
      ),
    );
  return h(
    "div.snba-hc-body",
    {},
    heading(r, action, Boolean(o.action)),
    readingsBlock(allReadings(r)),
    h("dl.snba-hc-scores.snba-hc-facts", {}, ...notes(r), ...rows),
    actionBox({
      scope: c.scope,
      applied: c.applied,
      canApply: c.canApply,
      label: BUG_LABEL[action],
      steps: c.fix(chosenBugSteps(c.item, r, o)),
      where: "in Triage",
      apply: c.apply,
      skip: c.skip,
    }),
  );
}

export type BugPaneState =
  { state: "pending" } | { state: "error"; message: string } | { state: "done"; result: BugResult };

/** The section in GitHub's pane (and the issue page's sidebar). */
export function renderBugEvidence(
  adapter: SidebarAdapter,
  item: BoardItem,
  st: BugPaneState,
  rejudge: (i: BoardItem) => Promise<void>,
  title: string,
): HTMLElement {
  const { root, body } = adapter.section(title);
  root.classList.add("snba-evidence");
  root.dataset.snbaItem = String(item.restId);
  const again = pageButton("Judge again");
  again.title = "Re-read the report and ask Jev again";
  again.addEventListener("click", async () => {
    again.disabled = true;
    try {
      await rejudge(item);
    } finally {
      again.disabled = false;
    }
  });
  if (st.state === "pending") {
    body.append(h("p.snba-muted", {}, "Reading the report and asking Jev…"));
    return root;
  }
  if (st.state === "error") {
    body.append(h("p.snba-error", {}, st.message), again);
    return root;
  }
  const r = st.result;
  const action = decideBug(r).action;
  body.append(
    heading(r, action),
    readingsBlock(allReadings(r)),
    ...facts(r).map(([k, v]) => adapter.row(k, v)),
    h("div.snba-subhead", {}, "What the suggested action does"),
    h("p.snba-muted", {}, describe(bugSteps(item, r, action))),
    h(
      "div.snba-foot",
      {},
      h(
        "span.snba-muted",
        {},
        `Jev read ${r.state_chars.toLocaleString()} chars${r.usage.cached ? ", cached" : ` for $${r.usage.cost.toFixed(5)}`}.`,
      ),
      again,
    ),
  );
  return root;
}
