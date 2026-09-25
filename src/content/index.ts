/** Board page: a Tackle button in the header of each column that has a workflow (Triage, Issues - To do). Nothing
 *  is fetched or judged until it is clicked; then every item in the column is judged, each card gets a verdict
 *  badge and tint, and GitHub's own item pane gets the evidence section when it opens for one of those cards. Once
 *  every item is judged the header offers Accept (apply every recommendation, in parallel) or Cancel (back to the
 *  plain board). Every card also carries its own Tackle, which judges that one item. Hovering a judged card shows
 *  Jev's scores for it with buttons to apply an action to it alone.
 *  What differs per column is in workflows.ts. Fetching, judging and writing happen in the background worker. */
import { boardFromUrl, knownBoard } from "../core/boards";
import type { ActionStep, BoardItem, BoardRef } from "../core/types";
import { send } from "../shared/messages";
import { attachTooltip, findSidebar, nativeButton, PANE_SIDEBAR, placeSection } from "./adapters";
import { cardsIn, columns, isOurs, itemLink, paneItemId, placeBadge, placeRunButton, SEL } from "./dom";
import type { PaneState } from "./workflows";
import { HoverCard, type Applied } from "./hovercard";
import { Judged } from "./judged";
import { h, octicon } from "./ui";
import { WORKFLOWS, type ColumnWorkflow, type Overrides } from "./workflows";

/** Items judged or applied at once. */
const PARALLEL = 8;

/** What every column on the page shares: the settings pill, the one hover card, the idle buttons on columns
 *  without a workflow and GitHub's item pane. */
class Page {
  readonly hover: HoverCard;
  readonly assistants: BoardAssistant<unknown>[] = [];
  configured = { github: false, typesafe: false };
  private pillText: HTMLElement;
  private idleBtns = new Map<string, HTMLElement>();
  private scanTimer: number | null = null;

  constructor() {
    this.pillText = h("span");
    const pill = h(
      "button",
      { id: "snba-pill", type: "button", title: "SIG Node Board Assistant settings" },
      h("img", { src: chrome.runtime.getURL("icons/icon32.png"), alt: "" }),
      this.pillText,
    );
    pill.addEventListener("click", () => void send({ type: "options.open" }));
    document.body.append(pill);
    const owner = (restId: number) => this.assistants.find((a) => a.judges(restId));
    this.hover = new HoverCard(
      (restId) => owner(restId)?.hoverContent(restId) ?? null,
      (restId) => owner(restId)?.hoverKey(restId) ?? "",
    );
  }

