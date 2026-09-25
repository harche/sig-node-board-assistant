/** What a reviewer sees for a 'PRs - Needs Reviewer' or 'PRs - Needs Approver' card: whose move it is, who is
 *  reviewing or was asked, the people to /cc with their reasons, and one action, the suggested one preselected,
 *  that can be changed. The two columns share facts and layout; a PrSpec gives each its rules and actions. */
import {
  APPROVE_LABEL,
  APPROVE_TINT,
  approveActions,
  approveSteps,
  decideApprove,
  type ApproveResult,
} from "../core/approver";
import {
  AUTHOR_LABEL,
  AUTHOR_TINT,
  authorActions,
  authorSteps,
  decideAuthor,
  type AuthorAction,
  type AuthorResult,
} from "../core/author";
import { f2 } from "../core/policy";
import {
  decideReview,
  REVIEW_LABEL,
  REVIEW_TINT,
  reviewActions,
  reviewSteps,
  type ReviewAction,
  type ReviewResult,
} from "../core/reviewer";
import type { ActionStep, BoardItem } from "../core/types";
import { nativeButton } from "./adapters";
import type { SidebarAdapter } from "./evidence";
import type { Applied } from "./hovercard";
import { h } from "./ui";

type PrResult = ReviewResult | ApproveResult | AuthorResult;

/** One PR column's rules and actions. */
export interface PrSpec {
  decide(r: PrResult): { action: string; why: string };
  actions(r: PrResult): string[];
  steps(item: BoardItem, r: PrResult, action: string): ActionStep[];
  label: Record<string, string>;
  tint: Record<string, string>;
  /** Who the candidates are, for the facts row. */
  asks: string;
  /** Candidates carry Jev's probability (reviewers) or a ranking score (approvers). */
  showP: boolean;
  /** Column-specific rows, shown before the rest. */
  extra?(r: PrResult): [string, string][];
}

export const REVIEW_SPEC: PrSpec = {
  decide: (r) => decideReview(r as ReviewResult),
  actions: (r) => reviewActions(r as ReviewResult),
  steps: (item, r, a) => reviewSteps(item, r as ReviewResult, a as ReviewAction),
  label: REVIEW_LABEL,
  tint: REVIEW_TINT,
  asks: "Would /cc",
  showP: true,
};

export const APPROVE_SPEC: PrSpec = {
  decide: (r) => decideApprove(r as ApproveResult),
  actions: (r) => approveActions(r as ApproveResult),
  steps: (item, r, a) => approveSteps(item, r as ApproveResult, a as never),
  label: APPROVE_LABEL,
  tint: APPROVE_TINT,
  asks: "Would /cc (approvers)",
  showP: false,
};

export const AUTHOR_SPEC: PrSpec = {
  decide: (r) => decideAuthor(r as AuthorResult),
  actions: () => authorActions(),
  steps: (item, r, a) => authorSteps(item, r as AuthorResult, a as AuthorAction),
  label: AUTHOR_LABEL,
  tint: AUTHOR_TINT,
  asks: "Would /cc",
  showP: false,
  extra: (r) => {
    const a = r as AuthorResult;
    const rows: [string, string][] = [["On the board", `${a.scope.verdict.toLowerCase()}: ${a.scope.why}`]];
    if (a.author_checkin_days_ago != null)
      rows.push(["Checked in", `${a.author_checkin_days_ago}d ago, unanswered`]);
    return rows;
  },
};

export function chosenPr(spec: PrSpec, r: PrResult, o: { action?: string }): string {
  return o.action && spec.actions(r).includes(o.action) ? o.action : spec.decide(r).action;
}

function describe(steps: ActionStep[]): string {
  if (!steps.length) return "nothing to write";
  return steps
    .map((st) =>
      st.kind === "comment" ? `comment "${st.body.replaceAll("\n", " / ")}"` : `move to '${st.lane}'`,
    )
    .join(", then ");
}

const lines = (xs: string[]) => h("span.snba-lines", {}, ...xs.map((x) => h("span", {}, x)));

