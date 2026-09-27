/** The issue page's "CI history" (core/issuecheck.ts) and "Duplicates and related" (core/related.ts) sections, on
 *  SIG Node and DRA issues. A section appears only when it has something to say: an issue naming a job TestGrid
 *  has, a duplicate or a related issue Jev is sure of. Both run when the reader clicks "Check": until then, and when
 *  neither has anything to say, one section offers the check. Read-only: a suggested command is for the reader to
 *  post. */
import { findSidebar, placeSection } from "../content/adapters";
import { readingsBlock } from "../content/hcparts";
import { h } from "../content/ui";
import { decideIssueCi, ISSUE_CI_LABEL, ISSUE_CI_TINT, type IssueCiResult } from "../core/issuecheck";
import { shortTest } from "../core/prci";
import { openDuplicate, type RelatedMatch, type RelatedResult } from "../core/related";
import { send } from "../shared/messages";
import { runButton } from "./button";

const link = (href: string, text: string) => h("a", { href, target: "_blank", rel: "noopener" }, text);
const lines = (xs: (Node | string)[]) => h("span.snba-lines", {}, ...xs.map((x) => h("span", {}, x)));
const ref = (repo: string, n: number, own: string) => `${repo === own ? "" : repo}#${n}`;

/** How a match relates to the issue on the page, in the page's terms. */
function relationLabel(m: RelatedMatch): string {
  switch (m.relation) {
    case "duplicate":
      return "duplicate";
    case "same_root_cause":
      return "same root cause";
    case "regression":
      return m.older ? "this is it coming back" : "it came back there";
    case "follow_up":
      return m.older ? "this follows up on it" : "follows up on this";
    case "part_of":
      return "umbrella or sub-item";
    default:
      return m.relation;
  }
}
const LINK_LABEL: Record<string, string> = {
  same_error: "same error",
  same_test: "same test",
  same_code_path: "same code path",
  same_request: "same request",
  same_trigger: "same trigger",
};

type Part<T> = { state: "idle" } | { state: "done"; result: T } | { state: "error"; message: string };

export class IssueCheck {
  private ci: Part<IssueCiResult | null> = { state: "idle" };
  private dups: Part<RelatedResult | null> = { state: "idle" };
  private version = 0;
  private rendered = "";
  private runs = 0;
  /** Whether the issue is SIG Node's or DRA's: only then is the check offered. */
  private scope = false;
  private started = false;
  private busy = false;

  constructor(
    private repo: string,
    private number: number,
    private live: () => boolean,
  ) {}

  /** Whether to offer the check: one cached GitHub read of the labels, no Jev. */
  async prepare(): Promise<void> {
    try {
      const scope = await send({ type: "issue.scope", repo: this.repo, number: this.number });
      if (!this.live()) return;
      this.scope = scope;
      this.bump();
    } catch {
      // Nothing to offer.
    }
  }

  /** Both checks, side by side: the first click reads through the cache, "Check again" bypasses it. A failure is
   *  reported in its section. */
  async run(refresh = false): Promise<void> {
    this.started = true;
    this.busy = true;
    const gen = ++this.runs;
    const mine = () => gen === this.runs && this.live();
    const read = async <K extends "ci" | "dups">(k: K) => {
      const type = k === "ci" ? "issue.ci" : "issue.dups";
      try {
        const result = await send({ type, repo: this.repo, number: this.number, refresh });
        if (mine()) (this[k] as Part<unknown>) = { state: "done", result };
      } catch (e) {
        if (mine())
          (this[k] as Part<unknown>) = {
            state: "error",
            message: e instanceof Error ? e.message : String(e),
          };
      }
      if (mine()) this.bump();
    };
    this.bump();
    await Promise.all([read("ci"), read("dups")]);
    if (!mine()) return;
    this.busy = false;
    this.bump();
  }

  private bump(): void {
    this.version++;
    this.sync();
  }

