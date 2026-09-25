/** Issue and pull request pages: if this item sits in a judged column of a known board, add the evidence section
 *  to the page's sidebar. PRs never get GitHub's project pane, so this is where their verdict lives. */
import { knownBoard } from "../core/boards";
import type { Placement } from "../core/lookup";
import type { BoardItem } from "../core/types";
import { send } from "../shared/messages";
import { findSidebar, placeSection } from "../content/adapters";
import { Judged } from "../content/judged";
import { isOurs } from "../content/dom";
import { WORKFLOWS, type ColumnWorkflow, type PaneState } from "../content/workflows";

/** The workflow of the column the item sits in. */
function workflowFor(p: Placement): ColumnWorkflow<unknown> | null {
  const name = Object.entries(knownBoard(p.board)?.workflows ?? {}).find(([, col]) => col === p.column)?.[0];
  return (name && WORKFLOWS[name]) || null;
}

export function itemFromUrl(url: string): { repo: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)(?:[/?#]|$)/.exec(url);
  return m ? { repo: m[1]!, number: Number(m[2]) } : null;
}

class ItemAssistant {
  private judged: Judged<unknown> | null = null;
  private wf: ColumnWorkflow<unknown> | null = null;
  private placement: Placement | null = null;
  /** "repo#number" of the item the page currently shows; hash and tab changes keep it the same. */
  private current = "";
  private generation = 0;
  private timer: number | null = null;

  start(): void {
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
        const wf = workflowFor(placement);
        if (!wf) return;
        this.placement = placement;
        this.wf = wf;
        this.judged = new Judged<unknown>(1, wf.judge);
        this.judged.onChange(() => this.sync());
        await this.judged.loadFields(placement.board);
        if (!live()) return;
        void this.judgeOne(placement.item);
      } catch (e) {
        if (live() && this.placement)
          this.judged?.fail(this.placement.item.restId, e instanceof Error ? e.message : String(e));
        return;
      }
    }
    this.sync();
  }

  /** Judges the item, then runs its workflow's pass over it (To do: the duplicate check), as the board does. */
  private async judgeOne(item: BoardItem, refresh = false): Promise<void> {
    const { judged, wf, placement } = this;
    if (!judged || !wf || !placement) return;
    await judged.judge(item, refresh);
    const slot = judged.slots.get(item.restId);
    if (!wf.afterJudge || slot?.state !== "done") return;
    try {
      const changed = await wf.afterJudge(placement.board, [item], new Map([[item.restId, slot.result]]));
      const r = changed.get(item.restId);
      // Only if nothing re-judged the item meanwhile.
      if (r !== undefined && judged.slots.get(item.restId) === slot) judged.update(item.restId, r);
    } catch {
      // The verdict stands without the duplicate check; the board's pass reports its failures.
    }
  }

  private sync(): void {
    const { placement, judged, wf } = this;
    if (!placement || !judged || !wf) return;
    const side = findSidebar(document);
    if (!side) return;
    const item = placement.item;
    const slot = judged.slots.get(item.restId);
    const st: PaneState<unknown> =
      !slot || slot.state === "pending"
        ? { state: "pending" }
        : slot.state === "error"
          ? { state: "error", message: slot.message }
          : { state: "done", result: slot.result, fields: judged.fields };
    const key = `${item.restId}:${st.state}:${judged.fields ? 1 : 0}`;
    const existing = document.querySelector<HTMLElement>(".snba-evidence");
    if (existing?.dataset.snbaKey === key && side.el.contains(existing)) return;
    existing?.remove();
    const section = wf.pane(side.adapter, item, st, (it) => this.judgeOne(it, true));
    section.dataset.snbaKey = key;
    placeSection(side.el, section);
  }
}

if (typeof chrome !== "undefined" && chrome.runtime?.id) new ItemAssistant().start();
