/** What a reviewer sees for an 'Issues - In progress' card: each assignee with Jev's reading of them (active,
 *  waiting out a check-in, quiet), and one action, the suggested one preselected, that the reviewer can change. */
import { f2 } from "../core/policy";
import {
  decideProgressCard,
  PROGRESS_LABEL,
  PROGRESS_TINT,
  progressActions,
  STALE_DAYS,
  progressSteps,
  type AssigneeVerdict,
  type ProgressAction,
  type ProgressResult,
} from "../core/inprogress";
import type { ActionStep, BoardItem } from "../core/types";
import { nativeButton } from "./adapters";
import type { SidebarAdapter } from "./evidence";
import type { Applied } from "./hovercard";
import { h } from "./ui";

export function chosenProgress(r: ProgressResult, o: { action?: string }): ProgressAction {
  const a = o.action as ProgressAction | undefined;
  return a && progressActions(r).includes(a) ? a : decideProgressCard(r).action;
}

function describe(steps: ActionStep[]): string {
  if (!steps.length) return "nothing to write";
  return steps
    .map((st) =>
      st.kind === "comment" ? `comment "${st.body.replaceAll("\n", " ")}"` : `move to '${st.lane}'`,
    )
    .join(", then ");
}

function assigneeLine(a: AssigneeVerdict): string {
  const last =
    a.last_activity_days_ago === null ? "no activity" : `last active ${a.last_activity_days_ago}d ago`;
  // Within the threshold the date settles it; past it, Jev's reading is what decided.
  const byDate = a.last_activity_days_ago !== null && a.last_activity_days_ago <= STALE_DAYS;
  if (a.verdict === "active")
    return `${a.login}: active, ${last}${byDate || a.p_active === null ? "" : ` (P still on it ${f2(a.p_active)})`}`;
  const word = a.verdict === "wait" ? "waiting on a check-in" : "quiet";
  const jev = a.p_active === null ? "" : `, P(still on it) ${f2(a.p_active)}`;
  return `${a.login}: ${word}, ${last}${jev}. ${a.why}`;
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
  if (r.assignees.some((a) => a.verdict !== "active"))
    out.push(["Work by others", `P ${f2(r.p_moving_on)} that it moves or is done through others`]);
  if (!r.sig_node) out.push(["Labels", "no sig/node"]);
  return out;
}

export interface ProgressHoverContent {
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
  const sel = h(
    "select.snba-hc-select",
    { "aria-label": "Action", "data-focus-key": "action" },
    ...progressActions(r).map((a) => {
      const o = h(
        "option",
        { value: a },
        a === suggested ? `${PROGRESS_LABEL[a]} (suggested)` : PROGRESS_LABEL[a],
      ) as HTMLOptionElement;
      o.selected = a === action;
      return o;
    }),
  ) as HTMLSelectElement;
  sel.disabled = locked;
  for (const ev of ["click", "keydown", "mousedown"]) sel.addEventListener(ev, (e) => e.stopPropagation());
  sel.addEventListener("change", () => c.setOverride("action", sel.value));
  const body = h(
    "div.snba-hc-body",
    {},
    h("div.snba-hc-title", {}, h("span.snba-muted", {}, `${r.repo}#${r.number} `), r.title),
    heading(r, action),
    h(
      "dl.snba-hc-scores.snba-hc-facts",
      {},
      ...facts(r).flatMap(([k, v]) => [h("dt", {}, k), h("dd.snba-hc-text", {}, v)]),
      h("dt", {}, "Action"),
      h("dd.snba-hc-text", {}, h("span.snba-hc-prio", {}, sel)),
    ),
  );
  const box = h("div.snba-hc-actions");
  if (c.applied?.state === "done") {
    box.append(h("p.snba-hc-status", {}, "Applied."));
  } else {
    const steps = progressSteps(c.item, r, action);
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
        h("li", {}, h("b", {}, PROGRESS_LABEL[action]), h("span.snba-muted", {}, `: ${describe(steps)}`)),
        h(
          "li",
          {},
          h("b", {}, "Skip"),
          h("span.snba-muted", {}, ": leave it untouched and drop the verdict; Accept passes over it"),
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
    ...facts(r).map(([k, v]) => adapter.row(k, v)),
    h("div.snba-subhead", {}, "What the suggested action does"),
    h("p.snba-muted", {}, describe(progressSteps(item, r, action))),
    h("div.snba-foot", {}, again),
  );
  return root;
}
