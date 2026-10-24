/** What a reviewer sees for a FAILING or FLAKY tab on a TestGrid dashboard: the action and why, Jev's readings as
 *  bars, the facts code computed (runs, failing tests, the newest failed runs' signal lines, candidate issues), and
 *  one action, the suggested one preselected unless it is the reviewer's call. */
import type { Applied } from "../content/hovercard";
import { actionBox, allReadings, fact, readingsBlock, select } from "../content/hcparts";
import { h } from "../content/ui";
import {
  decideTg,
  mergeSteps,
  runHighlights,
  TG_LABEL,
  TG_TINT,
  TG_TEST_REPO,
  tgActions,
  tgSteps,
  verdict,
  type TgAction,
  type TgCause,
  type TgResult,
  type TgStep,
} from "../core/tgreview";

/** The reader's pick for one judged failure: an action, and the issue a comment goes to. */
export interface TgPick {
  action?: string;
  /** `repo#number` of the issue a comment goes to, when not the suggested one. */
  target?: string;
}

export interface TgOverrides extends TgPick {
  /** The reader's pick for each cause, by its index in TgResult.causes. */
  causes?: Record<string, TgPick>;
}

export function chosenTg(r: TgResult, o: TgPick): TgAction {
  const a = o.action as TgAction | undefined;
  return a && tgActions(r).includes(a) ? a : decideTg(r).action;
}

function pickSteps(r: TgResult, o: TgPick): TgStep[] {
  const target = o.target ? r.tracks.find((t) => `${t.repo}#${t.number}` === o.target) : null;
  return tgSteps(r, chosenTg(r, o), target);
}

/** The judged causes, each with its index, result and the reader's pick; none for a job judged as one. */
export function causeParts(r: TgResult, o: TgOverrides): { i: number; c: TgCause; r: TgResult; o: TgPick }[] {
  return (r.causes ?? []).flatMap((c, i) =>
    c.result ? [{ i, c, r: c.result, o: o.causes?.[i] ?? {} }] : [],
  );
}

/** Every chosen write: the job's, or each cause's, with two causes on one issue in one comment. */
export function chosenTgSteps(r: TgResult, o: TgOverrides): TgStep[] {
  return r.causes ? mergeSteps(causeParts(r, o).flatMap((p) => pickSteps(p.r, p.o))) : pickSteps(r, o);
}

/** A write's identity: one comment per issue, one issue per title. What Apply or Accept already wrote is not
 *  written again, and a cause whose writes are done is locked. */
export const stepKey = (s: TgStep) =>
  s.kind === "comment" ? `comment|${s.repo}#${s.number}` : `issue|${s.repo}|${s.title}`;

/** What Accept applies: the suggestion where Accept may take it alone, or what the reader picked. For several causes,
 *  each cause on its own. */
export function acceptTgSteps(r: TgResult, o: TgOverrides): TgStep[] {
  const ok = (x: TgResult, p: TgPick) => !!p.action || decideTg(x).auto;
  if (!r.causes) return ok(r, o) ? pickSteps(r, o) : [];
  return mergeSteps(causeParts(r, o).flatMap((p) => (ok(p.r, p.o) ? pickSteps(p.r, p.o) : [])));
}

/** What the badge stands for: the job, or its newest cause, with the number of other judged causes. */
export function badgeOf(r: TgResult, o: TgOverrides): { r: TgResult; o: TgPick; more: number } {
  const ps = causeParts(r, o);
  return ps.length ? { r: ps[0]!.r, o: ps[0]!.o, more: ps.length - 1 } : { r, o, more: 0 };
}

/** `o` with a pick set: `k` is `action` or `target`, or `<cause index>:action` / `<cause index>:target`. An action
 *  equal to a suggestion Accept takes alone is no pick. */
export function withPick(r: TgResult, o: TgOverrides, k: string, v: string): TgOverrides {
  const m = /^(\d+):(action|target)$/.exec(k);
  const drop = <P extends TgPick>(x: TgResult | undefined, p: P): P => {
    const d = x && decideTg(x);
    if (d && p.action === d.action && d.auto) delete p.action;
    return p;
  };
  if (!m) return drop(r, { ...o, [k]: v });
  const i = m[1]!;
  return {
    ...o,
    causes: { ...o.causes, [i]: drop(r.causes?.[Number(i)]?.result, { ...o.causes?.[i], [m[2]!]: v }) },
  };
}

const ref = (repo: string, n: number) => (repo === "kubernetes/kubernetes" ? `#${n}` : `${repo}#${n}`);

