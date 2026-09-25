/** What differs between the columns the board assistant works on. The assistant (index.ts) owns the column button,
 *  badges, tints, the header's Accept and Cancel, Skip and the writes; a workflow says how an item is judged, what
 *  its badge reads, what Accept would do to it and how its hover card and pane section look. */
import {
  decideProgressCard,
  PROGRESS_TINT,
  progressSteps,
  type ProgressAction,
  type ProgressResult,
} from "../core/inprogress";
import type { ApproveResult } from "../core/approver";
import type { AuthorResult } from "../core/author";
import type { ReviewResult } from "../core/reviewer";
import { decideTodo, type TodoResult } from "../core/todo";
import {
  APPROVE_SPEC,
  AUTHOR_SPEC,
  chosenPr,
  renderReviewEvidence,
  renderReviewHoverCard,
  REVIEW_SPEC,
  type PrSpec,
} from "./reviewercard";
import { chosenProgress, renderProgressEvidence, renderProgressHoverCard } from "./progresscard";
import { proposedActions } from "../core/triage";
import type { ActionStep, BoardFields, BoardItem, BoardRef, TriageResult } from "../core/types";
import { send } from "../shared/messages";
import type { SidebarAdapter } from "./evidence";
import { renderEvidence, SECTION_TITLE } from "./evidence";
import { renderHoverCard, type Applied } from "./hovercard";
import { judgeTriage, type JudgeFn } from "./judged";
import { ACTION_TINT } from "../core/todo";
import {
  chosenAction,
  chosenSteps,
  renderTodoEvidence,
  renderTodoHoverCard,
  type TodoOverrides,
} from "./todocard";

export type Overrides = Record<string, string>;

const omit = (o: Overrides, key: string): Overrides =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

/** Posts the fixes for mistyped Prow commands ahead of an action's own steps, unless the action closes the item or
 *  takes it off the board (then the fix no longer matters), and without repeating a line the steps already post. */
export function withFixes(
  item: BoardItem,
  r: { prow_fixes?: { fix: string }[] },
  steps: ActionStep[],
): ActionStep[] {
  const fixes = r.prow_fixes ?? [];
  if (!fixes.length) return steps;
  const leaving = steps.some(
    (s) =>
      (s.kind === "move" && (s.lane === "Done" || s.lane === "Archive-it")) ||
      (s.kind === "comment" && /^\/close$/m.test(s.body)),
  );
  if (leaving) return steps;
  const posted = steps.flatMap((s) => (s.kind === "comment" ? s.body.split("\n") : []));
  // A label the action itself sets (Triage's /priority, To do's missing labels) wins over a fix for the same kind of
  // label: Prow adds a priority rather than replacing it, so posting both would leave two.
  const cmdOf = (l: string) => l.split(/\s+/)[0]!.replace(/^\/remove-/, "/");
  const labelCmds = new Set(["/triage", "/priority", "/kind"]);
  const setByAction = new Set(posted.map(cmdOf).filter((c) => labelCmds.has(c)));
  const lines = [...new Set(fixes.map((f) => f.fix))].filter(
    (l) => !posted.includes(l) && !setByAction.has(cmdOf(l)),
  );
  if (!lines.length) return steps;
  return [{ kind: "comment", repo: item.repository, number: item.number, body: lines.join("\n") }, ...steps];
}

export interface HoverCtx<R> {
  /** An action's steps with the Prow fixes added (withFixes). */
  fix(steps: ActionStep[]): ActionStep[];
  item: BoardItem;
  result: R;
  overrides: Overrides;
  setOverride(key: string, value: string): void;
  fields: BoardFields | null;
  applied: Applied | undefined;
  canApply: boolean;
  scope: ParentNode;
  /** Triage passes "accept" or "reject"; To do has one Apply for the chosen action. */
  apply(choice: string): void;
  skip(): void;
}

export type PaneState<R> =
  | { state: "pending" }
  | { state: "error"; message: string }
  | { state: "done"; result: R; fields: BoardFields | null };

