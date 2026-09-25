/** The state Jev reads for an 'Issues - To do' card: the thread, the PRs that reference it and the CI run history
 *  of what it tracks, all computed by code. `asOf` lets an offline evaluation see a closed issue as it stood
 *  before it was closed; on the board it is now. */
import { isBot } from "./boards";
import type { JevClient } from "./jev";
import { f2, priority, PRIORITY_CHOICES } from "./policy";
import { todoQuestions } from "./prompts/todo";
import { priorityQuestion } from "./prompts/triage";
import { buildState } from "./state";
import { refsFrom, testsFrom, type JobSignal, type TestGridClient } from "./testgrid";
import type {
  ActionStep,
  BoardItem,
  ItemDetail,
  JevChoice,
  JevNoul,
  JevScore,
  JevUsage,
  LinkedPr,
  Signals,
  TriageAnswers,
} from "./types";

const DAY_MS = 86_400_000;
/** Comments that are only Prow commands carry no evidence; the labels they set are listed separately. */
const PROW_ONLY = /^(\s*\/[a-z-]+( [^\n]*)?\s*)+$/i;
/** Email replies quoting GitHub notifications (`***@***`) are almost always spam on k/k. */
const EMAIL_REPLY = /\*\*\*@\*\*\*/;

export interface TodoState {
  type: "issue";
  repository: string;
  title: string;
  description: string;
  opened_days_ago: number;
  labels: string[];
  human_comments: { author: string; days_ago: number; text: string }[];
  linked_prs: {
    number: number;
    repository: string;
    title: string;
    author: string;
    state: LinkedPr["state"];
    merged_days_ago?: number;
    opened_days_ago?: number;
    description_start: string;
  }[];
  ci_signal: JobSignal[];
}

