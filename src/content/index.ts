/** Board page: a Tackle button in the judged column's header. Nothing is fetched or judged until it is clicked; then
 *  every item in the column is judged (like the CLI's `triage`), each card gets a verdict badge and tint, and
 *  GitHub's own item pane gets the evidence section when it opens for one of those cards. Once every item is
 *  judged the header offers Accept (apply every recommendation, in parallel) or Cancel (back to the plain board).
 *  Fetching, judging and writing happen in the background worker. */
import { boardFromUrl, knownBoard } from "../core/boards";
import { proposedActions } from "../core/triage";
import type { BoardItem, BoardRef } from "../core/types";
import { send } from "../shared/messages";
import { attachTooltip, findSidebar, nativeButton, PANE_SIDEBAR, placeSection } from "./adapters";
import { cardsIn, columns, isOurs, itemLink, paneItemId, placeBadge, placeRunButton, SEL } from "./dom";
import { renderEvidence, type EvidenceState } from "./evidence";
import { Judged } from "./judged";
import { h, octicon } from "./ui";

/** Items judged or applied at once. */
const PARALLEL = 8;

class BoardAssistant {
  private items = new Map<number, BoardItem>();
  /** Items are independent, so the column is judged in parallel, 8 at a time: enough to be quick, few enough to keep
   *  clear of GitHub's secondary rate limit. A rate limit that happens anyway is retried in the worker. */
  private judged = new Judged(PARALLEL);
  private pill: HTMLElement;
  private pillText: HTMLElement;
  private configured = { github: false, typesafe: false };
  private columnLoad: Promise<void> | null = null;
  /** Where reading the column stands. The button, the double-click guard and the missing-card refresh all read it. */
  private load: { state: "idle" | "loading" | "loaded" } | { state: "failed"; message: string } = {
    state: "idle",
  };
  private refreshedOnce = false;
  private scanTimer: number | null = null;
  /** Set by the column button. Until then the page is left exactly as GitHub drew it, apart from the button. */
  private started = false;
  private runBtn: HTMLElement | null = null;
  /** Tackle buttons on the columns without a workflow yet, by column name. */
  private idleBtns = new Map<string, HTMLElement>();
  /** Shown instead of Tackle once every item is judged. */
  private acceptBtn: HTMLElement | null = null;
  private cancelBtn: HTMLElement | null = null;
  /** Accept's writes, per project item. */
  private applied = new Map<number, { state: "pending" | "done" } | { state: "error"; message: string }>();
  private applying = false;
  /** What the last Accept did; the pill shows it until the next Tackle or Cancel. */
  private applySummary: string | null = null;

  constructor(
    private board: BoardRef,
    private column: string,
  ) {
    this.pillText = h("span");
    this.pill = h(
      "button",
      { id: "snba-pill", type: "button", title: "SIG Node Board Assistant settings" },
      h("img", { src: chrome.runtime.getURL("icons/icon32.png"), alt: "" }),
      this.pillText,
    );
    this.pill.addEventListener("click", () => void send({ type: "options.open" }));
    document.body.append(this.pill);
    this.judged.onChange((restId) => {
      this.paintBadge(restId);
      this.syncPane();
      this.updatePill();
      this.paintRunButton();
    });
  }

  async start(): Promise<void> {
    this.configured = (await send({ type: "settings.get" })).configured;
    this.updatePill();
    // Our own badge repaints and section renders are mutations too; ignoring them keeps scan from re-triggering itself.
    new MutationObserver((muts) => {
      if (muts.some((m) => !isOurs(m.target))) this.scheduleScan();
    }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener("popstate", () => this.scheduleScan());
    this.scheduleScan();
  }

  private scheduleScan(): void {
    if (this.scanTimer !== null) return;
    this.scanTimer = window.setTimeout(() => {
      this.scanTimer = null;
      void this.scan();
    }, 150);
  }

  private async scan(): Promise<void> {
    // React re-renders the header and cards (and the board virtualises long columns), so both are re-attached here.
    for (const col of columns(document)) {
      if (col.name === this.column) {
        this.runBtn ??= this.makeRunButton(col.el);
        this.acceptBtn ??= this.makeAcceptButton(col.el);
        this.cancelBtn ??= this.makeCancelButton(col.el);
        const btns = [this.runBtn, this.acceptBtn, this.cancelBtn];
        if (btns.every((b) => b.isConnected)) continue;
        placeRunButton(col.el, ...btns);
        this.paintRunButton();
      } else {
        let b = this.idleBtns.get(col.name);
        if (b?.isConnected) continue;
        if (!b) this.idleBtns.set(col.name, (b = this.makeIdleButton(col.el, col.name)));
        placeRunButton(col.el, b);
      }
    }
    if (!this.started) return;
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
      this.paintBadge(c.restId);
    }
    // Only against a finished read: while the first one is in flight every card looks missing.
    const missing = this.load.state === "loaded" ? cards.filter((c) => !this.items.has(c.restId)) : [];
    if (missing.length && !this.refreshedOnce) {
      this.refreshedOnce = true; // a card the 10-minute column cache does not know: refresh once, then accept staleness
      await this.ensureColumn(true);
      this.judgeAll();
    }
    this.syncPane();
  }