export interface ColumnWorkflow<R> {
  judge: JudgeFn<R>;
  /** After a judging pass over `items`, results to replace (To do: the duplicate pass). */
  afterJudge?(board: BoardRef, items: BoardItem[], results: Map<number, R>): Promise<Map<number, R>>;
  /** Tint family (KEEP / REMOVE / BORDERLINE / MOVE) and the badge's word. */
  badge(r: R, o: Overrides): { tint: string; text: string };
  /** What the header's Accept applies to this item, or null when it needs the reviewer (borderline, ask). `kind` is
   *  what acceptTip counts by (the action), when the tint alone would lump different actions together. */
  recommended(
    item: BoardItem,
    r: R,
    fields: BoardFields,
    o: Overrides,
  ): { tint: string; steps: ActionStep[]; kind?: string } | null;
  /** The steps of one hover-card button. */
  steps(item: BoardItem, r: R, fields: BoardFields, o: Overrides, choice: string): ActionStep[] | null;
  /** The overrides after the reviewer picks `value` for `key`; a pick equal to the suggestion drops the key. */
  override(r: R, o: Overrides, key: string, value: string): Overrides;
  needsHuman(r: R, o: Overrides): boolean;
  hover(c: HoverCtx<R>): HTMLElement;
  hoverKey(r: R): string;
  pane(
    adapter: SidebarAdapter,
    item: BoardItem,
    st: PaneState<R>,
    rejudge: (i: BoardItem) => Promise<void>,
  ): HTMLElement;
  runTip(column: string): string;
  acceptTip(counts: Record<string, number>): string;
}

// ---------------------------------------------------------------------------------------------------- Triage

const withPriority = (r: TriageResult, o: Overrides): TriageResult =>
  o.priority && r.priority !== null ? { ...r, priority: o.priority, priority_why: "picked by you" } : r;

export const triageWorkflow: ColumnWorkflow<TriageResult> = {
  judge: judgeTriage,
  badge: (r) => ({
    tint: r.verdict,
    text: r.verdict === "BORDERLINE" ? "borderline" : r.verdict.toLowerCase(),
  }),
  recommended(item, r, fields, o) {
    const p = proposedActions(item, withPriority(r, o), fields);
    const action = p.recommended && p[p.recommended];
    return p.recommended && action
      ? { tint: p.recommended === "accept" ? "KEEP" : "REMOVE", steps: action.steps }
      : null;
  },
  steps(item, r, fields, o, choice) {
    const p = proposedActions(item, withPriority(r, o), fields);
    return (choice === "accept" ? p.accept : p.reject)?.steps ?? null;
  },
  override(r, o, key, value) {
    if (key !== "priority" || r.priority === null) return o;
    const rest = omit(o, "priority");
    return value === r.priority ? rest : { ...rest, priority: value };
  },
  needsHuman: (r) => r.verdict === "BORDERLINE",
  hover: (c) =>
    renderHoverCard({
      fix: c.fix,
      item: c.item,
      result: withPriority(c.result, c.overrides),
      suggested:
        c.result.priority === null ? null : { priority: c.result.priority, why: c.result.priority_why },
      setPriority: (p) => c.setOverride("priority", p),
      fields: c.fields,
      applied: c.applied,
      canApply: c.canApply,
      skip: c.skip,
      scope: c.scope,
      apply: c.apply,
    }),
  hoverKey: (r) => r.verdict + r.why,
  pane: (adapter, item, st, rejudge) => renderEvidence(adapter, item, st, { rejudge }),
  runTip: (column) => `Ask Jev for a keep / remove verdict on every item in ${column}`,
  acceptTip: (n) =>
    `${n.KEEP ?? 0} keep (/triage accepted + /priority, move to its lane), ${n.REMOVE ?? 0} remove (move to Archive-it)`,
};

// ---------------------------------------------------------------------------------------------------- To do

const BADGE_TEXT = {
  keep: "keep",
  in_progress: "in progress",
  close_fixed: "fixed",
  ask_thread: "ask",
  close_duplicate: "duplicate",
  archive: "archive",
} as const;

