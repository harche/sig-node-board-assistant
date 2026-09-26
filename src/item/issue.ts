/** The issue page's "CI history" and "Possible duplicates" sections (core/issuecheck.ts), on SIG Node and DRA
 *  issues. A section appears only when it has something to say: an issue naming a job TestGrid has, a duplicate
 *  candidate at P ≥ 0.35. Read-only: a suggested command is for the reader to post. */
import { findSidebar, placeSection } from "../content/adapters";
import { readingsBlock } from "../content/hcparts";
import { h } from "../content/ui";
import {
  decideIssueCi,
  ISSUE_CI_LABEL,
  ISSUE_CI_TINT,
  likelyDuplicate,
  type IssueCiResult,
  type IssueDupsResult,
} from "../core/issuecheck";
import { shortTest } from "../core/prci";
import { MAYBE_AT } from "../core/tgreview";
import { send } from "../shared/messages";

const link = (href: string, text: string) => h("a", { href, target: "_blank", rel: "noopener" }, text);
const lines = (xs: (Node | string)[]) => h("span.snba-lines", {}, ...xs.map((x) => h("span", {}, x)));
const ref = (repo: string, n: number, own: string) => `${repo === own ? "" : repo}#${n}`;

type Part<T> = { state: "idle" } | { state: "done"; result: T } | { state: "error"; message: string };

export class IssueCheck {
  private ci: Part<IssueCiResult | null> = { state: "idle" };
  private dups: Part<IssueDupsResult | null> = { state: "idle" };
  private version = 0;
  private rendered = "";
  private runs = 0;

  constructor(
    private repo: string,
    private number: number,
    private live: () => boolean,
  ) {}

  /** Both checks, side by side. A failed first read shows nothing; "Check again" reports its failure in place. */
  async run(refresh = false): Promise<void> {
    const gen = ++this.runs;
    const mine = () => gen === this.runs && this.live();
    const shown = { ci: this.ci.state === "done", dups: this.dups.state === "done" };
    const read = async <K extends "ci" | "dups">(k: K) => {
      const type = k === "ci" ? "issue.ci" : "issue.dups";
      try {
        const result = await send({ type, repo: this.repo, number: this.number, refresh });
        if (mine()) (this[k] as Part<unknown>) = { state: "done", result };
      } catch (e) {
        if (mine() && shown[k])
          (this[k] as Part<unknown>) = {
            state: "error",
            message: e instanceof Error ? e.message : String(e),
          };
      }
      if (mine()) this.bump();
    };
    await Promise.all([read("ci"), read("dups")]);
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
    const d = decideIssueCi(r, likelyDuplicate(dups, true));
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
    if (this.dups.state === "idle" || (this.dups.state === "done" && !this.dups.result)) return null;
    if (this.dups.state === "error") {
      const { root, body } = adapter.section("Possible duplicates");
      body.append(h("p.snba-error", {}, this.dups.message), this.again());
      return root;
    }
    const r = this.dups.result!;
    const shown = r.candidates.filter((c) => c.p >= MAYBE_AT);
    if (!shown.length) return null;
    const { root, body } = adapter.section("Possible duplicates");
    const top = likelyDuplicate(r);
    body.append(
      h(
        "p.snba-why",
        {},
        top
          ? `Likely the same as ${ref(top.repository, top.number, this.repo)} (${top.state}); Jev would keep ${top.keep === "this" ? "this one" : `${ref(top.repository, top.number, this.repo)}`} open.`
          : "Maybe the same as:",
      ),
      readingsBlock(shown.map((c) => ({ label: `#${c.number} is the same`, p: c.p }))),
      lines(
        shown.map((c) =>
          h(
            "span",
            {},
            link(c.url, ref(c.repository, c.number, this.repo)),
            ` ${c.state === "closed" ? "(closed) " : ""}${c.title.slice(0, 90)}`,
          ),
        ),
      ),
      this.foot(r.usage.cost),
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
    const b = h("button.snba-link", { type: "button" }, "Check again") as HTMLButtonElement;
    b.title = "Re-read the issue, TestGrid and GitHub search and ask Jev again, bypassing the cache";
    b.addEventListener("click", () => void this.run(true));
    return b;
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
