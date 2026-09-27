/** What a reviewer sees for a FAILING or FLAKY tab on a TestGrid dashboard: the action and why, Jev's readings as
 *  bars, the facts code computed (runs, failing tests, the newest failed runs' signal lines, candidate issues), and
 *  one action, the suggested one preselected unless it is the reviewer's call. */
import type { Applied } from "../content/hovercard";
import { actionBox, allReadings, fact, readingsBlock, select } from "../content/hcparts";
import { h } from "../content/ui";
import {
  decideTg,
  TG_LABEL,
  TG_TINT,
  TG_TEST_REPO,
  tgActions,
  tgSteps,
  verdict,
  type TgAction,
  type TgResult,
  type TgStep,
} from "../core/tgreview";

export interface TgOverrides {
  action?: string;
  /** `repo#number` of the issue a comment goes to, when not the suggested one. */
  target?: string;
}

export function chosenTg(r: TgResult, o: TgOverrides): TgAction {
  const a = o.action as TgAction | undefined;
  return a && tgActions(r).includes(a) ? a : decideTg(r).action;
}

export function chosenTgSteps(r: TgResult, o: TgOverrides): TgStep[] {
  const target = o.target ? r.tracks.find((t) => `${t.repo}#${t.number}` === o.target) : null;
  return tgSteps(r, chosenTg(r, o), target);
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
      ...(e.log_signals ?? []).filter((l) => !/^\[FAIL\]/.test(l)).slice(0, 4),
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
  setOverride(key: string, value: string): void;
  applied: Applied | undefined;
  canApply: boolean;
  testMode: boolean;
  scope: ParentNode;
  apply(): void;
  skip(): void;
}

export function renderTgHoverCard(c: TgHoverContent): HTMLElement {
  const r = c.result;
  const o = c.overrides;
  const d = decideTg(r);
  const action = chosenTg(r, o);
  const locked = c.applied?.state === "pending" || c.applied?.state === "done" || !c.canApply;
  const unpicked = !d.auto && !o.action;
  const rows: HTMLElement[] = fact(
    "Action",
    h(
      "span.snba-hc-prio",
      {},
      select(
        "Action",
        "action",
        tgActions(r).map((a): [string, string] => [
          a,
          a === d.action ? `${TG_LABEL[a]} (suggested)` : TG_LABEL[a],
        ]),
        unpicked ? null : action,
        locked,
        (v) => c.setOverride("action", v),
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
            "target",
            r.tracks
              .slice(0, 5)
              .map((t): [string, string] => [
                `${t.repo}#${t.number}`,
                `${ref(t.repo, t.number)} (${Math.round(t.p * 100)}%)`,
              ]),
            current,
            locked,
            (v) => c.setOverride("target", v),
          ),
        ),
      ),
    );
  }
  const steps = chosenTgSteps(r, o);
  return h(
    "div.snba-hc-body",
    {},
    h(
      "div.snba-decision",
      {},
      h(
        "div",
        {},
        h(`span.snba-verdict.snba-${TG_TINT[action].toLowerCase()}`, {}, TG_LABEL[action]),
        action !== d.action
          ? h("span.snba-muted", {}, ` (suggested: ${TG_LABEL[d.action].toLowerCase()})`)
          : unpicked
            ? h("span.snba-muted", {}, " (your call: Accept skips it until you choose an action)")
            : null,
      ),
      h("p.snba-why", {}, d.why),
    ),
    readingsBlock(allReadings(r)),
    h("dl.snba-hc-scores.snba-hc-facts", {}, ...facts(r).flatMap(([k, v]) => fact(k, v)), ...rows),
    actionBox({
      scope: c.scope,
      applied: c.applied,
      canApply: c.canApply,
      label: TG_LABEL[action],
      steps: [],
      summary: { text: describeTg(steps, c.testMode), writes: steps.length > 0 },
      where: "",
      apply: c.apply,
      skip: c.skip,
    }),
  );
}