export const todoWorkflow: ColumnWorkflow<TodoResult> = {
  judge: (item, refresh) => send({ type: "todo.judge", item, refresh }),
  async afterJudge(board, items, results) {
    const dups = await send({ type: "todo.duplicates", board, targets: items });
    const out = new Map<number, TodoResult>();
    for (const [restId, r] of results) {
      const d = dups[restId] ?? null;
      if ((d?.number ?? null) !== (r.duplicate?.number ?? null)) out.set(restId, { ...r, duplicate: d });
    }
    return out;
  },
  badge(r, o) {
    const a = chosenAction(r, o as TodoOverrides);
    return { tint: ACTION_TINT[a], text: BADGE_TEXT[a] };
  },
  recommended(item, r, _fields, o) {
    const steps = chosenSteps(item, r, o as TodoOverrides);
    return steps.length ? { tint: ACTION_TINT[chosenAction(r, o as TodoOverrides)], steps } : null;
  },
  steps: (item, r, _fields, o) => chosenSteps(item, r, o as TodoOverrides),
  override(r, o, key, value) {
    const rest = omit(o, key);
    const suggested = key === "action" ? decideTodo(r).action : key === "priority" ? r.priority : null;
    return value === suggested ? rest : { ...rest, [key]: value };
  },
  needsHuman: () => false,
  hover: (c) =>
    renderTodoHoverCard({
      fix: c.fix,
      item: c.item,
      result: c.result,
      overrides: c.overrides as TodoOverrides,
      setOverride: (k, v) => c.setOverride(k, v),
      applied: c.applied,
      canApply: c.canApply,
      scope: c.scope,
      apply: () => c.apply("chosen"),
      skip: c.skip,
    }),
  hoverKey: (r) => `${r.answers.resolved.noul}|${r.duplicate?.number ?? ""}|${r.guard ?? ""}`,
  pane: (adapter, item, st, rejudge) =>
    renderTodoEvidence(
      adapter,
      item,
      st.state === "done" ? { state: "done", result: st.result } : st,
      { rejudge },
      SECTION_TITLE,
    ),
  runTip: (column) =>
    `Ask Jev whether each issue in ${column} is already resolved, check TestGrid and look for duplicates`,
  acceptTip: (n) =>
    [
      n.MOVE && `${n.MOVE} to In progress`,
      n.REMOVE && `${n.REMOVE} closed or archived (with a comment saying why)`,
      n.KEEP && `${n.KEEP} kept with their missing labels fixed`,
      n.BORDERLINE && `${n.BORDERLINE} asked what is left`,
    ]
      .filter(Boolean)
      .join(", "),
};

// ---------------------------------------------------------------------------------------------------- In progress

const PROGRESS_BADGE: Record<ProgressAction, string> = {
  keep: "active",
  nudge: "nudge",
  unassign: "unassign",
  ask_thread: "ask",
  back_to_todo: "to do",
  archive: "archive",
};

export const progressWorkflow: ColumnWorkflow<ProgressResult> = {
  judge: (item, refresh) => send({ type: "progress.judge", item, refresh }),
  badge(r, o) {
    const a = chosenProgress(r, o);
    const waiting = a === "keep" && r.assignees.some((x) => x.verdict === "wait");
    return { tint: PROGRESS_TINT[a], text: waiting ? "wait" : PROGRESS_BADGE[a] };
  },
  recommended(item, r, _fields, o) {
    const a = chosenProgress(r, o);
    const steps = progressSteps(item, r, a);
    return steps.length ? { tint: PROGRESS_TINT[a], steps } : null;
  },
  steps: (item, r, _fields, o) => progressSteps(item, r, chosenProgress(r, o)),
  override(r, o, key, value) {
    const rest = omit(o, key);
    return key === "action" && value === decideProgressCard(r).action ? rest : { ...rest, [key]: value };
  },
  needsHuman: () => false,
  hover: (c) =>
    renderProgressHoverCard({
      fix: c.fix,
      item: c.item,
      result: c.result,
      overrides: c.overrides,
      setOverride: c.setOverride,
      applied: c.applied,
      canApply: c.canApply,
      scope: c.scope,
      apply: () => c.apply("chosen"),
      skip: c.skip,
    }),
  hoverKey: (r) => r.assignees.map((a) => `${a.login}:${a.verdict}`).join(",") + `|${r.sig_node}`,
  pane: (adapter, item, st, rejudge) =>
    renderProgressEvidence(
      adapter,
      item,
      st.state === "done" ? { state: "done", result: st.result } : st,
      rejudge,
      SECTION_TITLE,
    ),
  runTip: (column) =>
    `Ask Jev whether each assignee in ${column} is still on it, and what to do about the quiet ones`,
  acceptTip: (n) =>
    [
      n.MOVE && `${n.MOVE} back to To do`,
      n.REMOVE && `${n.REMOVE} unassigned or archived`,
      n.BORDERLINE && `${n.BORDERLINE} nudged or asked what is left`,
    ]
      .filter(Boolean)
      .join(", "),
};

// ---------------------------------------------------------------------------------------------------- Needs Reviewer

const PR_BADGE: Record<string, string> = {
  new_ask: "ask",
  reping: "re-ping",
  to_author: "author",
  to_approver: "approver",
  to_reviewer: "reviewer",
  nudge: "nudge",
  archive: "archive",
  to_done: "done",
};

