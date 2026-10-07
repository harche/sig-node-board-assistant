/** The PR page's "Failing CI" section: for each Prow job failing on the head commit, whether the PR broke it or it
 *  fails without the PR (a flake, the job's environment), the evidence, and the Prow command that reruns what is
 *  not the PR's. Read-only: the command is for the reader to post. On every pull request with a failed Prow job. */
import { findSidebar, placeSection } from "../content/adapters";
import { h } from "../content/ui";
import {
  CI_LABEL,
  CI_TINT,
  decideCi,
  rerunCommand,
  suspectFile,
  type CiJob,
  type FailedCheck,
  type PrChecks,
} from "../core/prci";
import { send } from "../shared/messages";
import { runButton } from "./button";
import { feedbackLink } from "../content/feedback";

type Slot = { state: "pending" } | { state: "error"; message: string } | { state: "done"; job: CiJob };

/** Jobs judged at once: each reads a few MB of TestGrid and GCS. */
const PARALLEL = 3;

const link = (href: string, text: string) => h("a", { href, target: "_blank", rel: "noopener" }, text);
const shortJob = (job: string) => job.replace(/^pull-kubernetes-/, "");

export class PrCi {
  private checks: PrChecks | null = null;
  private error: string | null = null;
  private slots = new Map<string, Slot>();
  private version = 0;
  private rendered = "";
  /** Bumped by each run, so a slower earlier run cannot overwrite a newer one's results. */
  private runs = 0;
  /** Whether the reader asked for the check: until then the section only counts the failures and offers it. */
  private started = false;

  constructor(
    private repo: string,
    private number: number,
    /** Whether this instance still owns the page (the reader has not moved to another item). */
    private live: () => boolean,
  ) {}

  /** Reads the checks only (no Jev): a PR with a failed Prow job gets the section and its button. A PR that passes,
   *  a repo without Prow, or one the token cannot read shows nothing. */
  async prepare(): Promise<void> {
    const gen = this.runs;
    try {
      const checks = await send({ type: "ci.checks", repo: this.repo, number: this.number });
      if (gen !== this.runs || !this.live() || this.started) return;
      this.checks = checks;
      this.bump();
    } catch {
      // Nothing to offer.
    }
  }