export function describeTg(steps: TgStep[], testMode: boolean): string {
  if (!steps.length) return "nothing to write";
  return steps
    .map((s) =>
      s.kind === "issue"
        ? `open "${s.title}" (${s.labels.join(", ")}) in ${testMode ? `${TG_TEST_REPO} (test mode)` : s.repo}`
        : `comment on ${ref(s.repo, s.number)} with the job, its run counts and the newest failed runs${testMode ? `; in test mode, on its mirror in ${TG_TEST_REPO}` : ""}`,
    )
    .join(", then ");
}

const lines = (xs: (Node | string)[]) => h("span.snba-lines", {}, ...xs.map((x) => h("span", {}, x)));
const link = (href: string, text: string) => h("a", { href, target: "_blank", rel: "noopener" }, text);

function facts(r: TgResult): [string, Node | string][] {
  const f = r.facts;
  const out: [string, Node | string][] = [
    ["Job", `${f.job} (${f.status.toLowerCase()})`],
    [
      "Runs",
      `${f.failed_runs} of ${f.runs} failed, ${f.streak} in a row now; ${
        f.last_pass_days_ago === null
          ? "no pass in TestGrid's window"
          : `last pass ${f.last_pass_days_ago}d ago`
      }`,
    ],
    [
      "Failing",
      f.harness_only || !f.failing_tests.length
        ? "only the harness: the job fails around its tests"
        : lines(
            f.failing_tests
              .slice(0, 4)
              .map((t) => `${t.name.replace(/^[\w.-]+ Suite\.?\s*/, "")} (${t.failed})`),
          ),
    ],
  ];
  const e = r.evidence.find((x) => x.log_signals?.length || x.junit_failures.length);
  if (e) {
    const sig = [
      ...e.junit_failures.slice(0, 2).map((j) => `${j.test.slice(0, 120)}: ${j.message.slice(0, 160)}`),
      ...runHighlights(e),
    ].slice(0, 5);
    out.push([
      "Newest run",
      lines([link(e.url, "open in Prow"), ...sig.map((s) => h("code", {}, s.slice(0, 220)))]),
    ]);
  }
  if (r.tracks.length)
    out.push([
      "Issues",
      lines(
        r.tracks
          .slice(0, 4)
          .map((t) =>
            h(
              "span",
              {},
              link(t.url, ref(t.repo, t.number)),
              ` ${t.state === "closed" ? "(closed) " : ""}${t.title.slice(0, 80)}${t.names_job ? "" : "; does not name this job"}`,
            ),
          ),
      ),
    ]);
  const rel = r.related ?? [];
  if (rel.length)
    out.push([
      "Related",
      lines(
        rel
          .slice(0, 3)
          .map((t) =>
            h(
              "span",
              {},
              t.kind === "root_cause" ? "may cause this: " : "part of ",
              link(t.url, ref(t.repo, t.number)),
              ` ${t.state === "closed" ? "(closed) " : ""}${t.title.slice(0, 80)}`,
            ),
          ),
      ),
    ]);
  return out;
}

export interface TgHoverContent {
  result: TgResult;
  overrides: TgOverrides;
  /** stepKey of each write already made for this job (Accept writes only the causes it may take alone). */
  written?: Set<string>;
  setOverride(key: string, value: string): void;
  applied: Applied | undefined;
  canApply: boolean;
  testMode: boolean;
  scope: ParentNode;
  apply(): void;
  skip(): void;
}

/** The action and comment-target selects for one judged failure; `prefix` keys a cause's picks. */
function pickRows(
  r: TgResult,
  o: TgPick,
  locked: boolean,
  set: (k: string, v: string) => void,
  prefix = "",
): HTMLElement[] {
  const d = decideTg(r);
  const action = chosenTg(r, o);
  const unpicked = !d.auto && !o.action;
  const rows: HTMLElement[] = fact(
    "Action",
    h(
      "span.snba-hc-prio",
      {},
      select(
        "Action",
        `${prefix}action`,
        tgActions(r).map((a): [string, string] => [
          a,
          a === d.action ? `${TG_LABEL[a]} (suggested)` : TG_LABEL[a],
        ]),
        unpicked ? null : action,
        locked,
        (v) => set(`${prefix}action`, v),
        unpicked ? "Choose an action…" : undefined,
      ),
    ),
  );
  if (action === "comment" && r.tracks.length > 1) {
    const current =
      o.target ?? (verdict(r).issue ? `${verdict(r).issue!.repo}#${verdict(r).issue!.number}` : null);
    rows.push(
      ...fact(
        "On",
        h(
          "span.snba-hc-prio",
          {},
          select(
            "Issue",
            `${prefix}target`,
            r.tracks
              .slice(0, 5)
              .map((t): [string, string] => [
                `${t.repo}#${t.number}`,
                `${ref(t.repo, t.number)} (${Math.round(t.p * 100)}%)`,
              ]),
            current,
            locked,
            (v) => set(`${prefix}target`, v),
          ),
        ),
      ),
    );
  }
  return rows;
}