/** Needs Reviewer and Needs Approver: same facts and hover card, each with its own rules and actions. */
function prWorkflow<R extends ReviewResult | ApproveResult | AuthorResult>(
  spec: PrSpec,
  type: "review.judge" | "approve.judge" | "author.judge",
  tips: { run: (column: string) => string; asked: string },
): ColumnWorkflow<R> {
  return {
    judge: (item, refresh) => send({ type, item, refresh }) as Promise<R>,
    badge(r, o) {
      const a = chosenPr(spec, r, o);
      // A kept card says what it waits on.
      const keep = r.holder
        ? "held"
        : type === "author.judge"
          ? r.whose_move.choice === "blocked"
            ? "blocked"
            : r.author_checkin_days_ago != null
              ? "checked in"
              : "author"
          : r.pr.labels.includes("approved")
            ? "approved"
            : r.engaged.length && type === "review.judge"
              ? "reviewing"
              : r.asked.length
                ? "asked"
                : r.whose_move.choice === "blocked"
                  ? "blocked"
                  : "nobody";
      return { tint: spec.tint[a]!, text: a === "keep" ? keep : (PR_BADGE[a] ?? a) };
    },
    recommended(item, r, _fields, o) {
      const a = chosenPr(spec, r, o);
      const steps = spec.steps(item, r, a);
      return steps.length ? { tint: spec.tint[a]!, steps, kind: a } : null;
    },
    steps: (item, r, _fields, o) => spec.steps(item, r, chosenPr(spec, r, o)),
    override(r, o, key, value) {
      const rest = omit(o, key);
      return key === "action" && value === spec.decide(r).action ? rest : { ...rest, [key]: value };
    },
    needsHuman: () => false,
    hover: (c) =>
      renderReviewHoverCard({
        spec,
        fix: c.fix,
        item: c.item,
        result: c.result,
        overrides: c.overrides,
        setOverride: c.setOverride,
        applied: c.applied,
        canApply: c.canApply,
        scope: c.scope,
        apply: () => c.apply("chosen"),
        skip: c.skip,
      }),
    hoverKey: (r) => `${spec.decide(r).action}|${r.candidates.map((c) => c.login).join(",")}`,
    pane: (adapter, item, st, rejudge) =>
      renderReviewEvidence(
        spec,
        adapter,
        item,
        st.state === "done" ? { state: "done", result: st.result } : st,
        rejudge,
        SECTION_TITLE,
      ),
    runTip: tips.run,
    acceptTip: (n) => {
      const c = (...ks: string[]) => ks.reduce((sum, k) => sum + (n[k] ?? 0), 0);
      const lanes = c("to_reviewer", "to_approver", "to_author");
      return [
        lanes && `${lanes} moved to another PR lane`,
        c("to_done") && `${c("to_done")} moved to Done`,
        c("archive") && `${c("archive")} archived (not SIG Node CI work)`,
        c("new_ask") && `${c("new_ask")} with ${tips.asked} asked`,
        c("reping") && `${c("reping")} re-pinged`,
        c("nudge") && `${c("nudge")} authors nudged`,
        // Kept cards reach Accept only for their Prow fixes, counted by tint (the page adds them without an action).
        c("keep", "KEEP") && `${c("keep", "KEEP")} with Prow fixes only`,
      ]
        .filter(Boolean)
        .join(", ");
    },
  };
}

export const reviewWorkflow = prWorkflow<ReviewResult>(REVIEW_SPEC, "review.judge", {
  run: (column) =>
    `Ask Jev whose move each PR in ${column} is, and find reviewers for the ones nobody is reviewing`,
  asked: "reviewers",
});
export const approveWorkflow = prWorkflow<ApproveResult>(APPROVE_SPEC, "approve.judge", {
  run: (column) =>
    `Ask Jev whose move each PR in ${column} is, and find approvers for the ones nobody was asked about`,
  asked: "approvers",
});
export const authorWorkflow = prWorkflow<AuthorResult>(AUTHOR_SPEC, "author.judge", {
  run: (column) =>
    `Ask Jev whether each PR in ${column} still waits on its author, belongs on the board, or has an author gone quiet`,
  asked: "authors",
});

export const WORKFLOWS: Record<string, ColumnWorkflow<unknown>> = {
  triage: triageWorkflow as ColumnWorkflow<unknown>,
  todo: todoWorkflow as ColumnWorkflow<unknown>,
  progress: progressWorkflow as ColumnWorkflow<unknown>,
  review: reviewWorkflow as ColumnWorkflow<unknown>,
  approve: approveWorkflow as ColumnWorkflow<unknown>,
  author: authorWorkflow as ColumnWorkflow<unknown>,
};
