/** What a reviewer sees for a card in the SIG Node Bugs board's Triage column: Jev's reading of the report (what
 *  kind it is, who owns it, whether a maintainer can start on it), the labels a triager already set, and one
 *  action, the suggested one preselected, with the priority or the SIG it sets. */
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
import { f2 } from "../core/policy";
import { BUG_PRIORITIES, FACTS, OTHER_SIGS } from "../core/prompts/bugs";
import type { ActionStep, BoardItem } from "../core/types";
import { nativeButton } from "./adapters";
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

function describe(steps: ActionStep[]): string {
  if (!steps.length) return "nothing to write";
  return steps
    .map((st) =>
      st.kind === "comment" ? `comment "${st.body.replaceAll("\n", " ")}"` : `move to '${st.lane}'`,
    )
    .join(", then ");
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

const pct = (probs: Record<string, number>) =>
  Object.entries(probs)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k.replaceAll("_", " ")} ${f2(v)}`)
    .join(", ");

function facts(r: BugResult): [string, Node | string][] {
  const out: [string, Node | string][] = [];
  const a = r.answers;
  if (a) {
    out.push(["Report", pct(a.report.probabilities)]);
    out.push(["Owner", `${pct(a.owner.probabilities)}${r.sig ? `; if not SIG Node, SIG ${r.sig}` : ""}`]);
    out.push(["Enough info", `P ${f2(a.enough_information.noul)}`]);
    if (a.dra.noul >= 0.5) out.push(["DRA", `P ${f2(a.dra.noul)}; adds /wg device-management`]);
  }
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

function select(
  label: string,
  key: string,
  options: [string, string][],
  current: string,
  locked: boolean,
  onChange: (v: string) => void,
): HTMLSelectElement {
  const sel = h(
    "select.snba-hc-select",
    { "aria-label": label, "data-focus-key": key },
    ...options.map(([v, text]) => {
      const o = h("option", { value: v }, text) as HTMLOptionElement;
      o.selected = v === current;
      return o;
    }),
  ) as HTMLSelectElement;
  sel.disabled = locked;
  // The board treats keys and clicks inside a card as its own; keep them in the select.
  for (const ev of ["click", "keydown", "mousedown"]) sel.addEventListener(ev, (e) => e.stopPropagation());
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
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

export function renderBugHoverCard(c: BugHoverContent): HTMLElement {
  const r = c.result;
  const o = c.overrides;
  const locked = c.applied?.state === "pending" || c.applied?.state === "done" || !c.canApply;
  const action = chosenBug(r, o);
  const d = decideBug(r);
  const suggested = d.action;
  // On a card Jev was unsure of, nothing is picked until the reviewer chooses, the suggestion included: re-picking
  // an option the select already shows fires no change event.
  const unpicked = !d.auto && !o.action;
  const actionSel = select(
    "Action",
    "action",
    [
      ...(unpicked ? ([["", "Choose an action…"]] as [string, string][]) : []),
      ...bugActions(r).map((a): [string, string] => [
        a,
        a === suggested ? `${BUG_LABEL[a]} (suggested)` : BUG_LABEL[a],
      ]),
    ],
    unpicked ? "" : action,
    locked,
    (v) => c.setOverride("action", v),
  );
  if (unpicked) (actionSel.options[0] as HTMLOptionElement).disabled = true;
  const rows: [string, Node | string][] = [["Action", h("span.snba-hc-prio", {}, actionSel)]];
  const prio = o.priority ?? r.priority;
  // The priority an Accept sets, unless a triager already set one.
  if (action === "accept" && prio && !r.labels.priority)
    rows.push([
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
    ]);
  const sig = o.sig ?? r.sig;
  if (action === "other_sig" && sig)
    rows.push([
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
    ]);
  const body = h(
    "div.snba-hc-body",
    {},
    heading(r, action, Boolean(o.action)),
    h(
      "dl.snba-hc-scores.snba-hc-facts",
      {},
      ...[...facts(r), ...rows].flatMap(([k, v]) => [h("dt", {}, k), h("dd.snba-hc-text", {}, v)]),
    ),
  );
  const box = h("div.snba-hc-actions");
  if (c.applied?.state === "done") {
    box.append(h("p.snba-hc-status", {}, "Applied."));
  } else {
    const steps = c.fix(chosenBugSteps(c.item, r, o));
    const apply = nativeButton(c.scope, null, "Apply", "primary").root;
    apply.classList.add("snba-hc-btn");
    if (locked || !steps.length) apply.setAttribute("aria-disabled", "true");
    apply.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (apply.getAttribute("aria-disabled") !== "true") c.apply();
    });
    const skip = nativeButton(c.scope, null, "Skip", "invisible").root;
    skip.classList.add("snba-hc-btn");
    if (locked) skip.setAttribute("aria-disabled", "true");
    skip.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (skip.getAttribute("aria-disabled") !== "true") c.skip();
    });
    box.append(
      h("div.snba-hc-buttons", {}, apply, skip),
      h(
        "ul.snba-hc-steps",
        {},
        h("li", {}, h("b", {}, BUG_LABEL[action]), h("span.snba-muted", {}, `: ${describe(steps)}`)),
        h(
          "li",
          {},
          h("b", {}, "Skip"),
          h(
            "span.snba-muted",
            {},
            ": leave it in Triage untouched and drop the verdict; Accept passes over it",
          ),
        ),
      ),
    );
    if (c.applied?.state === "pending") box.append(h("p.snba-hc-status", {}, "Applying…"));
    else if (c.applied?.state === "error")
      box.append(h("p.snba-hc-status.snba-error", {}, c.applied.message));
    else if (!c.canApply) box.append(h("p.snba-hc-status.snba-muted", {}, "Waiting for Accept to finish."));
  }
  body.append(box);
  return body;
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
  const again = h("button.snba-link", { type: "button" }, "Judge again") as HTMLButtonElement;
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