  sync(): void {
    if (!this.live()) return;
    const side = findSidebar(document);
    const key = `${this.repo}#${this.number}:${this.version}`;
    const have = [...document.querySelectorAll<HTMLElement>(".snba-issuecheck")];
    if (this.rendered === key && have.length && have.every((e) => side?.el.contains(e))) return;
    have.forEach((e) => e.remove());
    if (!side) return;
    this.rendered = key;
    const out: HTMLElement[] = [];
    const ci = this.ciSection(side.adapter);
    if (ci) out.push(ci);
    const dups = this.dupSection(side.adapter);
    if (dups) out.push(dups);
    if (!out.length) {
      const start = this.startSection(side.adapter);
      if (start) out.push(start);
    }
    if (!out.length) return;
    // After the board's evidence section when there is one, else where it would go.
    let after = side.el.querySelector(".snba-evidence");
    for (const el of out) {
      el.classList.add("snba-ci", "snba-issuecheck");
      if (after) after.after(el);
      else placeSection(side.el, el);
      after = el;
    }
  }

  private ciSection(adapter: NonNullable<ReturnType<typeof findSidebar>>["adapter"]): HTMLElement | null {
    if (this.ci.state === "idle" || (this.ci.state === "done" && !this.ci.result)) return null;
    if (this.ci.state === "error") {
      const { root, body } = adapter.section("CI history");
      body.append(h("p.snba-error", {}, this.ci.message), this.again());
      return root;
    }
    const r = this.ci.result!;
    const dups = this.dups.state === "done" ? this.dups.result : null;
    const d = decideIssueCi(r, openDuplicate(dups));
    // No run history for what the issue names: the section would only say so.
    if (d.verdict === "open") return null;
    const { root, body } = adapter.section("CI history");
    body.append(
      h(
        "div",
        {},
        h(
          `span.snba-ci-verdict.snba-${ISSUE_CI_TINT[d.verdict].toLowerCase()}`,
          {},
          ISSUE_CI_LABEL[d.verdict],
        ),
      ),
      h("p.snba-why", {}, d.why),
    );
    if (d.suggest) body.append(h("p.snba-ci-tide", {}, h("b", {}, "Suggested: "), d.suggest));
    body.append(
      h(
        "details.snba-ci-more",
        {},
        h("summary.snba-link", {}, "Evidence"),
        readingsBlock(r.readings),
        h(
          "dl.snba-hc-scores.snba-hc-facts",
          {},
          ...ciFacts(r, this.repo).flatMap(([k, v]) => [h("dt", {}, k), h("dd.snba-hc-text", {}, v)]),
        ),
      ),
      this.foot(r.usage.cost),
    );
    return root;
  }

  private dupSection(adapter: NonNullable<ReturnType<typeof findSidebar>>["adapter"]): HTMLElement | null {
    const title = "Duplicates and related";
    // The slower of the two (dozens of candidates): say it is still coming once the CI history is in.
    if (this.busy && this.dups.state === "idle" && this.ci.state !== "idle") {
      const { root, body } = adapter.section(title);
      body.append(h("p.snba-muted", {}, "Searching…"));
      return root;
    }
    if (this.dups.state === "idle" || (this.dups.state === "done" && !this.dups.result)) return null;
    if (this.dups.state === "error") {
      const { root, body } = adapter.section(title);
      body.append(h("p.snba-error", {}, this.dups.message), this.again());
      return root;
    }
    const r = this.dups.result!;
    if (!r.duplicates.length && !r.related.length) return null;
    const { root, body } = adapter.section(title);
    const row = (m: RelatedMatch) =>
      h(
        "div.snba-rel",
        {},
        h(
          "div",
          {},
          link(m.url, ref(m.repository, m.number, this.repo)),
          ` ${m.state === "closed" ? "(closed) " : ""}${m.title.slice(0, 90)}`,
        ),
        h(
          "div.snba-muted",
          {},
          [relationLabel(m), m.link ? LINK_LABEL[m.link] : null, `P ${m.p.toFixed(2)}`]
            .filter(Boolean)
            .join(" · "),
        ),
      );
    if (r.duplicates.length) body.append(h("div.snba-subhead", {}, "Duplicates"), ...r.duplicates.map(row));
    if (r.related.length) body.append(h("div.snba-subhead", {}, "Related"), ...r.related.map(row));
    body.append(
      h(
        "div.snba-foot",
        {},
        h(
          "span.snba-muted",
          {},
          `Jev read ${r.asked} candidates${r.usage.cost ? ` for $${r.usage.cost.toFixed(5)}` : ", cached"}.`,
        ),
        this.again(),
      ),
    );
    return root;
  }

