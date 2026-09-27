/** Issue and pull request pages: if this item sits in a judged column of a known board, add the evidence section
 *  to the page's sidebar. PRs never get GitHub's project pane, so this is where their verdict lives. Nothing asks
 *  Jev until the reader clicks: each section first offers its check with a button. */
import { knownBoard } from "../core/boards";
import type { Placement } from "../core/lookup";
import type { BoardItem } from "../core/types";
import { send } from "../shared/messages";
import { findSidebar, placeSection } from "../content/adapters";
import { SECTION_TITLE } from "../content/evidence";
import { h } from "../content/ui";
import { runButton } from "./button";
import { Judged } from "../content/judged";
import { isOurs } from "../content/dom";
import { WORKFLOWS, type ColumnWorkflow, type PaneState } from "../content/workflows";
import { PrCi } from "./ci";
import { IssueCheck } from "./issue";

/** The workflow of the column the item sits in. */
function workflowFor(p: Placement): ColumnWorkflow<unknown> | null {
  const name = Object.entries(knownBoard(p.board)?.workflows ?? {}).find(([, col]) => col === p.column)?.[0];
  return (name && WORKFLOWS[name]) || null;
}

export function itemFromUrl(url: string): { repo: string; number: number; pull: boolean } | null {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(pull|issues)\/(\d+)(?:[/?#]|$)/.exec(url);
  return m ? { repo: m[1]!, number: Number(m[3]), pull: m[2] === "pull" } : null;
}

class ItemAssistant {
  private judged: Judged<unknown> | null = null;
  private wf: ColumnWorkflow<unknown> | null = null;
  private placement: Placement | null = null;
  /** Whether the reader asked for the board verdict on this item. */
  private requested = false;
  private ci: PrCi | IssueCheck | null = null;
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
      this.requested = false;
      this.ci = null;
      document.querySelector(".snba-evidence")?.remove();
      document.querySelectorAll(".snba-ci").forEach((e) => e.remove());
      if (!ref) return;
      // Ticks for different items can overlap (fast navigation, a slow lookup): only the latest one may publish.
      const gen = ++this.generation;
      const live = () => gen === this.generation;
      try {
        const s = await send({ type: "settings.get" });
        if (!live() || !s.configured.github || !s.configured.jev) return;
        this.ci = ref.pull
          ? new PrCi(ref.repo, ref.number, live)
          : new IssueCheck(ref.repo, ref.number, live);
        // Only what decides whether to offer the check (the PR's failed jobs, the issue's scope): Jev runs on a click.
        void this.ci.prepare();
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
    this.ci?.sync();
    const { placement, judged, wf } = this;
    if (!placement || !judged || !wf) return;
    const side = findSidebar(document);
    if (!side) return;
    const item = placement.item;
    if (!this.requested) return this.offer(side, placement);
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

  /** Before the reader asks: the section names the column and offers the verdict. */
  private offer(side: NonNullable<ReturnType<typeof findSidebar>>, placement: Placement): void {
    const key = `${placement.item.restId}:offer`;
    const existing = document.querySelector<HTMLElement>(".snba-evidence");
    if (existing?.dataset.snbaKey === key && side.el.contains(existing)) return;
    existing?.remove();
    const { root, body } = side.adapter.section(SECTION_TITLE);
    root.classList.add("snba-evidence");
    root.dataset.snbaKey = key;
    body.append(
      h(
        "p.snba-muted",
        {},
        `In ${placement.column} on ${knownBoard(placement.board)?.title ?? "the board"}.`,
      ),
      h(
        "div.snba-ci-start",
        {},
        runButton("Judge", "Read the thread and ask Jev what this column's workflow would do with it", () => {
          this.requested = true;
          this.sync();
          void this.judgeOne(placement.item);
        }),
      ),
    );
    placeSection(side.el, root);
  }
}

if (typeof chrome !== "undefined" && chrome.runtime?.id) new ItemAssistant().start();