export async function buildTodoState(
  repo: string,
  d: ItemDetail,
  prs: LinkedPr[],
  tg: TestGridClient,
  asOf = Date.now(),
): Promise<TodoState> {
  const days = (iso: string) => Math.floor((asOf - Date.parse(iso)) / DAY_MS);
  const before = (iso: string) => Date.parse(iso) < asOf;
  const comments = d.comments.filter(
    (c) =>
      before(c.createdAt) &&
      !isBot(c.author.login) &&
      c.body.trim() &&
      !PROW_ONLY.test(c.body) &&
      !EMAIL_REPLY.test(c.body),
  );
  const linked = prs
    .filter((p) => before(p.createdAt))
    .map((p) => {
      const merged = p.mergedAt !== null && before(p.mergedAt);
      return {
        number: p.number,
        repository: p.repository,
        title: p.title,
        author: p.author,
        state: merged ? ("merged" as const) : p.state === "merged" ? ("open" as const) : p.state,
        ...(merged ? { merged_days_ago: days(p.mergedAt!) } : { opened_days_ago: days(p.createdAt) }),
        description_start: p.body
          .replace(/<!--[\s\S]*?-->/g, "")
          .trim()
          .slice(0, 600),
      };
    })
    .slice(-10);
  const merges = prs.filter((p) => p.mergedAt && before(p.mergedAt)).map((p) => Date.parse(p.mergedAt!));
  const ci = await tg.ciSignal(
    d.title,
    d.body,
    comments.map((c) => c.body).join("\n"),
    asOf,
    merges.length ? Math.max(...merges) : undefined,
  );
  return {
    type: "issue",
    repository: repo,
    title: d.title,
    description: d.body.slice(0, 8000),
    opened_days_ago: days(d.createdAt),
    labels: d.labels.map((l) => l.name).filter((l) => /^(kind|priority|triage|lifecycle)\//.test(l)),
    human_comments: comments
      .slice(-10)
      .map((c) => ({ author: c.author.login, days_ago: days(c.createdAt), text: c.body.slice(0, 1000) })),
    linked_prs: linked,
    ci_signal: ci,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Rules the code applies itself, as in the CLI's sweep.

/** Prow's /triage and /priority arguments. A command with any other argument silently did nothing. */
const PROW_OK: Record<string, string[]> = {
  triage: ["accepted", "needs-information", "duplicate", "not-reproducible", "unresolved"],
  priority: PRIORITY_CHOICES,
};
/** A whole line that is a /triage or /priority command, or the label typed as one (`triage/accept`). */
const PROW_RE = /^\s*(?:\/(triage|priority)\s+([\w-]+)|(triage|priority)\/([\w-]+))\s*$/gim;

/** Malformed /triage or /priority commands in human comments (`/triage accept`, `triage/accept`,
 *  `/priority imporant-soon`), with the command they meant. Prow ignores them, so the label never came. */
export function prowTypos(d: ItemDetail): { who: string; wrote: string; fix: string }[] {
  const out: { who: string; wrote: string; fix: string }[] = [];
  for (const c of d.comments) {
    if (isBot(c.author.login)) continue;
    for (const m of c.body.matchAll(PROW_RE)) {
      const cmd = (m[1] ?? m[3]!).toLowerCase();
      const arg = (m[2] ?? m[4]!).toLowerCase();
      const ok = PROW_OK[cmd]!;
      if (m[1] && ok.includes(arg)) continue; // a valid command
      const fix = ok.reduce((best, o) => (distance(o, arg) < distance(best, arg) ? o : best));
      out.push({ who: c.author.login, wrote: m[0].trim(), fix: `/${cmd} ${fix}` });
    }
  }
  return out;
}

function distance(a: string, b: string): number {
  let diff = Math.abs(a.length - b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) diff++;
  return diff;
}

export interface TodoRules {
  assignees: string[];
  sig_node: boolean;
  triage_accepted: boolean;
  priority_label: string | null;
  prow_typos: { who: string; wrote: string; fix: string }[];
}

export function todoRules(item: BoardItem, d: ItemDetail): TodoRules {
  const labels = d.labels.map((l) => l.name);
  return {
    assignees: item.assignees,
    sig_node: labels.includes("sig/node"),
    triage_accepted: labels.includes("triage/accepted"),
    priority_label: labels.find((l) => l.startsWith("priority/"))?.slice("priority/".length) ?? null,
    prow_typos: prowTypos(d),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The fresh-fix guard: Jev may call a problem resolved on the day its fix merged. Closing needs the tracked tests
// (or, when none are found, the job the title names) quiet long enough to mean something.

export const QUIET_DAYS = 3;
export const MIN_CLEAN_RUNS = 10;

/** Why closing as fixed has to wait, or null when the run history does not stand in the way (including when
 *  there is none: then the thread is all there is). */
export function freshFixGuard(ci: JobSignal[]): string | null {
  for (const j of ci) {
    const rows =
      typeof j.tracked_tests !== "string"
        ? j.tracked_tests
        : j.named_in_title && j.whole_job
          ? [j.whole_job]
          : [];
    for (const r of rows) {
      if (r.failures === 0) continue;
      // Clean runs needed: at least MIN_CLEAN_RUNS, and three times the usual gap between failures.
      const need = Math.max(MIN_CLEAN_RUNS, Math.ceil((3 * r.runs) / r.failures));
      const quietDays = r.last_failure_days_ago ?? 0;
      if (quietDays >= QUIET_DAYS && r.runs_since_last_failure >= need) continue;
      const since =
        r.runs_after_fix !== undefined
          ? `, ${r.runs_after_fix - (r.failures_after_fix ?? 0)}/${r.runs_after_fix} clean since the fix`
          : "";
      return `${j.job} failed ${quietDays === 0 ? "today" : `${quietDays}d ago`} and has ${r.runs_since_last_failure} clean runs since${since}; it fails about 1 in ${Math.round(r.runs / r.failures)}, so ${need} clean runs over ${QUIET_DAYS}+ days are needed before closing`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The decision: which action to recommend, and why. Jev's `resolved` is one input; the rules come first.

export const RESOLVED_AT = 0.65;
export const OPEN_AT = 0.35;
export const DUPLICATE_AT = 0.65;

export const TODO_ACTIONS = [
  "keep",
  "in_progress",
  "close_fixed",
  "ask_thread",
  "close_duplicate",
  "archive",
] as const;
export type TodoAction = (typeof TODO_ACTIONS)[number];

export const ACTION_LABEL: Record<TodoAction, string> = {
  keep: "Keep in To do",
  in_progress: "Move to In progress",
  close_fixed: "Close as fixed",
  ask_thread: "Ask the thread",
  close_duplicate: "Close as duplicate",
  archive: "Archive",
};

/** A likely duplicate this card should be closed in favour of. */
export interface DuplicateOf {
  repository: string;
  number: number;
  title: string;
  url: string;
  status: string;
  p: number;
}

export interface TodoResult {
  kind: "todo";
  item_id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  answers: TodoAnswers;
  rules: TodoRules;
  /** Set by the column's duplicate pass, after judging. */
  duplicate: DuplicateOf | null;
  guard: string | null;
  ci: JobSignal[];
  linked_prs: TodoState["linked_prs"];
  /** Jev's priority pick, asked only when the priority label is missing and the card stays. */
  priority: string | null;
  priority_why: string;
  usage: JevUsage;
  state_chars: number;
}

/** Colour family per action, as the Triage tints: green nothing to do, red it leaves the board, yellow a human
 *  should look, blue a move. */
export const ACTION_TINT: Record<TodoAction, "KEEP" | "REMOVE" | "BORDERLINE" | "MOVE"> = {
  keep: "KEEP",
  in_progress: "MOVE",
  close_fixed: "REMOVE",
  ask_thread: "BORDERLINE",
  close_duplicate: "REMOVE",
  archive: "REMOVE",
};

export function decideTodo(r: Pick<TodoResult, "answers" | "rules" | "duplicate" | "guard">): {
  action: TodoAction;
  why: string;
} {
  const p = r.answers.resolved.noul;
  if (!r.rules.sig_node)
    return { action: "archive", why: "No sig/node label (e.g. after /remove-sig node): another SIG's issue" };
  if (r.duplicate)
    return {
      action: "close_duplicate",
      why: `Tracks the same failure as #${r.duplicate.number} (${r.duplicate.status}), P ${f2(r.duplicate.p)}`,
    };
  const assigned = r.rules.assignees.join(", ");
  if (p >= RESOLVED_AT && !r.guard)
    return { action: "close_fixed", why: `Resolved: P ${f2(p)} at or above ${RESOLVED_AT}` };
  const fresh =
    p >= RESOLVED_AT ? `Looks resolved (P ${f2(p)}), but the CI history is too fresh to close it yet` : "";
  // Held open by the guard, it is still someone's work if it is assigned.
  if (assigned)
    return {
      action: "in_progress",
      why: fresh ? `${fresh}; assigned to ${assigned}` : `Assigned to ${assigned}: someone is working on it`,
    };
  if (fresh) return { action: "keep", why: fresh };
  if (p > OPEN_AT) return { action: "ask_thread", why: `May be resolved (P ${f2(p)}): ask what is left` };
  return { action: "keep", why: `Still open: P(resolved) ${f2(p)}` };
}

// ---------------------------------------------------------------------------------------------------------------
// Actions: the steps for each choice, and the comments they post. Every comment matches the worker's allow-list.

/** `#N` for a PR in the issue's own repo, `org/repo#N` for one elsewhere (GitHub links both). */
const link = (pr: TodoState["linked_prs"][number], repo: string) =>
  `${pr.repository === repo ? "" : pr.repository}#${pr.number}`;

/** The evidence for a close, in one clause: the fix PR, and the clean runs since. */
export function fixedEvidence(r: TodoResult): string {
  const merged = r.linked_prs
    .filter((p) => p.state === "merged")
    .sort((a, b) => a.merged_days_ago! - b.merged_days_ago!);
  const bits: string[] = [];
  const how = r.answers.resolution.choice;
  if (merged[0] && how !== "went_green")
    bits.push(`${link(merged[0], r.repo)} merged ${ago(merged[0].merged_days_ago!)}`);
  for (const j of r.ci) {
    const rows =
      typeof j.tracked_tests !== "string"
        ? j.tracked_tests
        : j.named_in_title && j.whole_job
          ? [j.whole_job]
          : [];
    const r0 = rows[0];
    if (r0) bits.push(`${j.job} has passed its last ${r0.runs_since_last_failure} runs`);
  }
  return bits.join(", and ");
}

const ago = (d: number) => (d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`);

export const COMMENT_PREFIX = {
  fixed: "This looks resolved",
  duplicate: "Closing as a duplicate of ",
  ask: "Checking in from the SIG Node CI board",
} as const;

export function closeFixedBody(r: TodoResult): string {
  // Jev writes no text: with no linked fix and no run history, the reason is whatever the thread says.
  const ev = fixedEvidence(r) || "going by the discussion above";
  const how =
    r.answers.resolution.choice === "obsolete" ? " (the test or job it tracks was removed or replaced)" : "";
  return `${COMMENT_PREFIX.fixed}${how}: ${ev}. Closing; please reopen if it comes back.\n/close`;
}

export function duplicateBody(d: DuplicateOf, repo: string): string {
  const ref = d.repository === repo ? `#${d.number}` : `${d.repository}#${d.number}`;
  return `${COMMENT_PREFIX.duplicate}${ref}, which tracks the same failure. Tracking continues there.\n/close`;
}

export function askThreadBody(r: TodoResult): string {
  const ev = fixedEvidence(r);
  return `${COMMENT_PREFIX.ask}${ev ? `: ${ev}` : ""}. Is anything left here? If not, we will close this issue; if so, what is the next step and who is driving it?`;
}

/** Prow commands that give a card in To do the labels Accept on Triage would have: /triage accepted and a priority. */
export function labelFix(r: TodoResult, priority: string | null): string | null {
  const lines = [];
  if (!r.rules.triage_accepted) lines.push("/triage accepted");
  if (!r.rules.priority_label && priority) lines.push(`/priority ${priority}`);
  return lines.length ? lines.join("\n") : null;
}

export function todoSteps(
  item: BoardItem,
  r: TodoResult,
  action: TodoAction,
  priority: string | null = r.priority,
): ActionStep[] {
  const { repository: repo, number } = item;
  const comment = (body: string): ActionStep => ({ kind: "comment", repo, number, body });
  const move = (lane: string): ActionStep => ({ kind: "move", itemId: item.id, restId: item.restId, lane });
  const fix = labelFix(r, priority);
  const withFix = fix ? [comment(fix)] : [];
  switch (action) {
    case "keep":
      return withFix;
    case "in_progress":
      return [...withFix, move("Issues - In progress")];
    case "ask_thread":
      return [...withFix, comment(askThreadBody(r))];
    case "close_fixed":
      return [comment(closeFixedBody(r)), move("Done")];
    case "close_duplicate":
      return r.duplicate ? [comment(duplicateBody(r.duplicate, repo)), move("Archive-it")] : [];
    case "archive":
      return [move("Archive-it")];
  }
}

/** Actions a reviewer can pick for this card: close as duplicate only when the pass found one. */
export function availableActions(r: TodoResult): TodoAction[] {
  return TODO_ACTIONS.filter((a) => a !== "close_duplicate" || r.duplicate);
}

// ---------------------------------------------------------------------------------------------------------------
// Judging one card, in the worker.

export interface TodoAnswers {
  resolved: JevNoul;
  resolution: JevChoice;
  priority?: JevScore;
}

export async function judgeTodo(
  item: BoardItem,
  d: ItemDetail,
  prs: LinkedPr[],
  tg: TestGridClient,
  jev: JevClient,
  refresh = false,
): Promise<TodoResult> {
  const st = await buildTodoState(item.repository, d, prs, tg);
  const r = await jev.askCached<TodoAnswers>(st, todoQuestions(), 4, refresh);
  const answers: TodoAnswers = { ...r.answers };
  const usage = { ...r.usage };
  const rules = todoRules(item, d);
  let prio: { priority: string | null; why: string } = { priority: null, why: "" };
  if (!rules.priority_label) {
    // Same question and policy as Triage's Accept; the triage state is what it was tuned on.
    const p = await jev.askCached<Pick<TriageAnswers, "priority">>(
      buildState(item, d, "Issue"),
      priorityQuestion("Issue"),
      4,
      refresh,
    );
    answers.priority = p.answers.priority;
    usage.input_tokens += p.usage.input_tokens;
    usage.cost += p.usage.cost;
    usage.cached = usage.cached && p.usage.cached;
    prio = priority(
      { priority: p.answers.priority } as TriageAnswers,
      { priority_label_already: null } as Signals,
    );
  }
  return {
    kind: "todo",
    item_id: item.id,
    repo: item.repository,
    number: item.number,
    title: d.title,
    url: item.url,
    answers,
    rules,
    duplicate: null,
    guard: freshFixGuard(st.ci_signal),
    ci: st.ci_signal,
    linked_prs: st.linked_prs,
    priority: prio.priority,
    priority_why: prio.why,
    usage,
    state_chars: JSON.stringify(st).length,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Duplicates: pairwise, as the CLI's sweep. Validated on 2,145 pairs of kubernetes/151 issues: the four pairs
// humans closed as duplicates scored 0.69 to 0.90; one other pair scored above 0.65 (a follow-up split out of a
// closed issue, which the board never pairs since closed issues leave To do).

export interface DupFacets {
  number: number;
  repository: string;
  created: string;
  title: string;
  author: string;
  assignees: string[];
  tests: string[];
  jobs: string[];
  body: string;
}

export function dupFacets(item: BoardItem, d: ItemDetail): DupFacets {
  const r = refsFrom(d.body);
  return {
    number: item.number,
    repository: item.repository,
    created: d.createdAt.slice(0, 10),
    title: d.title,
    author: d.author.login,
    assignees: item.assignees,
    tests: testsFrom(d.title, d.body),
    jobs: [...r.jobs, ...r.tabs.map((t) => t.tab)].slice(0, 8),
    body: d.body.slice(0, 5000),
  };
}

export function dupState(a: DupFacets, b: DupFacets) {
  return {
    issue_A: a,
    issue_B: b,
    "precomputed (use as given)": {
      same_author: a.author === b.author,
      shared_assignee: a.assignees.some((x) => b.assignees.includes(x)),
      shared_job: a.jobs.some((j) => b.jobs.includes(j)),
    },
  };
}

export interface DupPair {
  a: BoardItem;
  b: BoardItem;
  p: number;
  /** Jev's pick of the issue that should stay open. */
  survivor: "A" | "B";
}

/** Which To-do cards to close as duplicates, and of what. Pairs at or above DUPLICATE_AT are grouped (A~B and
 *  B~C put all three together), and each group keeps exactly one issue, so pairwise picks that go round in a
 *  circle (B over A, C over B, A over C) or chain (A into B, B into C) can never close them all:
 *  - an In-progress card, else an assigned one (someone is on it), else the one Jev picked to survive most
 *    strongly (sum of P over the pairs it won; ties go to the newer issue);
 *  - every other member that is an unassigned To-do card among `targets` closes in favour of it. In-progress and
 *    assigned members are never closed: two held duplicates are a human's call. */
export function closeDuplicates(pairs: DupPair[], targets: Set<number>): Map<number, DuplicateOf> {
  const edges = pairs.filter((x) => x.p >= DUPLICATE_AT);
  const parent = new Map<number, number>();
  const find = (id: number): number => {
    const p = parent.get(id) ?? id;
    if (p === id) return id;
    const root = find(p);
    parent.set(id, root);
    return root;
  };
  const items = new Map<number, BoardItem>();
  for (const e of edges) {
    items.set(e.a.restId, e.a);
    items.set(e.b.restId, e.b);
    parent.set(find(e.a.restId), find(e.b.restId));
  }
  const groups = new Map<number, BoardItem[]>();
  for (const i of items.values()) groups.set(find(i.restId), [...(groups.get(find(i.restId)) ?? []), i]);
  const held = (i: BoardItem) => i.status === "Issues - In progress" || i.assignees.length > 0;
  const out = new Map<number, DuplicateOf>();
  for (const members of groups.values()) {
    const score = (i: BoardItem) =>
      edges.filter((e) => (e.survivor === "A" ? e.a : e.b).restId === i.restId).reduce((s, e) => s + e.p, 0);
    const rank = (i: BoardItem) => [
      i.status === "Issues - In progress" ? 1 : 0,
      held(i) ? 1 : 0,
      score(i),
      i.number,
    ];
    const keeper = members.reduce((best, i) => {
      const [x, y] = [rank(i), rank(best)];
      for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return x[k]! > y[k]! ? i : best;
      return best;
    });
    for (const m of members) {
      if (m === keeper || held(m) || m.status !== "Issues - To do" || !targets.has(m.restId)) continue;
      const p = Math.max(
        ...edges.filter((e) => e.a.restId === m.restId || e.b.restId === m.restId).map((e) => e.p),
      );
      out.set(m.restId, {
        repository: keeper.repository,
        number: keeper.number,
        title: keeper.title,
        url: keeper.url,
        status: keeper.status,
        p,
      });
    }
  }
  return out;
}