  /** The column button: judge every item in the column, not only the cards the board has rendered. Every click is
   *  fresh: the column and each item are re-read from GitHub and Jev is asked again, skipping every cache. */
  private async run(): Promise<void> {
    if (!this.configured.github || !this.configured.typesafe) {
      void send({ type: "options.open" });
      return;
    }
    if (this.load.state === "loading" || this.running() || this.applying) return;
    this.started = true;
    this.applied.clear();
    this.applySummary = null;
    this.paintRunButton();
    await this.ensureColumn(true);
    this.judgeAll(true);
    this.paintRunButton();
    this.scheduleScan();
  }

  /** `fresh` (a Tackle click) re-judges every item past the caches; otherwise only items not judged yet or failed. */
  private judgeAll(fresh = false): void {
    for (const item of this.items.values()) {
      const slot = this.judged.slots.get(item.restId);
      if (fresh || !slot || slot.state === "error") void this.judged.judge(item, fresh);
    }
  }

  private running(): boolean {
    return [...this.items.keys()].some((id) => this.judged.slots.get(id)?.state === "pending");
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
        this.setPill(message);
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

  /** Same button on a column whose workflow is not in the extension yet: shown so every column reads the same,
   *  but disabled (aria-disabled keeps the tooltip, which a disabled button would not show). */
  private makeIdleButton(col: HTMLElement, name: string): HTMLElement {
    const b = tackleButton(col, () => {});
    b.setAttribute("aria-disabled", "true");
    b.dataset.state = "unavailable";
    b.dataset.tip = `Not implemented yet: ${name} has no workflow in the extension`;
    return b;
  }

  private paintRunButton(b: HTMLElement | null = this.runBtn): void {
    if (!b) return;
    const ids = [...this.items.keys()];
    const slots = ids.map((id) => this.judged.slots.get(id));
    const settled = slots.filter((s) => s && s.state !== "pending").length;
    const errors = slots.filter((s) => s?.state === "error").length;
    let state: string;
    let text: string;
    let title: string;
    if (!this.started) {
      [state, text, title] = [
        "idle",
        "Tackle",
        `Ask Jev for a keep / remove verdict on every item in ${this.column}`,
      ];
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

  /** Every item judged (or Accept under way): Accept and Cancel take Tackle's place in the header. */
  private reviewing(): boolean {
    if (this.applying) return true;
    if (!this.started || this.load.state !== "loaded" || !this.items.size || this.running()) return false;
    // Once Accept has run, Tackle comes back to re-read what is left.
    return this.applied.size === 0;
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
    const keep = plan.filter((p) => p.recommended === "accept").length;
    const remove = plan.length - keep;
    const borderline = [...this.items.keys()].filter(
      (id) => this.judged.slots.get(id)?.state === "done" && !plan.some((p) => p.item.restId === id),
    ).length;
    const failed = [...this.items.keys()].filter((id) => this.judged.slots.get(id)?.state === "error").length;
    const left = [
      borderline && `${borderline} borderline`,
      failed && `${failed} that failed to judge`,
    ].filter(Boolean);
    const settled = [...this.applied.values()].filter((a) => a.state !== "pending").length;
    setText(accept, this.applying ? `${settled}/${this.applied.size}` : "Accept");
    accept.dataset.state = this.applying ? "applying" : "ready";
    accept.setAttribute("aria-disabled", String(this.applying || !plan.length));
    accept.dataset.tip = this.applying
      ? "Applying the recommendations"
      : plan.length
        ? `Apply the recommendation to ${plan.length} item${plan.length === 1 ? "" : "s"}: ` +
          `${keep} keep (/triage accepted + /priority, move to its lane), ${remove} remove (move to Archive-it)` +
          (left.length ? `. ${left.join(" and ")} stay in ${this.column} for you.` : ".")
        : `Nothing to apply: every item needs your call`;
    cancel.setAttribute("aria-disabled", String(this.applying));
    cancel.dataset.tip = this.applying
      ? "Can't cancel while applying"
      : `Discard the verdicts and go back to the board as it was`;
  }

  /** The recommended action for every item with a clear verdict; borderline and failed items are left out. */
  private plan() {
    const fields = this.judged.fields;
    if (!fields) return [];
    const out = [];
    for (const item of this.items.values()) {
      const slot = this.judged.slots.get(item.restId);
      if (slot?.state !== "done") continue;
      const p = proposedActions(item, slot.result, fields);
      if (p.recommended) out.push({ item, recommended: p.recommended, action: p[p.recommended] });
    }
    return out;
  }

  /** Accept: the recommendations in parallel, 8 items at a time like judging. Each item's own steps run in order. */
  private async accept(): Promise<void> {
    if (!this.reviewing() || this.applying) return;
    const plan = this.plan();
    if (!plan.length) return;
    this.applying = true;
    for (const p of plan) this.applied.set(p.item.restId, { state: "pending" });
    this.repaintAll();
    const queue = [...plan];
    const worker = async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        try {
          await send({ type: "item.apply", board: this.board, restId: p.item.restId, steps: p.action.steps });
          this.applied.set(p.item.restId, { state: "done" });
        } catch (e) {
          this.applied.set(p.item.restId, {
            state: "error",
            message: e instanceof Error ? e.message : String(e),
          });
        }
        this.paintBadge(p.item.restId);
        this.paintRunButton();
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, plan.length) }, worker));
    this.applying = false;
    const failed = [...this.applied.values()].filter((a) => a.state === "error").length;
    this.applySummary = `Applied ${this.applied.size - failed}${failed ? `, ${failed} failed` : ""}`;
    this.repaintAll();
  }

  /** Cancel: drop every verdict and our marks on the board; the next Tackle starts over (Jev answers are cached). */
  private cancel(): void {
    if (this.applying) return;
    this.started = false;
    this.judged.slots.clear();
    this.applied.clear();
    this.applySummary = null;
    for (const b of document.querySelectorAll(SEL.badge)) b.remove();
    for (const c of document.querySelectorAll<HTMLElement>("[data-snba-verdict]"))
      delete c.dataset.snbaVerdict;
    document.querySelector(".snba-evidence")?.remove();
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
      // Same as clicking the title: GitHub opens the pane for an issue and a new tab for a PR.
      itemLink(card)?.click();
    });
    for (const ev of ["mousedown", "pointerdown", "keydown"])
      b.addEventListener(ev, (e) => e.stopPropagation());
    placeBadge(card, b);
  }

  private paintBadge(restId: number): void {
    const b = document.querySelector<HTMLElement>(`${SEL.badge}[data-rest-id="${restId}"]`);
    if (!b) return;
    let verdict: string;
    let text: string;
    let title: string;
    const slot = this.judged.slots.get(restId);
    if (!slot || slot.state === "pending") {
      [verdict, text, title] = ["pending", slot ? "judging" : "…", "Asking Jev"];
    } else if (slot.state === "error") {
      [verdict, text, title] = ["error", "error", slot.message];
    } else {
      const v = slot.result.verdict;
      [verdict, text, title] = [
        v,
        v === "BORDERLINE" ? "borderline" : v.toLowerCase(),
        `${slot.result.why}. Open the item for the evidence.`,
      ];
    }
    const applied = this.applied.get(restId);
    if (applied?.state === "pending") [text, title] = ["applying", "Applying the recommendation"];
    else if (applied?.state === "done") [text, title] = ["applied", "Recommendation applied"];
    else if (applied?.state === "error") [verdict, text, title] = ["error", "failed", applied.message];
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
  }

  // ------------------------------------------------------------------ pane
  /** Keeps the evidence section in GitHub's pane in step with the pane's current item and our judging state. */
  private syncPane(): void {
    if (!this.started) return;
    const restId = paneItemId();
    const existing = document.querySelector<HTMLElement>(".snba-evidence");
    if (!restId) {
      existing?.remove();
      return;
    }
    const item = this.items.get(restId);
    if (!item) {
      existing?.remove();
      return; // the pane shows an item from another column
    }
    const side = findSidebar(document);
    if (!side || !side.el.matches(PANE_SIDEBAR)) return;
    const slot = this.judged.slots.get(restId);
    const st: EvidenceState =
      !slot || slot.state === "pending"
        ? { state: "pending" }
        : slot.state === "error"
          ? { state: "error", message: slot.message }
          : { state: "done", result: slot.result, fields: this.judged.fields };
    const key = `${restId}:${st.state}:${this.judged.fields ? 1 : 0}`;
    if (existing?.dataset.snbaKey === key && existing.isConnected && side.el.contains(existing)) return;
    existing?.remove();
    const section = renderEvidence(side.adapter, item, st, { rejudge: (it) => this.judged.judge(it, true) });
    section.dataset.snbaKey = key;
    placeSection(side.el, section);
    if (!slot) void this.judged.judge(item);
  }

  private updatePill(): void {
    if (!this.configured.github || !this.configured.typesafe) {
      this.setPill("Add your tokens to start");
      return;
    }
    const done = [...this.judged.slots.values()].filter((s) => s.state === "done").length;
    const pending = [...this.judged.slots.values()].filter((s) => s.state === "pending").length;
    if (!this.started) {
      this.setPill(`Click Tackle on ${this.column} to start`);
      return;
    }
    if (this.applySummary) {
      this.setPill(this.applySummary);
      return;
    }
    this.setPill(`${done} judged${pending ? `, ${pending} pending` : ""}`);
  }

  private setPill(text: string): void {
    this.pillText.textContent = text;
  }
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
  const column = board?.workflows.triage;
  if (!board || !column) {
    console.info(`[sig-node-board-assistant] ${ref.owner}/${ref.number} has no triage workflow yet; idle.`);
    return;
  }
  void new BoardAssistant(ref, column).start();
}

if (typeof chrome !== "undefined" && chrome.runtime?.id) boot();
