/** What a reviewer sees for an 'Issues - To do' card: the hover card on the board and the section in GitHub's pane.
 *  Jev's P(resolved) on a band, the facts behind it (CI runs, linked PRs, assignees, labels, a likely duplicate),
 *  and one action, Jev's pick preselected, that the reviewer can change before applying it. */
import { f2, PRIORITY_CHOICES } from "../core/policy";
import {
  ACTION_LABEL,
  ACTION_TINT,
  availableActions,
  decideTodo,
  OPEN_AT,
  RESOLVED_AT,
  todoSteps,
  type TodoAction,
  type TodoResult,
} from "../core/todo";
import type { JobSignal } from "../core/testgrid";
import type { ActionStep, BoardItem } from "../core/types";
import { nativeButton } from "./adapters";
import type { EvidenceHandlers, SidebarAdapter } from "./evidence";
import type { Applied } from "./hovercard";
import { h } from "./ui";

/** Per-card choices the reviewer made in place of the suggested ones. */
export interface TodoOverrides {
  action?: TodoAction;
  priority?: string;
}

export function chosenAction(r: TodoResult, o: TodoOverrides): TodoAction {
  return o.action && availableActions(r).includes(o.action) ? o.action : decideTodo(r).action;
}

export function chosenSteps(item: BoardItem, r: TodoResult, o: TodoOverrides): ActionStep[] {
  return todoSteps(item, r, chosenAction(r, o), o.priority ?? r.priority);
}

/** Verdict line and the P(resolved) band: low keeps the card, high closes it. */
export function todoDecision(r: TodoResult, o: TodoOverrides = {}): HTMLElement {
  const p = r.answers.resolved.noul;
  const d = decideTodo(r);
  const action = chosenAction(r, o);
  const tint = ACTION_TINT[action].toLowerCase();
  return h(
    "div.snba-decision",
    {},
    h(
      "div",
      {},
      h(`span.snba-verdict.snba-${tint === "move" ? "move" : tint}`, {}, ACTION_LABEL[action]),
      action !== d.action
        ? h("span.snba-muted", {}, ` (Jev: ${ACTION_LABEL[d.action].toLowerCase()})`)
        : null,
    ),
    h(
      "div.snba-band.snba-band-todo",
      {
        role: "img",
        "aria-label": `Resolved with probability ${f2(p)}; at or below ${OPEN_AT} it stays, at or above ${RESOLVED_AT} it closes`,
      },
      h("span.snba-marker", { style: `left:${p * 100}%` }),
    ),
    h(
      "div.snba-scale",
      {},
      h("span", {}, "open"),
      h("span", {}, String(OPEN_AT)),
      h("span", {}, String(RESOLVED_AT)),
      h("span", {}, "resolved"),
    ),
    h("p.snba-why", {}, d.why),
  );
}

/** One line per CI job: the tracked tests (or the whole job when none were found) over TestGrid's window. */
export function ciLines(ci: JobSignal[]): string[] {
  return ci.map((j) => {
    const rows = typeof j.tracked_tests === "string" ? null : j.tracked_tests;
    const r = rows?.[0] ?? j.whole_job;
    if (!r) return `${j.job}: no runs`;
    const what = rows ? (rows.length > 1 ? `${rows.length} tests` : "test") : "whole job (test not found)";
    const last =
      r.last_failure_days_ago === null
        ? "no failures"
        : `last failed ${r.last_failure_days_ago === 0 ? "today" : `${r.last_failure_days_ago}d ago`}, ${r.runs_since_last_failure} clean runs since`;
    return `${j.job} ${what}: ${r.failures}/${r.runs} failed in ${r.window_days}d, ${last}`;
  });
}

function facts(r: TodoResult): [string, Node | string][] {
  const out: [string, Node | string][] = [];
  const res = r.answers.resolution;
  const p = r.answers.resolved.noul;
  // How it was resolved only means something when it may be.
  if (p > OPEN_AT)
    out.push([
      "Resolution",
      `${res.choice.replaceAll("_", " ")} ${f2(res.probabilities[res.choice] ?? res.confidence)}`,
    ]);
  out.push(["CI", r.ci.length ? list(ciLines(r.ci)) : "no TestGrid history for the jobs it names"]);
  const merged = r.linked_prs.filter((x) => x.state === "merged");
  const open = r.linked_prs.filter((x) => x.state === "open");
  if (merged.length || open.length)
    out.push([
      "PRs",
      list([
        ...merged.slice(-3).map((x) => `#${x.number} merged ${x.merged_days_ago}d ago: ${x.title}`),
        ...open.slice(-2).map((x) => `#${x.number} open: ${x.title}`),
      ]),
    ]);
  if (r.rules.assignees.length) out.push(["Assigned", r.rules.assignees.join(", ")]);
  const missing = [
    !r.rules.triage_accepted && "triage/accepted",
    !r.rules.priority_label && "priority",
  ].filter(Boolean);
  if (missing.length)
    out.push([
      "Labels",
      `missing ${missing.join(" and ")}` +
        (r.rules.prow_typos.length
          ? `; ${r.rules.prow_typos.map((t) => `${t.who} wrote "${t.wrote}"`).join(", ")}, which Prow ignored`
          : ""),
    ]);
  if (r.duplicate)
    out.push([
      "Duplicate of",
      `#${r.duplicate.number} (${r.duplicate.status}, P ${f2(r.duplicate.p)}): ${r.duplicate.title}`,
    ]);
  // The guard only matters when Jev would close it.
  if (r.guard && p >= RESOLVED_AT) out.push(["Wait", r.guard]);
  return out;
}

function list(lines: string[]): HTMLElement {
  return h("span.snba-lines", {}, ...lines.map((l) => h("span", {}, l)));
}

