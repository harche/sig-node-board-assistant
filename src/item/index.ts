/** Issue and pull request pages: if this item sits in a judged column of a known board, add the evidence section
 *  to the page's sidebar. PRs never get GitHub's project pane, so this is where their verdict lives. */
import type { Placement } from "../core/lookup";
import { send } from "../shared/messages";
import { findSidebar, placeSection } from "../content/adapters";
import { renderEvidence, type EvidenceState } from "../content/evidence";
import { Judged } from "../content/judged";
import { isOurs } from "../content/dom";

export function itemFromUrl(url: string): { repo: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)(?:[/?#]|$)/.exec(url);
  return m ? { repo: m[1]!, number: Number(m[2]) } : null;
}

class ItemAssistant {
  private judged = new Judged(1);
  private placement: Placement | null = null;
  /** "repo#number" of the item the page currently shows; hash and tab changes keep it the same. */
  private current = "";
  private generation = 0;
  private timer: number | null = null;

  start(): void {
    this.judged.onChange(() => this.sync());
    new MutationObserver((muts) => {
      if (muts.some((m) => !isOurs(m.target))) this.schedule();
    }).observe(document.body, { childList: true, subtree: true });
    document.addEventListener("turbo:load", () => this.schedule());
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, 200);
  }

  private async tick(): Promise<void> {
    const ref = itemFromUrl(location.href);
    const key = ref ? `${ref.repo}#${ref.number}` : "";
    if (key !== this.current) {
      this.current = key;
      this.placement = null;
      document.querySelector(".snba-evidence")?.remove();
      if (!ref) return;
      // Ticks for different items can overlap (fast navigation, a slow lookup): only the latest one may publish.
      const gen = ++this.generation;
      const live = () => gen === this.generation;
      try {
        const s = await send({ type: "settings.get" });
        if (!live() || !s.configured.github || !s.configured.typesafe) return;
        const placement = await send({ type: "item.lookup", repo: ref.repo, number: ref.number });
        if (!live() || !placement) return;
        this.placement = placement;
        await this.judged.loadFields(placement.board);
        if (!live()) return;
        void this.judged.judge(placement.item);
      } catch (e) {
        if (live() && this.placement)
          this.judged.fail(this.placement.item.restId, e instanceof Error ? e.message : String(e));
        return;
      }
    }
    this.sync();
  }

  private sync(): void {
    if (!this.placement) return;
    const side = findSidebar(document);
    if (!side) return;
    const item = this.placement.item;
    const slot = this.judged.slots.get(item.restId);
    const st: EvidenceState =
      !slot || slot.state === "pending"
        ? { state: "pending" }
        : slot.state === "error"
          ? { state: "error", message: slot.message }
          : { state: "done", result: slot.result, fields: this.judged.fields };
    const key = `${item.restId}:${st.state}:${this.judged.fields ? 1 : 0}`;
    const existing = document.querySelector<HTMLElement>(".snba-evidence");
    if (existing?.dataset.snbaKey === key && side.el.contains(existing)) return;
    existing?.remove();
    const section = renderEvidence(side.adapter, item, st, { rejudge: (it) => this.judged.judge(it, true) });
    section.dataset.snbaKey = key;
    placeSection(side.el, section);
  }
}

if (typeof chrome !== "undefined" && chrome.runtime?.id) new ItemAssistant().start();