  async start(): Promise<void> {
    this.configured = (await send({ type: "settings.get" })).configured;
    for (const a of this.assistants) a.updatePill();
    // Our own badge repaints and section renders are mutations too; ignoring them keeps scan from re-triggering itself.
    new MutationObserver((muts) => {
      if (muts.some((m) => !isOurs(m.target))) this.scheduleScan();
    }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener("popstate", () => this.scheduleScan());
    this.scheduleScan();
  }

  scheduleScan(): void {
    if (this.scanTimer !== null) return;
    this.scanTimer = window.setTimeout(() => {
      this.scanTimer = null;
      void this.scan();
    }, 150);
  }

  private async scan(): Promise<void> {
    const handled = new Set(this.assistants.map((a) => a.column));
    for (const col of columns(document)) {
      if (handled.has(col.name)) continue;
      let b = this.idleBtns.get(col.name);
      if (b?.isConnected) continue;
      if (!b) this.idleBtns.set(col.name, (b = idleButton(col.el, col.name)));
      placeRunButton(col.el, b);
    }
    await Promise.all(this.assistants.map((a) => a.scan()));
    this.syncPane();
  }

  /** Keeps the evidence section in GitHub's pane in step with the pane's current item: the column that has the
   *  item draws it; an item no column has gets none. */
  syncPane(): void {
    const restId = paneItemId();
    const owner = restId ? this.assistants.find((a) => a.has(restId)) : undefined;
    if (!restId || !owner || !owner.syncPane(restId)) document.querySelector(".snba-evidence")?.remove();
  }

  setPill(text: string): void {
    this.pillText.textContent = text;
  }
}

class BoardAssistant<R> {
  private items = new Map<number, BoardItem>();
  /** Items are independent, so the column is judged in parallel, 8 at a time: enough to be quick, few enough to keep
   *  clear of GitHub's secondary rate limit. A rate limit that happens anyway is retried in the worker. */
  private judged: Judged<R>;
  private columnLoad: Promise<void> | null = null;
  /** Where reading the column stands. The button, the double-click guard and the missing-card refresh all read it. */
  private load: { state: "idle" | "loading" | "loaded" } | { state: "failed"; message: string } = {
    state: "idle",
  };
  private refreshedOnce = false;
  /** Set by the column button. Until then the page is left exactly as GitHub drew it, apart from the button. */
  private started = false;
  private runBtn: HTMLElement | null = null;
  /** Shown instead of Tackle once every item is judged. */
  private acceptBtn: HTMLElement | null = null;
  private cancelBtn: HTMLElement | null = null;
  /** Writes per project item, from the header's Accept or from an item's own hover card buttons. */
  private applied = new Map<number, Applied>();
  /** Items skipped from their hover card (the CLI's `s`): verdict dropped, card back to its own Tackle. Kept so
   *  nothing judges them again behind the user's back; their own Tackle (or the header's) clears it. */
  private skipped = new Set<number>();
  /** Choices the reviewer made on the hover card in place of the suggested ones (a priority, an action); dropped
   *  with the verdict. */
  private overrides = new Map<number, Overrides>();
  /** The header's Accept is running. */
  private applying = false;
  /** The items the header's Accept is applying (or last applied): its counter and summary count only these. */
  private batch: number[] = [];
  /** The header's Accept has run: review is over and Tackle comes back to re-read what is left. */
  private accepted = false;
  /** What the last Accept did; the pill shows it until the next Tackle or Cancel. */
  private applySummary: string | null = null;

  constructor(
    private page: Page,
    private board: BoardRef,
    readonly column: string,
    private wf: ColumnWorkflow<R>,
  ) {
    this.judged = new Judged<R>(PARALLEL, wf.judge);
    this.judged.onChange((restId) => {
      this.paintBadge(restId);
      this.page.syncPane();
      this.updatePill();
      this.paintRunButton();
    });
  }

  private get hover(): HoverCard {
    return this.page.hover;
  }

  private get configured() {
    return this.page.configured;
  }

  /** This column has a verdict (or a judging) for the item: the hover card is ours to draw. */
  judges(restId: number): boolean {
    return this.judged.slots.has(restId);
  }

  has(restId: number): boolean {
    return this.items.has(restId);
  }

  hoverKey(restId: number): string {
    const slot = this.judged.slots.get(restId);
    const a = this.applied.get(restId);
    return [
      slot?.state,
      slot?.state === "done" ? this.wf.hoverKey(slot.result) : "",
      a?.state,
      a?.state === "error" ? a.message : "",
      this.applying,
      Boolean(this.judged.fields),
      JSON.stringify(this.overrides.get(restId) ?? {}),
    ].join("|");
  }

  async scan(): Promise<void> {
    // React re-renders the header and cards (and the board virtualises long columns), so both are re-attached here.
    const col = columns(document).find((c) => c.name === this.column);
    if (col) {
      this.runBtn ??= this.makeRunButton(col.el);
      this.acceptBtn ??= this.makeAcceptButton(col.el);
      this.cancelBtn ??= this.makeCancelButton(col.el);
      const btns = [this.runBtn, this.acceptBtn, this.cancelBtn];
      if (!btns.every((b) => b.isConnected)) {
        placeRunButton(col.el, ...btns);
        this.paintRunButton();
      }
    }
    // Every card gets its badge from the start: before it is judged the badge is the card's own Tackle.
    const cards = cardsIn(document, this.column);
    for (const c of cards) {
      let badge = c.el.querySelector<HTMLElement>(SEL.badge);
      // GitHub can reuse a card element for another item; a badge (and tint) from the old item is stale.
      if (badge && badge.dataset.restId !== String(c.restId)) {
        badge.remove();
        delete c.el.dataset.snbaVerdict;
        badge = null;
      }
      if (!badge) this.mountBadge(c.el, c.restId);
      else placeBadge(c.el, badge); // GitHub may draw the header after we mounted; move the badge into it
      this.watchHover(c.el);
      this.paintBadge(c.restId);
    }
    // Only against a finished read of a column-wide Tackle: while the first one is in flight every card looks missing.
    const missing =
      this.started && this.load.state === "loaded" ? cards.filter((c) => !this.items.has(c.restId)) : [];
    if (missing.length && !this.refreshedOnce) {
      this.refreshedOnce = true; // a card the 10-minute column cache does not know: refresh once, then accept staleness
      await this.ensureColumn(true);
      this.judgeAll();
    }
  }

