/** Issue and pull request pages: if this item sits in a judged column of a known board, add the evidence section
 *  to the page's sidebar. PRs never get GitHub's project pane, so this is where their verdict lives. Nothing asks
 *  Jev until the reader clicks: each section first offers its check with a button. Once judged, an "Apply" section
 *  holds the column's hover card (its picks and Apply), writing through the board's item.apply. */
import { knownBoard } from "../core/boards";
import type { Placement } from "../core/lookup";
import type { ActionStep, BoardItem } from "../core/types";
import { send } from "../shared/messages";
import { FLOAT_AFTER_MS, itemSidebar, onConversationTab, placeSection } from "../content/adapters";
import { SECTION_TITLE } from "../content/evidence";
import { h, linkifyTree } from "../content/ui";
import { runButton } from "./button";
import { Judged } from "../content/judged";
import { isOurs } from "../content/dom";
import {
  prowFixesNote,
  withFixes,
  WORKFLOWS,
  type ColumnWorkflow,
  type Overrides,
  type PaneState,
} from "../content/workflows";
import type { Applied } from "../content/hovercard";
import { PrCi } from "./ci";
import { IssueCheck } from "./issue";
import { boardFeedback } from "../content/feedback";

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
  /** The reader's picks on the Apply section and its write, both dropped by Judge again. */
  private overrides: Overrides = {};
  private applied: Applied | undefined;
  private ci: PrCi | IssueCheck | null = null;
  /** "repo#number" of the item the page currently shows; hash and tab changes keep it the same. */
  private current = "";
  private generation = 0;
  private timer: number | null = null;
  private recheckTimer: number | null = null;

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
      this.overrides = {};
      this.applied = undefined;
      this.ci = null;
      document.querySelector(".snba-evidence")?.remove();
      document.querySelector(".snba-act")?.remove();
      document.querySelectorAll(".snba-ci").forEach((e) => e.remove());
      document.getElementById("snba-float")?.remove();
      if (!ref) return;
      // Ticks for different items can overlap (fast navigation, a slow lookup): only the latest one may publish.
      const gen = ++this.generation;
      const live = () => gen === this.generation;
      try {
        const s = await send({ type: "settings.get" });
        if (!live() || !s.configured.github || !s.configured.jev) return;
        this.ci = ref.pull
          ? new PrCi(ref.repo, ref.number, live)
          : new IssueCheck(ref.repo, ref.number, live, {
              // The related-issues comment and Apply write to the same issue: one at a time, as on the board.
              blocked: () => (this.applied?.state === "pending" ? "Waiting for its Apply to finish." : null),
              changed: () => this.schedule(),
            });
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
  private async judgeOne(item: BoardItem): Promise<void> {
    const { judged, wf, placement } = this;
    if (!judged || !wf || !placement || this.applied?.state === "pending") return;
    this.overrides = {};
    this.applied = undefined;
    await judged.judge(item);
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

  /** While the sidebar is missing, look again once the floating fallback is due: the page may not mutate by then. */
  private recheck(): void {
    if (this.recheckTimer !== null) return;
    this.recheckTimer = window.setTimeout(() => {
      this.recheckTimer = null;
      this.schedule();
    }, FLOAT_AFTER_MS + 100);
  }

  /** The related-issues comment is being posted on this issue: Apply waits for it. */
  private commenting(): boolean {
    return this.ci instanceof IssueCheck && this.ci.commenting();
  }

  private sync(): void {
    const { placement, judged, wf } = this;
    const mine = Boolean(placement && judged && wf);
    // Looked up once, and only with something to show: a missing sidebar may become the floating panel.
    const wanted = mine || Boolean(this.ci?.hasContent());
    const side = wanted ? itemSidebar(document) : null;
    if (wanted && !side && onConversationTab()) this.recheck();
    this.ci?.sync(side);
    if (!placement || !judged || !wf || !side) return;
    const item = placement.item;
    if (!this.requested) {
      document.querySelector(".snba-act")?.remove();
      return this.offer(side, placement);
    }
    const slot = judged.slots.get(item.restId);
    const st: PaneState<unknown> =
      !slot || slot.state === "pending"
        ? { state: "pending" }
        : slot.state === "error"
          ? { state: "error", message: slot.message }
          : { state: "done", result: slot.result, fields: judged.fields };
    // The result's own key too: the To do duplicate pass replaces a done result.
    const key = `${item.restId}:${st.state}:${judged.fields ? 1 : 0}:${st.state === "done" ? wf.hoverKey(st.result) : ""}`;
    const existing = document.querySelector<HTMLElement>(".snba-evidence");
    if (existing?.dataset.snbaKey === key && side.el.contains(existing)) return this.act(side, item);
    existing?.remove();
    const section = wf.pane(side.adapter, item, st, (it) => this.judgeOne(it));
    if (st.state === "done")
      section.append(
        boardFeedback({
          board: placement.board,
          column: placement.column,
          item,
          result: st.result,
          fields: judged.fields,
          where: "Item page",
          card: () => section,
        }),
      );
    section.dataset.snbaKey = key;
    placeSection(side.el, linkifyTree(section, item.repository));
    this.act(side, item);
  }

  /** The Apply section, above the evidence once the verdict and the board's fields are in: the column's hover card
   *  without what the evidence already shows (verdict, readings, facts), so only its picks and buttons remain. */
  private act(side: NonNullable<ReturnType<typeof itemSidebar>>, item: BoardItem): void {
    const { judged, wf } = this;
    const slot = judged?.slots.get(item.restId);
    const existing = document.querySelector<HTMLElement>(".snba-act");
    const evidence = document.querySelector<HTMLElement>(".snba-evidence");
    if (!judged || !wf || slot?.state !== "done" || !judged.fields || !evidence) return existing?.remove();
    const result = slot.result;
    const busy = this.commenting();
    const key = `${item.restId}:${wf.hoverKey(result)}:${JSON.stringify(this.overrides)}:${JSON.stringify(this.applied ?? null)}:${busy}`;
    if (existing?.dataset.snbaKey === key && existing.nextElementSibling === evidence) return;
    existing?.remove();
    const { root, body } = side.adapter.section("Apply");
    root.classList.add("snba-act");
    root.dataset.snbaKey = key;
    const card = wf.hover({
      fix: (steps) => withFixes(item, result as { prow_fixes?: { fix: string }[] }, steps),
      item,
      result,
      overrides: this.overrides,
      setOverride: (k, v) => {
        if (this.applied?.state === "pending" || this.applied?.state === "done") return;
        this.overrides = wf.override(result, this.overrides, k, v);
        this.sync();
      },
      fields: judged.fields,
      applied: this.applied,
      canApply: !busy,
      // GitHub's Primer buttons are in the page header, not in the sidebar.
      scope: document,
      apply: (choice) => void this.apply(item, choice),
    });
    for (const el of [...card.children])
      if (!el.matches(".snba-hc-actions") && !el.querySelector("select")) el.remove();
    // Apply posts the Prow fixes with the action: say so, as the board's hover card does.
    const note = prowFixesNote(result);
    if (note) card.querySelector(".snba-hc-actions")?.before(note);
    body.append(card);
    evidence.before(linkifyTree(root, item.repository));
  }

  /** Apply on the item page: the hover card's write, through the same guarded item.apply as the board. */
  private async apply(item: BoardItem, choice: string): Promise<void> {
    const { judged, wf, placement } = this;
    const slot = judged?.slots.get(item.restId);
    const state = this.applied?.state;
    if (
      !judged?.fields ||
      !wf ||
      !placement ||
      slot?.state !== "done" ||
      state === "pending" ||
      state === "done" ||
      this.commenting()
    )
      return;
    const own = wf.steps(item, slot.result, judged.fields, this.overrides, choice);
    if (!own) return;
    const steps: ActionStep[] = withFixes(item, slot.result as { prow_fixes?: { fix: string }[] }, own);
    if (!steps.length) return;
    const current = this.current;
    this.applied = { state: "pending" };
    this.refreshComment();
    this.sync();
    let applied: Applied;
    try {
      await send({ type: "item.apply", board: placement.board, restId: item.restId, steps });
      applied = { state: "done" };
    } catch (e) {
      applied = { state: "error", message: e instanceof Error ? e.message : String(e) };
    }
    if (current !== this.current) return;
    this.applied = applied;
    this.refreshComment();
    this.sync();
  }

  /** Comment's wait follows Apply: redraw the issue's sections when Apply starts or ends. */
  private refreshComment(): void {
    if (this.ci instanceof IssueCheck) this.ci.refresh();
  }

  /** Before the reader asks: the section names the column and offers the verdict. */
  private offer(side: NonNullable<ReturnType<typeof itemSidebar>>, placement: Placement): void {
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