function describe(steps: ActionStep[]): string {
  if (!steps.length) return "nothing to write";
  return steps
    .map((st) =>
      st.kind === "comment" ? `comment "${st.body.replaceAll("\n", " ")}"` : `move to '${st.lane}'`,
    )
    .join(", then ");
}

export interface TodoHoverContent {
  item: BoardItem;
  result: TodoResult;
  overrides: TodoOverrides;
  setOverride(key: keyof TodoOverrides, value: string): void;
  applied: Applied | undefined;
  canApply: boolean;
  scope: ParentNode;
  apply(): void;
  skip(): void;
}

export function renderTodoHoverCard(c: TodoHoverContent): HTMLElement {
  const r = c.result;
  const locked = c.applied?.state === "pending" || c.applied?.state === "done" || !c.canApply;
  const action = chosenAction(r, c.overrides);
  const rows = facts(r);
  const body = h(
    "div.snba-hc-body",
    {},
    h("div.snba-hc-title", {}, h("span.snba-muted", {}, `${r.repo}#${r.number} `), r.title),
    todoDecision(r, c.overrides),
    h(
      "dl.snba-hc-scores.snba-hc-facts",
      {},
      ...rows.flatMap(([k, v]) => [h("dt", {}, k), h("dd.snba-hc-text", {}, v)]),
      h("dt", {}, "Action"),
      h("dd.snba-hc-text", {}, actionSelect(c, action, locked)),
      ...(needsPriority(r, action)
        ? [h("dt", {}, "Priority"), h("dd.snba-hc-text", {}, prioritySelect(c, locked))]
        : []),
    ),
  );
  body.append(actions(c, action, locked));
  return body;
}

/** The priority select is shown when the comment would set one: the label is missing and the card stays. */
function needsPriority(r: TodoResult, action: TodoAction): boolean {
  return (
    !r.rules.priority_label && r.priority !== null && ["keep", "in_progress", "ask_thread"].includes(action)
  );
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

function actionSelect(c: TodoHoverContent, action: TodoAction, locked: boolean): HTMLElement {
  const jev = decideTodo(c.result).action;
  const sel = select(
    "Action",
    "action",
    availableActions(c.result).map((a) => [
      a,
      a === jev ? `${ACTION_LABEL[a]} (suggested)` : ACTION_LABEL[a],
    ]),
    action,
    locked,
    (v) => c.setOverride("action", v),
  );
  return h("span.snba-hc-prio", {}, sel);
}

function prioritySelect(c: TodoHoverContent, locked: boolean): HTMLElement {
  const suggested = c.result.priority!;
  const current = c.overrides.priority ?? suggested;
  const sel = select(
    "Priority",
    "priority",
    PRIORITY_CHOICES.map((p) => [p, p]),
    current,
    locked,
    (v) => c.setOverride("priority", v),
  );
  const note =
    current === suggested ? c.result.priority_why : `changed from ${suggested}, ${c.result.priority_why}`;
  return h("span.snba-hc-prio", {}, sel, h("span.snba-muted", {}, note));
}

function actions(c: TodoHoverContent, action: TodoAction, locked: boolean): HTMLElement {
  const box = h("div.snba-hc-actions");
  if (c.applied?.state === "done") {
    box.append(h("p.snba-hc-status", {}, "Applied."));
    return box;
  }
  const steps = chosenSteps(c.item, c.result, c.overrides);
  const row = h("div.snba-hc-buttons");
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
  row.append(apply, skip);
  box.append(
    row,
    h(
      "ul.snba-hc-steps",
      {},
      h("li", {}, h("b", {}, ACTION_LABEL[action]), h("span.snba-muted", {}, `: ${describe(steps)}`)),
      h(
        "li",
        {},
        h("b", {}, "Skip"),
        h("span.snba-muted", {}, ": leave it in To do untouched and drop the verdict; Accept passes over it"),
      ),
    ),
  );
  if (c.applied?.state === "pending") box.append(h("p.snba-hc-status", {}, "Applying…"));
  else if (c.applied?.state === "error") box.append(h("p.snba-hc-status.snba-error", {}, c.applied.message));
  else if (!c.canApply) box.append(h("p.snba-hc-status.snba-muted", {}, "Waiting for Accept to finish."));
  return box;
}

export type TodoEvidenceState =
  { state: "pending" } | { state: "error"; message: string } | { state: "done"; result: TodoResult };

/** The section in GitHub's pane (and the issue page's sidebar) for a To-do card. */
export function renderTodoEvidence(
  adapter: SidebarAdapter,
  item: BoardItem,
  st: TodoEvidenceState,
  handlers: EvidenceHandlers,
  title: string,
): HTMLElement {
  const { root, body } = adapter.section(title);
  root.classList.add("snba-evidence");
  root.dataset.snbaItem = String(item.restId);
  const again = h("button.snba-link", { type: "button" }, "Judge again") as HTMLButtonElement;
  again.title = "Re-fetch the thread, the linked PRs and TestGrid, and ask Jev again";
  again.addEventListener("click", async () => {
    again.disabled = true;
    try {
      await handlers.rejudge(item);
    } finally {
      again.disabled = false;
    }
  });
  if (st.state === "pending") {
    body.append(h("p.snba-muted", {}, "Reading the thread, linked PRs and TestGrid, and asking Jev…"));
    return root;
  }
  if (st.state === "error") {
    body.append(h("p.snba-error", {}, st.message), again);
    return root;
  }
  const r = st.result;
  body.append(todoDecision(r), ...facts(r).map(([k, v]) => adapter.row(k, v)));
  body.append(
    h("div.snba-subhead", {}, "What the suggested action does"),
    h("p.snba-muted", {}, describe(todoSteps(item, r, decideTodo(r).action))),
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