  /** The column button: judge every item in the column, not only the cards the board has rendered. Every click is
   *  fresh: the column and each item are re-read from GitHub and Jev is asked again, skipping every cache. */
  private async run(): Promise<void> {
    if (!this.configured.github || !this.configured.typesafe) {
      void send({ type: "options.open" });
      return;
    }
    if (this.load.state === "loading" || this.running() || this.busy()) return;
    this.started = true;
    this.accepted = false;
    this.hover.close();
    this.applied.clear();
    this.skipped.clear();
    this.overrides.clear();
    this.applySummary = null;
    this.paintRunButton();
    await this.ensureColumn(true);
    this.judgeAll(true);
    this.paintRunButton();
    this.page.scheduleScan();
  }

  /** `fresh` (a Tackle click) re-judges every item past the caches; otherwise only items not judged yet or failed. */
  /** One card's own Tackle: judge just that item, fresh. The column is read first only if the item is not known yet
   *  (its node id, repo and number come from there); the header's state is left alone. */
  private async tackleOne(restId: number): Promise<void> {
    if (
      this.applying ||
      this.judged.slots.get(restId)?.state === "pending" ||
      this.applied.get(restId)?.state === "pending"
    )
      return;
    this.judged.slots.set(restId, { state: "pending" });
    this.paintBadge(restId);
    this.updatePill();
    if (!this.items.has(restId)) await this.ensureColumn(true);
    const item = this.items.get(restId);
    if (!item) {
      this.judged.fail(
        restId,
        this.load.state === "failed" ? this.load.message : `Not found in ${this.column} any more`,
      );
      return;
    }
    this.applied.delete(restId);
    this.skipped.delete(restId);
    this.overrides.delete(restId);
    await this.judged.judge(item, true);
    await this.afterJudge([item]);
  }

  private judgeAll(fresh = false): void {
    const batch: BoardItem[] = [];
    const jobs: Promise<void>[] = [];
    for (const item of this.items.values()) {
      const slot = this.judged.slots.get(item.restId);
      if (fresh || ((!slot || slot.state === "error") && !this.skipped.has(item.restId))) {
        batch.push(item);
        jobs.push(this.judged.judge(item, fresh));
      }
    }
    if (batch.length) void Promise.all(jobs).then(() => this.afterJudge(batch));
  }

  /** One item from the pane: judged, then the workflow's pass over it, so "Judge again" keeps (or finds) its
   *  duplicate instead of dropping it. */
  private async judgeOne(item: BoardItem, refresh = false): Promise<void> {
    await this.judged.judge(item, refresh);
    await this.afterJudge([item]);
  }