  /** Re-reads the checks and judges each failed job: the button's first click reads through the cache, later ones
   *  bypass it. A failed re-read keeps the section and reports its failure in it. */
  async run(refresh = false): Promise<void> {
    this.started = true;
    const gen = ++this.runs;
    const mine = () => gen === this.runs && this.live();
    this.error = null;
    this.slots.clear();
    this.bump();
    let checks: PrChecks;
    try {
      checks = await send({ type: "ci.checks", repo: this.repo, number: this.number, refresh });
    } catch (e) {
      if (mine() && this.checks) {
        this.error = e instanceof Error ? e.message : String(e);
        this.bump();
      }
      return;
    }
    if (!mine()) return;
    this.checks = checks;
    const queue = [...checks.failed];
    for (const c of queue) this.slots.set(c.job, { state: "pending" });
    this.bump();
    const worker = async () => {
      for (let c = queue.shift(); c && mine(); c = queue.shift()) await this.judge(c, refresh, mine);
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
  }

  private async judge(check: FailedCheck, refresh: boolean, mine: () => boolean): Promise<void> {
    let slot: Slot;
    try {
      const job = await send({ type: "ci.judge", repo: this.repo, number: this.number, check, refresh });
      slot = { state: "done", job };
    } catch (e) {
      slot = { state: "error", message: e instanceof Error ? e.message : String(e) };
    }
    if (!mine()) return;
    this.slots.set(check.job, slot);
    this.bump();
  }

  private bump(): void {
    this.version++;
    this.sync();
  }

  /** Puts the section in the sidebar, or redraws it when anything changed (GitHub may also redraw the sidebar). */
  sync(): void {
    if (!this.live()) return;
    const side = findSidebar(document);
    const existing = document.querySelector<HTMLElement>(".snba-ci");
    const key = `${this.repo}#${this.number}:${this.version}`;
    if (existing && side?.el.contains(existing) && this.rendered === key) return;
    existing?.remove();
    // Nothing failing, not read yet, or not a Prow repo: no section.
    if (!side || !this.checks?.failed.length) return;
    this.rendered = key;
    const { root, body } = side.adapter.section("Failing CI");
    root.classList.add("snba-ci");
    body.append(...this.content());
    const evidence = side.el.querySelector(".snba-evidence");
    if (evidence) evidence.after(root);
    else placeSection(side.el, root);
  }

  private content(): (HTMLElement | string)[] {
    if (this.error) return [h("p.snba-error", {}, this.error), this.again()];
    const c = this.checks!;
    if (!this.started)
      return [
        h(
          "p.snba-ci-head",
          {},
          `${c.failed.length} failing, ${c.passing} passing${c.pending.length ? `, ${c.pending.length} running` : ""}`,
        ),
        h(
          "div.snba-ci-start",
          {},
          runButton(
            "Check failures",
            "Read each failed job's logs, its record on other PRs and this PR's diff, and ask Jev whether the PR caused it",
            () => void this.run(),
          ),
        ),
      ];
    const slots = c.failed.map((f) => this.slots.get(f.job));
    const done = slots.flatMap((s) => (s?.state === "done" ? [s.job] : []));
    // A job whose judge failed is finished too: it shows its error, and the others' verdicts still count.
    const finished = slots.filter((s) => s && s.state !== "pending").length === c.failed.length;
    const verdicts = done.map(decideCi);
    const mine = verdicts.filter((v) => v.verdict === "this_pr").length;
    const notMine = verdicts.filter((v) => v.verdict === "flake" || v.verdict === "infra").length;
    const head = h(
      "p.snba-ci-head",
      {},
      `${c.failed.length} failing, ${c.passing} passing${c.pending.length ? `, ${c.pending.length} running` : ""}`,
      done.length
        ? h(
            "span.snba-muted",
            {},
            `: ${[mine && `${mine} this PR's`, notMine && `${notMine} not`, done.length - mine - notMine && `${done.length - mine - notMine} unsure`].filter(Boolean).join(", ")}`,
          )
        : null,
    );
    const out: HTMLElement[] = [head, ...c.failed.map((f) => this.jobBlock(f))];
    const cmd = finished ? rerunCommand(done, c.failed.length) : null;
    if (cmd) out.push(this.command(cmd));
    if (c.tide) out.push(h("p.snba-muted.snba-ci-tide", {}, `Tide: ${c.tide}`));
    const cost = done.reduce((a, j) => a + j.usage.cost, 0);
    out.push(
      h(
        "div.snba-foot",
        {},
        h(
          "span.snba-muted",
          {},
          finished
            ? `Jev read ${done.length} job${done.length === 1 ? "" : "s"}${cost ? ` for $${cost.toFixed(5)}` : ", cached"}.`
            : `Judging ${slots.filter((x) => !x || x.state === "pending").length} of ${c.failed.length}…`,
        ),
        this.again(),
      ),
    );
    return out;
  }

  private jobBlock(f: FailedCheck): HTMLElement {
    const s = this.slots.get(f.job);
    const name = link(f.url, shortJob(f.job));
    name.title = f.job;
    if (!s || s.state === "pending")
      return h("div.snba-ci-job", {}, h("div", {}, name, h("span.snba-muted", {}, " · judging…")));
    if (s.state === "error")
      return h("div.snba-ci-job", {}, h("div", {}, name), h("p.snba-error", {}, s.message));
    const j = s.job;
    const d = decideCi(j);
    return h(
      "div.snba-ci-job",
      {},
      h(
        "div",
        {},
        h(`span.snba-ci-verdict.snba-${CI_TINT[d.verdict].toLowerCase()}`, {}, CI_LABEL[d.verdict]),
        " ",
        name,
      ),
      h("p.snba-why", {}, ...this.why(d.why, d.verdict === "this_pr" ? suspectFile(j) : null)),
      feedbackLink(() => ({
        surface: `PR page · Failing CI · ${shortJob(f.job)}`,
        item: {
          repo: this.repo,
          number: this.number,
          url: `https://github.com/${this.repo}/pull/${this.number}`,
        },
        shown: `${CI_LABEL[d.verdict]}: ${d.why}`,
        result: j,
        context: { Job: f.job, "Job run": f.url },
        options: Object.values(CI_LABEL),
      })),
    );
  }

  /** The why, with the suspect file (its tail) linked to that file on the PR's Files changed tab. GitHub anchors a
   *  file's diff at `#diff-<sha256 of its path>`; until the hash is ready the link opens the tab's top. */
  private why(why: string, file: string | null): (string | HTMLElement)[] {
    if (!file || !why.endsWith(file)) return [why];
    const a = h("a", { href: `/${this.repo}/pull/${this.number}/files` }, file) as HTMLAnchorElement;
    void crypto.subtle.digest("SHA-256", new TextEncoder().encode(file)).then((buf) => {
      const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
      a.href = `/${this.repo}/pull/${this.number}/files#diff-${hex}`;
    });
    return [why.slice(0, -file.length), a];
  }

  private command(cmd: string): HTMLElement {
    const copy = h("button.snba-link", { type: "button" }, "Copy") as HTMLButtonElement;
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(cmd).then(() => {
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy"), 1500);
      });
    });
    return h(
      "div.snba-ci-cmd",
      {},
      h("div", {}, h("b", {}, "Rerun what is not this PR's"), " ", copy),
      h("pre.snba-pre", {}, cmd),
    );
  }

  private again(): HTMLElement {
    return runButton(
      "Check again",
      "Re-read the checks, logs and TestGrid and ask Jev again, bypassing the cache",
      () => void this.run(true),
    );
  }
}