  /** The section that offers the check, says it is running, or that it found nothing to show. */
  private startSection(adapter: NonNullable<ReturnType<typeof findSidebar>>["adapter"]): HTMLElement | null {
    if (!this.scope) return null;
    const { root, body } = adapter.section("CI history and duplicates");
    body.append(
      h(
        "p.snba-muted",
        {},
        this.busy
          ? "Checking…"
          : this.started
            ? "Nothing to show: no CI run history for what it names, and no duplicate or related issue Jev is sure of."
            : "Whether the failure it reports still happens on CI, and any duplicate or related issue.",
      ),
      h(
        "div.snba-ci-start",
        {},
        this.started
          ? this.again()
          : runButton(
              "Check",
              "Read the issue's CI run history and search for duplicates and related issues, and ask Jev",
              () => void this.run(),
            ),
      ),
    );
    return root;
  }

  private foot(cost: number): HTMLElement {
    return h(
      "div.snba-foot",
      {},
      h("span.snba-muted", {}, cost ? `Jev: $${cost.toFixed(5)}.` : "Jev: cached."),
      this.again(),
    );
  }

  private again(): HTMLElement {
    return runButton(
      "Check again",
      "Re-read the issue, TestGrid and GitHub search and ask Jev again, bypassing the cache",
      () => void this.run(true),
    );
  }
}

function ciFacts(r: IssueCiResult, repo: string): [string, Node | string][] {
  const out: [string, Node | string][] = [];
  for (const j of r.ci.slice(0, 3)) {
    const [dash, tab] = j.testgrid.split("#");
    const rows = typeof j.tracked_tests === "string" ? [] : j.tracked_tests;
    const w = j.whole_job;
    out.push([
      j.job.replace(/^ci-kubernetes-/, ""),
      lines([
        h(
          "span",
          {},
          w ? `job failed ${w.failures} of ${w.runs} runs in ${w.window_days}d (` : "(",
          link(`https://testgrid.k8s.io/${dash}#${tab}`, "TestGrid"),
          ")",
        ),
        ...rows.map(
          (t) =>
            `${shortTest(t.test)}: failed ${t.failures} of ${t.runs}${t.last_failure_days_ago !== null ? `, last ${t.last_failure_days_ago}d ago` : ""}${t.runs_after_fix !== undefined ? `; ${t.failures_after_fix} of ${t.runs_after_fix} since the fix` : ""}`,
        ),
        ...(typeof j.tracked_tests === "string" ? ["the tests it names: not in this job's recent runs"] : []),
      ]),
    ]);
  }
  const n = r.newest;
  if (n) {
    const sig = [
      ...n.evidence.junit_failures.slice(0, 2).map((f) => `${shortTest(f.test)}: ${f.message.slice(0, 160)}`),
      ...(n.evidence.log_signals ?? []).filter((l) => !/^\[FAIL\]/.test(l)).slice(0, 3),
    ].slice(0, 4);
    out.push([
      "Newest failure",
      lines([link(n.evidence.url, "open in Prow"), ...sig.map((s) => h("code", {}, s.slice(0, 220)))]),
    ]);
  }
  if (r.linked_prs.length)
    out.push([
      "Linked PRs",
      lines(
        r.linked_prs
          .slice(-4)
          .map(
            (p) =>
              `${ref(p.repository, p.number, repo)} ${p.state}${p.merged_days_ago !== undefined ? ` ${p.merged_days_ago}d ago` : ""}: ${p.title.slice(0, 70)}`,
          ),
      ),
    ]);
  if (r.guard) out.push(["Wait", r.guard]);
  return out;
}