  /** The workflow's pass over what was just judged (To do: duplicates), which may amend some results. Items the
   *  reviewer skipped, or that are being written, keep what they have. */
  private async afterJudge(batch: BoardItem[]): Promise<void> {
    if (!this.wf.afterJudge) return;
    const results = new Map<number, R>();
    for (const i of batch) {
      const slot = this.judged.slots.get(i.restId);
      if (slot?.state === "done") results.set(i.restId, slot.result);
    }
    if (!results.size) return;
    this.afterRuns++;
    this.updatePill();
    try {
      const changed = await this.wf.afterJudge(
        this.board,
        batch.filter((i) => results.has(i.restId)),
        results,
      );
      for (const [restId, r] of changed) {
        const slot = this.judged.slots.get(restId);
        if (slot?.state === "done" && slot.result === results.get(restId) && !this.applied.has(restId))
          this.judged.update(restId, r);
      }
    } catch (e) {
      this.page.setPill(`Duplicate check failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.afterRuns--;
      this.updatePill();
      this.paintRunButton();
    }
  }

  /** The workflow's after-judging pass is running; the header waits for it before offering Accept. */
  private afterRuns = 0;
  private get afterPending(): boolean {
    return this.afterRuns > 0;
  }

  private running(): boolean {
    return (
      this.afterPending || [...this.items.keys()].some((id) => this.judged.slots.get(id)?.state === "pending")
    );
  }

  private ensureColumn(refresh = false): Promise<void> {
    // A read in flight is joined, never raced by a second (uncached) one.
    if (this.columnLoad && (!refresh || this.load.state === "loading")) return this.columnLoad;
    this.load = { state: "loading" };
    this.paintRunButton();
    this.columnLoad = (async () => {
      try {
        const [items] = await Promise.all([
          send({ type: "column.items", board: this.board, column: this.column, refresh }),
          this.judged.loadFields(this.board),
        ]);
        this.items = new Map(items.map((i) => [i.restId, i]));
        this.load = { state: "loaded" };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.load = { state: "failed", message };
        this.page.setPill(message);
      }
      this.paintRunButton();
    })();
    return this.columnLoad;
  }

  // ------------------------------------------------------------------ column button
  private makeRunButton(col: HTMLElement): HTMLElement {
    const b = tackleButton(col, () => void this.run());
    this.paintRunButton(b);
    return b;
  }

  private makeAcceptButton(col: HTMLElement): HTMLElement {
    const b = tackleButton(col, () => void this.accept(), CHECK, "Accept");
    b.classList.add("snba-accept");
    b.hidden = true;
    return b;
  }

  private makeCancelButton(col: HTMLElement): HTMLElement {
    const b = tackleButton(col, () => this.cancel(), X, "Cancel");
    b.hidden = true;
    return b;
  }

  private paintRunButton(b: HTMLElement | null = this.runBtn): void {
    if (!b) return;
    // Skipped items have no verdict on purpose; they are not "still judging".
    const ids = [...this.items.keys()].filter((id) => this.judged.slots.has(id) || !this.skipped.has(id));
    const slots = ids.map((id) => this.judged.slots.get(id));
    const settled = slots.filter((s) => s && s.state !== "pending").length;
    const errors = slots.filter((s) => s?.state === "error").length;
    let state: string;
    let text: string;
    let title: string;
    if (!this.started) {
      [state, text, title] = ["idle", "Tackle", this.wf.runTip(this.column)];
    } else if (this.load.state === "loading") {
      [state, text, title] = ["running", "Loading", `Reading ${this.column}`];
    } else if (this.load.state === "failed") {
      [state, text, title] = [
        "error",
        "Tackle again",
        `Couldn't read ${this.column}: ${this.load.message}. Click to try again.`,
      ];
    } else if (!ids.length) {
      [state, text, title] = ["done", "Tackle again", `${this.column} is empty. Click to read it again.`];
    } else if (slots.some((s) => !s || s.state === "pending")) {
      [state, text, title] = ["running", `${settled}/${ids.length}`, `Judging ${this.column} with Jev`];
    } else if (this.afterPending) {
      [state, text, title] = ["running", "Duplicates", `Comparing ${this.column} for duplicates`];
    } else {
      [state, text, title] = [
        errors ? "error" : "done",
        "Tackle again",
        `${ids.length - errors} judged${errors ? `, ${errors} failed` : ""}. Click to judge the whole column again, fresh.`,
      ];
    }
    if (b.dataset.state !== state) {
      b.dataset.state = state;
      b.querySelector("svg")?.replaceWith(
        octicon(state === "idle" ? PLAY : state === "error" ? ALERT : SYNC),
      );
    }
    const t = b.querySelector<HTMLElement>(".snba-run-text")!;
    if (t.textContent !== text) t.textContent = text;
    b.dataset.tip = title;
    this.paintReview();
  }

  /** A write is in flight: the header's Accept, or one item's own button. Tackle and Cancel wait for it. */
  private busy(): boolean {
    return this.applying || [...this.applied.values()].some((a) => a.state === "pending");
  }

  /** Every item judged (or Accept under way): Accept and Cancel take Tackle's place in the header. */
  private reviewing(): boolean {
    if (this.applying) return true;
    if (!this.started || this.load.state !== "loaded" || !this.items.size || this.running()) return false;
    // Once Accept has run, Tackle comes back to re-read what is left.
    return !this.accepted;
  }

