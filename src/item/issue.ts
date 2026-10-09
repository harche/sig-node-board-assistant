/** The issue page's "CI history" (core/issuecheck.ts) and "Duplicates and related" (core/related.ts) sections, on
 *  SIG Node and DRA issues. A section appears only when it has something to say: an issue naming a job TestGrid
 *  has, a duplicate or a related issue Jev is sure of. Both run when the reader clicks "Check": until then, and when
 *  neither has anything to say, one section offers the check. A suggested command is for the reader to post; the one
 *  write is the comment listing the duplicates and related issues the reader ticks (issue.comment). */
import { findSidebar, pageButton, placeSection } from "../content/adapters";
import { readingsBlock } from "../content/hcparts";
import { h } from "../content/ui";
import { decideIssueCi, ISSUE_CI_LABEL, ISSUE_CI_TINT, type IssueCiResult } from "../core/issuecheck";
import { shortTest } from "../core/prci";
import { openDuplicate, shortRef as ref, type RelatedResult } from "../core/related";
import { send } from "../shared/messages";
import { feedbackLink } from "../content/feedback";
import { freshPicks, relatedPicker, relationLabel, type PickState } from "../content/relatedpick";
import { runButton } from "./button";

const link = (href: string, text: string) => h("a", { href, target: "_blank", rel: "noopener" }, text);
const lines = (xs: (Node | string)[]) => h("span.snba-lines", {}, ...xs.map((x) => h("span", {}, x)));

type Part<T> = { state: "idle" } | { state: "done"; result: T } | { state: "error"; message: string };

export class IssueCheck {
  private ci: Part<IssueCiResult | null> = { state: "idle" };
  private dups: Part<RelatedResult | null> = { state: "idle" };
  private version = 0;
  private rendered = "";
  /** How many sections the last render placed: GitHub can redraw its sidebar and drop one of them. */
  private placed = 0;
  private runs = 0;
  /** Whether the issue is SIG Node's or DRA's: only then is the check offered. */
  private scope = false;
  private started = false;
  private busy = false;
  /** The reader's ticks and the comment's write. A new search ticks afresh but keeps a posted (or posting) comment,
   *  so "Check again" does not offer it twice; the worker also refuses a second one on the thread. */
  private picks: PickState = freshPicks(null);

  constructor(
    private repo: string,
    private number: number,
    private live: () => boolean,
  ) {}

  /** Whether to offer the check: one GitHub read of the labels, no Jev. */
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

  /** Both checks, side by side, read fresh on every click ("Check again" too). A failure is reported in its
   *  section. */
  async run(): Promise<void> {
    this.started = true;
    this.busy = true;
    const gen = ++this.runs;
    const mine = () => gen === this.runs && this.live();
    const read = async <K extends "ci" | "dups">(k: K) => {
      const type = k === "ci" ? "issue.ci" : "issue.dups";
      try {
        const result = await send({ type, repo: this.repo, number: this.number });
        if (mine()) (this[k] as Part<unknown>) = { state: "done", result };
        if (mine() && k === "dups") {
          const post = this.picks.post;
          this.picks = freshPicks(
            result as RelatedResult | null,
            post.state === "pending" || post.state === "done" ? post : { state: "idle" },
          );
        }
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
    if (this.rendered === key && have.length === this.placed && have.every((e) => side?.el.contains(e)))
      return;
    // A redraw replaces the control that had focus (a checkbox, Comment): focus goes to the same one in the new
    // sections, else to the section it was in.
    const active = document.activeElement as HTMLElement | null;
    const inside = have.find((e) => active && e.contains(active));
    const focusKey = inside ? active!.dataset.focusKey : undefined;
    const title = inside?.querySelector("h3")?.textContent;
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
    this.placed = out.length;
    if (!out.length) return;
    // After the board's evidence section when there is one, else where it would go.
    let after = side.el.querySelector(".snba-evidence");
    for (const el of out) {
      el.classList.add("snba-ci", "snba-issuecheck");
      if (after) after.after(el);
      else placeSection(side.el, el);
      after = el;
    }
    if (!inside) return;
    const same = focusKey
      ? out
          .map((el) => el.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`))
          .find(Boolean)
      : null;
    const section = out.find((el) => el.querySelector("h3")?.textContent === title);
    const to = same ?? section;
    if (!to) return;
    if (!same) to.tabIndex = -1;
    to.focus({ preventScroll: true });
  }

  private ciSection(adapter: NonNullable<ReturnType<typeof findSidebar>>["adapter"]): HTMLElement | null {
    // Duplicates can come back first: say the CI history is still coming.
    if (this.busy && this.ci.state === "idle" && this.dups.state !== "idle") {
      const { root, body } = adapter.section("CI history");
      body.append(h("p.snba-muted", {}, "Reading the run history…"));
      return root;
    }
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
      feedbackLink(() => ({
        surface: "Issue page · CI history",
        item: this.item(),
        shown: `${ISSUE_CI_LABEL[d.verdict]}: ${d.why}${d.suggest ? ` Suggested: ${d.suggest}` : ""}`,
        result: r,
        context: {},
        options: Object.values(ISSUE_CI_LABEL),
      })),
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
    body.append(
      ...relatedPicker({
        repo: this.repo,
        number: this.number,
        result: r,
        state: this.picks,
        blocked: null,
        button: (label) => pageButton(label),
        comment: (b) => void this.comment(b),
      }),
    );
    body.append(
      h(
        "div.snba-foot",
        {},
        h("span.snba-muted", {}, `Jev read ${r.asked} candidates for $${r.usage.cost.toFixed(5)}.`),
        this.again(),
      ),
      feedbackLink(() => ({
        surface: "Issue page · Duplicates and related",
        item: this.item(),
        shown: [
          ...r.duplicates.map((m) => `duplicate: ${m.repository}#${m.number} (P ${m.p.toFixed(2)})`),
          ...r.related.map(
            (m) => `related: ${m.repository}#${m.number} (${relationLabel(m)}, P ${m.p.toFixed(2)})`,
          ),
        ].join("; "),
        result: r,
        context: {},
      })),
    );
    return root;
  }

  /** Posts the related-issues comment (the worker sends it to the test repo in test mode). */
  private async comment(body: string): Promise<void> {
    const picks = this.picks;
    if (picks.post.state === "pending" || picks.post.state === "done") return;
    picks.post = { state: "pending" };
    this.bump();
    try {
      const { wrote, already } = await send({
        type: "issue.comment",
        repo: this.repo,
        number: this.number,
        body,
      });
      picks.post = { state: "done", wrote, already };
    } catch (e) {
      picks.post = { state: "error", message: e instanceof Error ? e.message : String(e) };
    }
    if (this.live()) this.bump();
  }

  private item() {
    return {
      repo: this.repo,
      number: this.number,
      url: `https://github.com/${this.repo}/issues/${this.number}`,
    };
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
    return h("div.snba-foot", {}, h("span.snba-muted", {}, `Jev: $${cost.toFixed(5)}.`), this.again());
  }

  private again(): HTMLElement {
    return runButton(
      "Check again",
      "Re-read the issue, TestGrid and GitHub search and ask Jev again",
      () => void this.run(),
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