/** The chosen action, the suggestion when the reader picked another, and why. */
function decisionBlock(r: TgResult, o: TgPick): HTMLElement {
  const d = decideTg(r);
  const action = chosenTg(r, o);
  return h(
    "div.snba-decision",
    {},
    h(
      "div",
      {},
      h(`span.snba-verdict.snba-${TG_TINT[action].toLowerCase()}`, {}, TG_LABEL[action]),
      action !== d.action
        ? h("span.snba-muted", {}, ` (suggested: ${TG_LABEL[d.action].toLowerCase()})`)
        : !d.auto && !o.action
          ? h("span.snba-muted", {}, " (your call: Accept skips it until you choose an action)")
          : null,
    ),
    h("p.snba-why", {}, d.why),
  );
}

const shortDay = (ms: number) => new Date(ms).toISOString().slice(5, 10);

export function renderTgHoverCard(c: TgHoverContent): HTMLElement {
  const r = c.result;
  const o = c.overrides;
  const locked = c.applied?.state === "pending" || c.applied?.state === "done" || !c.canApply;
  const done = (x: TgStep[]) => x.length > 0 && x.every((st) => c.written?.has(stepKey(st)));
  const steps = chosenTgSteps(r, o).filter((st) => !c.written?.has(stepKey(st)));
  const box = actionBox({
    scope: c.scope,
    applied: c.applied,
    canApply: c.canApply,
    label: r.causes ? "Write for each cause" : TG_LABEL[chosenTg(r, o)],
    steps: [],
    summary: { text: describeTg(steps, c.testMode), writes: steps.length > 0 },
    where: "",
    apply: c.apply,
    skip: c.skip,
  });
  if (!r.causes)
    return h(
      "div.snba-hc-body",
      {},
      decisionBlock(r, o),
      readingsBlock(allReadings(r)),
      h(
        "dl.snba-hc-scores.snba-hc-facts",
        {},
        ...facts(r).flatMap(([k, v]) => fact(k, v)),
        ...pickRows(r, o, locked, c.setOverride),
      ),
      box,
    );
  // Several causes: the job's runs once, then each cause with its own readings, issues and action.
  const parts = causeParts(r, o);
  const started = new Map(r.evidence.map((e) => [e.build, e.started]));
  const runsOf = (x: TgCause) =>
    `${x.builds.length} run${x.builds.length === 1 ? "" : "s"}, newest ${shortDay(started.get(x.builds[0]!) ?? 0)}`;
  const oneOffs = (r.causes ?? []).filter((x) => !x.result);
  return h(
    "div.snba-hc-body",
    {},
    h(
      "div.snba-decision",
      {},
      h("div", {}, h("b", {}, `${r.causes!.length} causes in the ${r.evidence.length} failed runs read`)),
      h("p.snba-why", {}, "Each cause is judged on its own runs and has its own action."),
    ),
    readingsBlock((r.readings ?? []).filter((x) => x.label.startsWith("Same cause"))),
    h(
      "dl.snba-hc-scores.snba-hc-facts",
      {},
      ...facts(r)
        .slice(0, 2)
        .flatMap(([k, v]) => fact(k, v)),
    ),
    ...parts.map((p) =>
      h(
        "div.snba-tg-cause",
        {},
        h(
          "p.snba-tg-cause-head",
          {},
          `${p.i + 1} · ${(p.r.failure_kind?.choice ?? "unknown").replace(/_/g, " ")} · ${runsOf(p.c)}${done(pickSteps(p.r, p.o)) ? " · written" : ""}`,
        ),
        h("code.snba-tg-cause-label", {}, p.c.label.slice(0, 200)),
        decisionBlock(p.r, p.o),
        readingsBlock(allReadings(p.r)),
        h(
          "dl.snba-hc-scores.snba-hc-facts",
          {},
          ...facts(p.r)
            .slice(2)
            .flatMap(([k, v]) => fact(k, v)),
          ...pickRows(p.r, p.o, locked || done(pickSteps(p.r, p.o)), c.setOverride, `${p.i}:`),
        ),
      ),
    ),
    ...(oneOffs.length
      ? [
          h(
            "p.snba-muted",
            {},
            `One-off, not judged: ${oneOffs.map((x) => `${x.label.slice(0, 100)} (${runsOf(x)})`).join("; ")}`,
          ),
        ]
      : []),
    box,
  );
}