  private paintReview(): void {
    const [run, accept, cancel] = [this.runBtn, this.acceptBtn, this.cancelBtn];
    if (!run || !accept || !cancel) return;
    const review = this.reviewing();
    // Tackle stays next to Accept while some items failed to judge, so the column can be judged again without Cancel.
    const failedJudging = [...this.items.keys()].some((id) => this.judged.slots.get(id)?.state === "error");
    run.hidden = review && (this.applying || !failedJudging);
    accept.hidden = cancel.hidden = !review;
    if (!review) return;
    const plan = this.plan();
    const counts: Record<string, number> = {};
    for (const p of plan) counts[p.tint] = (counts[p.tint] ?? 0) + 1;
    const borderline = [...this.items.keys()].filter((id) => {
      const slot = this.judged.slots.get(id);
      return (
        slot?.state === "done" &&
        this.wf.needsHuman(slot.result, this.overrides.get(id) ?? {}) &&
        !this.applied.has(id) &&
        !this.skipped.has(id)
      );
    }).length;
    const skipped = [...this.skipped].filter((id) => this.items.has(id) && !this.judged.slots.has(id)).length;
    const failed = [...this.items.keys()].filter((id) => this.judged.slots.get(id)?.state === "error").length;
    const left = [
      skipped && `${skipped} skipped`,
      borderline && `${borderline} borderline`,
      failed && `${failed} that failed to judge`,
    ].filter(Boolean);
    const settled = this.batch.filter((id) => this.applied.get(id)?.state !== "pending").length;
    setText(accept, this.applying ? `${settled}/${this.batch.length}` : "Accept");
    accept.dataset.state = this.applying ? "applying" : "ready";
    accept.setAttribute("aria-disabled", String(this.applying || !plan.length));
    accept.dataset.tip = this.applying
      ? "Applying the recommendations"
      : plan.length
        ? `Apply the recommendation to ${plan.length} item${plan.length === 1 ? "" : "s"}: ` +
          this.wf.acceptTip(counts) +
          (left.length
            ? `. ${left.join(" and ")} ${skipped + borderline + failed === 1 ? "stays" : "stay"} in ${this.column} for you.`
            : ".")
        : `Nothing to apply: every item needs your call or has nothing to change`;
    cancel.setAttribute("aria-disabled", String(this.busy()));
    cancel.dataset.tip = this.busy()
      ? "Can't cancel while applying"
      : `Discard the verdicts and go back to the board as it was`;
  }

  /** The recommended action for every item with a clear verdict that is not applied yet (or being applied);
   *  borderline, failed and nothing-to-do items are left out. */
  private plan(): { item: BoardItem; tint: string; steps: ActionStep[] }[] {
    const fields = this.judged.fields;
    if (!fields) return [];
    const out = [];
    for (const item of this.items.values()) {
      const slot = this.judged.slots.get(item.restId);
      if (slot?.state !== "done") continue;
      const applied = this.applied.get(item.restId)?.state;
      if (applied === "pending" || applied === "done" || this.skipped.has(item.restId)) continue;
      const rec = this.wf.recommended(item, slot.result, fields, this.overrides.get(item.restId) ?? {});
      if (rec) out.push({ item, ...rec });
    }
    return out;
  }

