/** Board page: one badge per card in the judged column, and the evidence section inside GitHub's own item pane
 *  when it opens for one of those cards. Everything is read: fetching and judging happen in the background
 *  worker, and nothing here writes to GitHub. */
import { boardFromUrl, knownBoard } from "../core/boards";
import type { BoardItem, BoardRef } from "../core/types";
import { send } from "../shared/messages";
import { findSidebar, PANE_SIDEBAR, placeSection } from "./adapters";
import { cardsIn, isOurs, itemLink, paneItemId, placeBadge, SEL } from "./dom";
import { renderEvidence, type EvidenceState } from "./evidence";
import { Judged } from "./judged";
import { h } from "./ui";

class BoardAssistant {
  private items = new Map<number, BoardItem>();
  private judged = new Judged();
  private pill: HTMLElement;
  private pillText: HTMLElement;
  private configured = { github: false, typesafe: false };
  private columnLoad: Promise<void> | null = null;
  private refreshedOnce = false;
  private scanTimer: number | null = null;

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
    const cards = cardsIn(document, this.column);
    for (const c of cards) {
      if (!c.el.querySelector(SEL.badge)) this.mountBadge(c.el, c.restId);
      this.paintBadge(c.restId);
    }
    if (!this.configured.github || !this.configured.typesafe) return;
    if (cards.length || paneItemId()) await this.ensureColumn();
    const missing = cards.filter((c) => !this.items.has(c.restId));
    if (missing.length && !this.refreshedOnce) {
      this.refreshedOnce = true; // a card the 10-minute column cache does not know: refresh once, then accept staleness
      await this.ensureColumn(true);
    }
    for (const c of cards) {
      const item = this.items.get(c.restId);
      if (item && !this.judged.slots.has(c.restId)) void this.judged.judge(item);
    }
    this.syncPane();
  }

  private ensureColumn(refresh = false): Promise<void> {
    if (this.columnLoad && !refresh) return this.columnLoad;
    this.columnLoad = (async () => {
      try {
        const [items] = await Promise.all([
          send({ type: "column.items", board: this.board, column: this.column, refresh }),
          this.judged.loadFields(this.board),
        ]);
        this.items = new Map(items.map((i) => [i.restId, i]));
      } catch (e) {
        this.setPill(e instanceof Error ? e.message : String(e));
      }
    })();
    return this.columnLoad;
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
    if (!this.configured.github || !this.configured.typesafe) {
      [verdict, text, title] = [
        "unconfigured",
        "set up",
        "SIG Node Board Assistant: add your tokens in the extension options",
      ];
    } else if (!slot || slot.state === "pending") {
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
    // Only touch the DOM when something changed: every write here is a mutation other observers see.
    if (b.dataset.verdict !== verdict) b.dataset.verdict = verdict;
    const t = b.querySelector<HTMLElement>(".snba-text")!;
    if (t.textContent !== text) t.textContent = text;
    if (b.title !== title) b.title = title;
  }

  // ------------------------------------------------------------------ pane
  /** Keeps the evidence section in GitHub's pane in step with the pane's current item and our judging state. */
  private syncPane(): void {
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
    this.setPill(`Read-only. ${done} judged${pending ? `, ${pending} pending` : ""}`);
  }

  private setPill(text: string): void {
    this.pillText.textContent = text;
  }
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