function facts(spec: PrSpec, r: PrResult): [string, Node | string][] {
  const out: [string, Node | string][] = [...(spec.extra?.(r) ?? [])];
  const m = r.whose_move;
  out.push([
    "Whose move",
    `${m.choice} ${f2(m.probabilities[m.choice] ?? m.confidence)} (${Object.entries(m.probabilities)
      .filter(([k]) => k !== m.choice)
      .map(([k, p]) => `${k} ${f2(p)}`)
      .join(", ")})`,
  ]);
  const prow = [
    ...r.pr.labels.filter((l) => /^(lgtm|approved|do-not-merge\/|needs-rebase|lifecycle\/)/.test(l)),
    r.pr.draft ? "draft" : "",
  ].filter(Boolean);
  if (prow.length) out.push(["Labels", prow.join(", ")]);
  if (r.pr.tide?.description) out.push(["Tide", r.pr.tide.description]);
  if (r.pr.failing.length) out.push(["Failing", r.pr.failing.slice(0, 4).join(", ")]);
  if (r.holder)
    out.push(["Hold", `by ${r.holder}${r.hold_met !== null ? `, condition met P ${f2(r.hold_met)}` : ""}`]);
  if (r.engaged.length)
    out.push([
      "Reviewing",
      lines(
        r.engaged.map(
          (e) =>
            `${e.login}: last ${e.last_days_ago}d ago${r.pinged[e.login] != null ? `, pinged ${r.pinged[e.login]}d ago` : ""}`,
        ),
      ),
    ]);
  if (r.asked.length)
    out.push([
      "Asked",
      lines(
        r.asked.map(
          (a) =>
            `${a.login}, by ${a.by} ${a.days_ago}d ago${a.pinged_days_ago !== null && a.pinged_days_ago < a.days_ago ? `, pinged ${a.pinged_days_ago}d ago` : ""}`,
        ),
      ),
    ]);
  if (r.declined.length) out.push(["Declined or handed off", r.declined.join(", ")]);
  if (r.author_last_days_ago !== null)
    out.push(["Author", `${r.pr.author}, last moved ${r.author_last_days_ago}d ago`]);
  if (r.candidates.length)
    out.push([
      spec.asks,
      lines(r.candidates.map((c) => `${c.login}${spec.showP ? ` (P ${f2(c.p)})` : ""}: ${c.reason}`)),
    ]);
  else if (r.candidates_note) out.push(["Candidates", r.candidates_note]);
  return out;
}

function heading(spec: PrSpec, r: PrResult, action: string): HTMLElement {
  const d = spec.decide(r);
  return h(
    "div.snba-decision",
    {},
    h(
      "div",
      {},
      h(`span.snba-verdict.snba-${spec.tint[action]!.toLowerCase()}`, {}, spec.label[action]),
      action !== d.action
        ? h("span.snba-muted", {}, ` (suggested: ${spec.label[d.action]!.toLowerCase()})`)
        : null,
    ),
    h("p.snba-why", {}, d.why),
  );
}

export interface ReviewHoverContent {
  spec: PrSpec;
  /** The action\'s steps with the Prow fixes added. */
  fix(steps: ActionStep[]): ActionStep[];
  item: BoardItem;
  result: PrResult;
  overrides: { action?: string };
  setOverride(key: string, value: string): void;
  applied: Applied | undefined;
  canApply: boolean;
  scope: ParentNode;
  apply(): void;
  skip(): void;
}

export function renderReviewHoverCard(c: ReviewHoverContent): HTMLElement {
  const { spec, result: r } = c;
  const locked = c.applied?.state === "pending" || c.applied?.state === "done" || !c.canApply;
  const action = chosenPr(spec, r, c.overrides);
  const suggested = spec.decide(r).action;
  const sel = h(
    "select.snba-hc-select",
    { "aria-label": "Action", "data-focus-key": "action" },
    ...spec.actions(r).map((a) => {
      const o = h(
        "option",
        { value: a },
        a === suggested ? `${spec.label[a]} (suggested)` : spec.label[a],
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
    heading(spec, r, action),
    h(
      "dl.snba-hc-scores.snba-hc-facts",
      {},
      ...facts(spec, r).flatMap(([k, v]) => [h("dt", {}, k), h("dd.snba-hc-text", {}, v)]),
      h("dt", {}, "Action"),
      h("dd.snba-hc-text", {}, h("span.snba-hc-prio", {}, sel)),
    ),
  );
  const box = h("div.snba-hc-actions");
  if (c.applied?.state === "done") {
    box.append(h("p.snba-hc-status", {}, "Applied."));
  } else {
    const steps = c.fix(spec.steps(c.item, r, action));
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
        h("li", {}, h("b", {}, spec.label[action]), h("span.snba-muted", {}, `: ${describe(steps)}`)),
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

export type ReviewPaneState =
  { state: "pending" } | { state: "error"; message: string } | { state: "done"; result: PrResult };

export function renderReviewEvidence(
  spec: PrSpec,
  adapter: SidebarAdapter,
  item: BoardItem,
  st: ReviewPaneState,
  rejudge: (i: BoardItem) => Promise<void>,
  title: string,
): HTMLElement {
  const { root, body } = adapter.section(title);
  root.classList.add("snba-evidence");
  root.dataset.snbaItem = String(item.restId);
  const again = h("button.snba-link", { type: "button" }, "Judge again") as HTMLButtonElement;
  again.title = "Re-read the PR, its reviews and history, and ask Jev again";
  again.addEventListener("click", async () => {
    again.disabled = true;
    try {
      await rejudge(item);
    } finally {
      again.disabled = false;
    }
  });
  if (st.state === "pending") {
    body.append(h("p.snba-muted", {}, "Reading the PR, its reviews and review history, and asking Jev…"));
    return root;
  }
  if (st.state === "error") {
    body.append(h("p.snba-error", {}, st.message), again);
    return root;
  }
  const r = st.result;
  const action = spec.decide(r).action;
  body.append(
    heading(spec, r, action),
    ...facts(spec, r).map(([k, v]) => adapter.row(k, v)),
    h("div.snba-subhead", {}, "What the suggested action does"),
    h("p.snba-muted", {}, describe(spec.steps(item, r, action))),
    h("div.snba-foot", {}, again),
  );
  return root;
}