  /** Accept: the recommendations in parallel, 8 items at a time like judging. Each item's own steps run in order. */
  private async accept(): Promise<void> {
    if (!this.reviewing() || this.applying) return;
    const plan = this.plan();
    if (!plan.length) return;
    this.applying = true;
    this.batch = plan.map((p) => p.item.restId);
    for (const p of plan) this.applied.set(p.item.restId, { state: "pending" });
    this.repaintAll();
    const queue = [...plan];
    const worker = async () => {
      for (let p = queue.shift(); p; p = queue.shift()) await this.applySteps(p.item.restId, p.steps);
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, plan.length) }, worker));
    this.applying = false;
    this.accepted = true;
    const failed = this.batch.filter((id) => this.applied.get(id)?.state === "error").length;
    this.applySummary = `Applied ${this.batch.length - failed}${failed ? `, ${failed} failed` : ""}`;
    this.repaintAll();
  }

  /** One item's action from its hover card: its own write, independent of the header's Accept. */
  private async applyOne(restId: number, choice: string): Promise<void> {
    const item = this.items.get(restId);
    const slot = this.judged.slots.get(restId);
    const fields = this.judged.fields;
    const state = this.applied.get(restId)?.state;
    if (
      !item ||
      slot?.state !== "done" ||
      !fields ||
      this.applying ||
      state === "pending" ||
      state === "done"
    )
      return;
    const steps = this.wf.steps(item, slot.result, fields, this.overrides.get(restId) ?? {}, choice);
    if (!steps?.length) return;
    await this.applySteps(restId, steps);
  }

  private async applySteps(restId: number, steps: ActionStep[]): Promise<void> {
    // Choosing an action for a skipped item un-skips it: if the write fails, Accept can retry it like any other.
    this.skipped.delete(restId);
    this.applied.set(restId, { state: "pending" });
    this.paintBadge(restId);
    this.paintRunButton();
    try {
      await send({ type: "item.apply", board: this.board, restId, steps });
      this.applied.set(restId, { state: "done" });
    } catch (e) {
      this.applied.set(restId, { state: "error", message: e instanceof Error ? e.message : String(e) });
    }
    this.paintBadge(restId);
    this.paintRunButton();
  }

  /** Skip: no write, as in the CLI. The verdict is dropped, so the card reads Tackle again, loses its tint and
   *  falls out of the header's Accept. */
  private skip(restId: number): void {
    // Only this item's own write, or the header's Accept, holds it; another item's write does not.
    if (this.applying || this.applied.get(restId)?.state === "pending") return;
    this.skipped.add(restId);
    this.overrides.delete(restId);
    this.judged.slots.delete(restId);
    this.applied.delete(restId);
    this.hover.close();
    this.paintBadge(restId);
    this.updatePill();
    this.paintRunButton();
    this.page.syncPane();
  }

  hoverContent(restId: number): HTMLElement | null {
    const item = this.items.get(restId);
    const slot = this.judged.slots.get(restId);
    const col = columns(document).find((c) => c.name === this.column)?.el;
    if (!item || slot?.state !== "done" || !col) return null;
    return this.wf.hover({
      item,
      result: slot.result,
      overrides: this.overrides.get(restId) ?? {},
      setOverride: (k, v) => this.setOverride(restId, k, v),
      fields: this.judged.fields,
      applied: this.applied.get(restId),
      canApply: !this.applying,
      skip: () => this.skip(restId),
      scope: col,
      apply: (choice) => void this.applyOne(restId, choice),
    });
  }

  /** A pick on the hover card (a priority, an action) in place of the suggested one. */
  private setOverride(restId: number, key: string, value: string): void {
    const slot = this.judged.slots.get(restId);
    const state = this.applied.get(restId)?.state;
    if (slot?.state !== "done" || this.applying || state === "pending" || state === "done") return;
    const next = this.wf.override(slot.result, this.overrides.get(restId) ?? {}, key, value);
    if (Object.keys(next).length) this.overrides.set(restId, next);
    else this.overrides.delete(restId);
    this.paintBadge(restId);
    this.paintRunButton();
    this.hover.refresh(restId);
  }

  /** Cancel: drop every verdict and our marks on the board; the next Tackle starts over (Jev answers are cached). */
  private cancel(): void {
    if (this.busy()) return;
    this.started = false;
    this.accepted = false;
    this.hover.close();
    this.judged.slots.clear();
    this.applied.clear();
    this.skipped.clear();
    this.overrides.clear();
    this.applySummary = null;
    // Only this column's badges and tints: the other columns keep theirs.
    const col = columns(document).find((c) => c.name === this.column)?.el;
    for (const b of col?.querySelectorAll(SEL.badge) ?? []) b.remove();
    for (const c of col?.querySelectorAll<HTMLElement>("[data-snba-verdict]") ?? [])
      delete c.dataset.snbaVerdict;
    this.page.syncPane();
    this.updatePill();
    this.paintRunButton();
  }

  private repaintAll(): void {
    for (const id of this.items.keys()) this.paintBadge(id);
    this.updatePill();
    this.paintRunButton();
  }

  // ------------------------------------------------------------------ badges
  private mountBadge(card: HTMLElement, restId: number): void {
    const b = h(
      "button.snba-badge",
      { type: "button", "data-rest-id": String(restId) },
      h("span.snba-dot"),
      h("span.snba-text"),
    );
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!this.configured.github || !this.configured.typesafe) {
        void send({ type: "options.open" });
        return;
      }
      // Not judged yet (or judging failed): the badge is this item's own Tackle.
      const slot = this.judged.slots.get(restId);
      if (!slot || slot.state === "error") {
        void this.tackleOne(restId);
        return;
      }
      // Same as clicking the title: GitHub opens the pane for an issue and a new tab for a PR.
      itemLink(card)?.click();
    });
    for (const ev of ["mousedown", "pointerdown", "keydown"])
      b.addEventListener(ev, (e) => e.stopPropagation());
    b.addEventListener("focus", () => this.hover.hoverStart(restId, b, 0));
    b.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && !e.shiftKey && this.hover.isOpenFor(restId) && this.hover.focusInto())
        e.preventDefault();
    });
    b.addEventListener("blur", (e) => {
      if (!this.hover.el.contains(e.relatedTarget as Node | null)) this.hover.hoverEnd();
    });
    placeBadge(card, b);
  }

  /** Hovering anywhere on a card opens its hover card. The item id is read at hover time because GitHub can
   *  reuse a card element for another item; the listeners go on once per element. */
  private hoverWatched = new WeakSet<HTMLElement>();
  private watchHover(card: HTMLElement): void {
    if (this.hoverWatched.has(card)) return;
    this.hoverWatched.add(card);
    card.addEventListener("mouseenter", () => {
      const restId = Number(card.dataset.boardCardId);
      if (restId) this.hover.hoverStart(restId, card);
    });
    card.addEventListener("mouseleave", () => this.hover.hoverEnd());
  }

  private paintBadge(restId: number): void {
    const b = document.querySelector<HTMLElement>(`${SEL.badge}[data-rest-id="${restId}"]`);
    if (!b) return;
    let verdict: string;
    let text: string;
    let title: string;
    const slot = this.judged.slots.get(restId);
    if (!slot) {
      [verdict, text, title] = ["idle", "Tackle", "Judge this item with Jev"];
    } else if (slot.state === "pending") {
      [verdict, text, title] = ["pending", "judging", "Asking Jev"];
    } else if (slot.state === "error") {
      [verdict, text, title] = ["error", "error", `${slot.message}. Click to try again.`];
    } else {
      const b = this.wf.badge(slot.result, this.overrides.get(restId) ?? {});
      // No native tooltip once judged: the hover card takes its place.
      [verdict, text, title] = [b.tint, b.text, ""];
    }
    const applied = this.applied.get(restId);
    if (applied?.state === "pending") text = "applying";
    else if (applied?.state === "done") text = "applied";
    else if (applied?.state === "error") [verdict, text] = ["error", "failed"];
    // Only touch the DOM when something changed: every write here is a mutation other observers see.
    if (b.dataset.verdict !== verdict) b.dataset.verdict = verdict;
    const t = b.querySelector<HTMLElement>(".snba-text")!;
    if (t.textContent !== text) t.textContent = text;
    if (b.title !== title) b.title = title;
    // Tint the whole card with the verdict's muted colour (content.css); only settled verdicts tint.
    const card = b.closest<HTMLElement>("[data-board-card-id]");
    const tint = slot?.state === "done" ? verdict : undefined;
    if (card && card.dataset.snbaVerdict !== tint) {
      if (tint) card.dataset.snbaVerdict = tint;
      else delete card.dataset.snbaVerdict;
    }
    this.hover.refresh(restId);
  }

  // ------------------------------------------------------------------ pane
  /** Draws (or keeps) the evidence section for `restId` in GitHub's pane. False when this column shows nothing for
   *  it, so the page removes any section there. */
  syncPane(restId: number): boolean {
    const item = this.items.get(restId);
    if (!item) return false;
    const existing = document.querySelector<HTMLElement>(".snba-evidence");
    const side = findSidebar(document);
    if (!side || !side.el.matches(PANE_SIDEBAR)) return true;
    const slot = this.judged.slots.get(restId);
    // Before any Tackle the pane is GitHub's own; after a column-wide Tackle every item gets the section, except one
    // the user skipped.
    if (!slot && (!this.started || this.skipped.has(restId))) return false;
    const st: PaneState<R> =
      !slot || slot.state === "pending"
        ? { state: "pending" }
        : slot.state === "error"
          ? { state: "error", message: slot.message }
          : { state: "done", result: slot.result, fields: this.judged.fields };
    const key = `${this.column}:${restId}:${st.state}:${this.judged.fields ? 1 : 0}:${st.state === "done" ? this.wf.hoverKey(st.result) : ""}`;
    if (existing?.dataset.snbaKey === key && existing.isConnected && side.el.contains(existing)) return true;
    existing?.remove();
    const section = this.wf.pane(side.adapter, item, st, (it) => this.judgeOne(it, true));
    section.dataset.snbaKey = key;
    placeSection(side.el, section);
    if (!slot && !this.skipped.has(restId)) void this.judgeOne(item);
    return true;
  }

  updatePill(): void {
    if (!this.configured.github || !this.configured.typesafe) {
      this.page.setPill("Add your tokens to start");
      return;
    }
    const done = [...this.judged.slots.values()].filter((s) => s.state === "done").length;
    const pending = [...this.judged.slots.values()].filter((s) => s.state === "pending").length;
    if (!this.started && !this.judged.slots.size) {
      // Only the page's first column speaks before anything started, so the pill names the column Tackle is on.
      if (this.page.assistants[0] === this)
        this.page.setPill(`Click Tackle on a column or on a card to start`);
      return;
    }
    if (this.applySummary) {
      this.page.setPill(`${this.column}: ${this.applySummary}`);
      return;
    }
    this.page.setPill(
      `${this.column}: ${done} judged${pending ? `, ${pending} pending` : ""}${this.afterPending ? ", checking duplicates" : ""}`,
    );
  }
}

/** Same button on a column whose workflow is not in the extension yet: shown so every column reads the same,
 *  but disabled (aria-disabled keeps the tooltip, which a disabled button would not show). */
function idleButton(col: HTMLElement, name: string): HTMLElement {
  const b = tackleButton(col, () => {});
  b.setAttribute("aria-disabled", "true");
  b.dataset.state = "unavailable";
  b.dataset.tip = `Not implemented yet: ${name} has no workflow in the extension`;
  return b;
}

/** The column header's button, drawn with GitHub's own button classes where possible. */
function tackleButton(col: HTMLElement, onClick: () => void, icon = PLAY, text = "Tackle"): HTMLElement {
  const { root: b, label, native } = nativeButton(col, octicon(icon), text);
  b.classList.add("snba-run");
  label.classList.add("snba-run-text");
  if (!native) b.classList.add("snba-run-plain");
  attachTooltip(b, col);
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (b.getAttribute("aria-disabled") !== "true") onClick();
  });
  // The column header is a drag handle; keep our clicks from starting a column drag.
  for (const ev of ["mousedown", "pointerdown", "keydown"])
    b.addEventListener(ev, (e) => e.stopPropagation());
  return b;
}

const PLAY =
  "M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm4.879-2.773 4.264 2.559a.25.25 0 0 1 0 .428l-4.264 2.559A.25.25 0 0 1 6 10.559V5.442a.25.25 0 0 1 .379-.215Z";
const SYNC =
  "M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z";

const CHECK =
  "M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z";
const X =
  "M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z";

const ALERT =
  "M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z";

function setText(b: HTMLElement, text: string): void {
  const t = b.querySelector<HTMLElement>(".snba-run-text")!;
  if (t.textContent !== text) t.textContent = text;
}

function boot(): void {
  const ref = boardFromUrl(location.href);
  if (!ref) return;
  const board = knownBoard(ref);
  const flows = Object.entries(board?.workflows ?? {}).filter(([name]) => WORKFLOWS[name]);
  if (!flows.length) {
    console.info(`[sig-node-board-assistant] ${ref.owner}/${ref.number} has no workflow yet; idle.`);
    return;
  }
  const page = new Page();
  for (const [name, column] of flows)
    page.assistants.push(new BoardAssistant(page, ref, column, WORKFLOWS[name]!));
  void page.start();
}

if (typeof chrome !== "undefined" && chrome.runtime?.id) boot();
