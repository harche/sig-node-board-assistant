/** Content script for testgrid.k8s.io: on a dashboard's summary, a Tackle button judges every FAILING and FLAKY
 *  periodic tab (presubmits, `pull-*`, are left out: they fail as authors iterate), badges each with its verdict,
 *  and Accept applies the suggestions Accept may apply. Reads TestGrid, GCS and GitHub; writes only through the
 *  background worker, which in test mode sends them to the test repo (tgreview.ts, TG_TEST_REPO). */
import { HoverCard, type Applied } from "../content/hovercard";
import { h } from "../content/ui";
import { decideTg, TG_TINT, verdict, type TgResult } from "../core/tgreview";
import { send } from "../shared/messages";
import { chosenTg, chosenTgSteps, renderTgHoverCard, type TgOverrides } from "./card";

type Slot = { state: "pending" } | { state: "error"; message: string } | { state: "done"; result: TgResult };

const BADGE: Record<string, string> = { keep: "tracked", comment: "comment", file: "file issue" };
/** Jobs judged at once. Search is one batched GraphQL request per job, so GCS reads and Jev set the pace. */
const PARALLEL = 6;

class TestGridReview {
  private dashboard = decodeURIComponent(location.pathname.split("/")[1] ?? "");
  /** Tabs by a small numeric id: HoverCard keys cards by number. */
  private ids = new Map<string, number>();
  private tabs: { tab: string; status: "FAILING" | "FLAKY" }[] = [];
  private slots = new Map<number, Slot>();
  private overrides = new Map<number, TgOverrides>();
  private applied = new Map<number, Applied>();
  private skipped = new Set<number>();
  private applying = false;
  private configured = { github: false, typesafe: false };
  private testMode = true;
  private hover = new HoverCard(
    (id) => this.render(id),
    (id) => this.key(id),
  );
  private bar: HTMLElement | null = null;
  private runBtn = h("button", { type: "button" }, "Tackle") as HTMLButtonElement;
  private acceptBtn = h("button", { type: "button" }, "Accept") as HTMLButtonElement;
  private status = h("span.snba-tg-status");

  async start(): Promise<void> {
    if (!this.dashboard) return;
    // Our styles take TestGrid's look on this page (content.css, html.snba-tg).
    document.documentElement.classList.add("snba-tg");
    const s = await send({ type: "settings.get" });
    this.configured = s.configured;
    this.testMode = s.settings.testMode;
    // The toggle can change while this page is open; the worker checks it on every write, the card's wording follows.
    chrome.storage.onChanged.addListener((ch) => {
      const next = (ch.settings?.newValue as { testMode?: boolean } | undefined)?.testMode;
      if (next !== undefined) this.testMode = next;
    });
    this.runBtn.addEventListener("click", () => void this.run());
    this.acceptBtn.addEventListener("click", () => void this.accept());
    this.acceptBtn.hidden = true;
    let timer: number | null = null;
    new MutationObserver((ms) => {
      if (ms.every((m) => (m.target as Element).closest?.(".snba-tg-bar, .snba-badge, .snba-hovercard")))
        return;
      if (timer === null) timer = window.setTimeout(() => ((timer = null), this.scan()), 200);
    }).observe(document.body, { childList: true, subtree: true });
    this.scan();
  }

  /** The summary's failing and flaky periodic tabs, as TestGrid drew them. */
  private rows(): { el: HTMLElement; tab: string; status: "FAILING" | "FLAKY" }[] {
    return [...document.querySelectorAll<HTMLElement>("div.test-grid-tab-summary")].flatMap((el) => {
      const left = el.querySelector(".test-grid-tab-summary-left");
      const status = left?.classList.contains("FAILING")
        ? "FAILING"
        : left?.classList.contains("FLAKY")
          ? "FLAKY"
          : null;
      const tab = el.id;
      return status && tab && !tab.startsWith("pull-") ? [{ el, tab, status }] : [];
    });
  }

  private scan(): void {
    const rows = this.rows();
    if (!rows.length) return;
    if (!this.bar?.isConnected) {
      const anchor = [...document.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Show All Alerts",
      );
      this.bar = h("span.snba-tg-bar", {}, this.runBtn, this.acceptBtn, this.status);
      if (anchor?.parentElement) anchor.parentElement.insertBefore(this.bar, anchor);
      else document.querySelector("#dashboard-summary-canvas")?.prepend(this.bar);
    }
    this.tabs = rows.map(({ tab, status }) => ({ tab, status }));
    for (const r of rows) {
      const id = this.idOf(r.tab);
      let b = r.el.querySelector<HTMLElement>(".snba-badge");
      if (!b) {
        b = h(
          "button.snba-badge",
          { type: "button", "data-rest-id": String(id) },
          h("span.snba-dot"),
          h("span.snba-text"),
        );
        b.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const s = this.slots.get(id);
          if (!s || s.state === "error") void this.judge(r.tab, r.status, true);
        });
        b.addEventListener("mouseenter", () => this.hover.hoverStart(id, b!));
        b.addEventListener("mouseleave", () => this.hover.hoverEnd());
        b.addEventListener("focus", () => this.hover.hoverStart(id, b!, 0));
        r.el.querySelector(".tab-name")?.append(b);
      }
      this.paint(id);
    }
    this.paintBar();
  }

  private idOf(tab: string): number {
    let id = this.ids.get(tab);
    if (!id) this.ids.set(tab, (id = this.ids.size + 1));
    return id;
  }

  private tabOf(id: number): { tab: string; status: "FAILING" | "FLAKY" } | undefined {
    return this.tabs.find((t) => this.ids.get(t.tab) === id);
  }

  private async run(): Promise<void> {
    if (!this.configured.github || !this.configured.typesafe) {
      void send({ type: "options.open" });
      return;
    }
    if (this.applying || [...this.slots.values()].some((s) => s.state === "pending")) return;
    this.slots.clear();
    this.overrides.clear();
    this.applied.clear();
    this.skipped.clear();
    this.hover.close();
    const queue = [...this.tabs];
    const worker = async () => {
      for (let t = queue.shift(); t; t = queue.shift()) await this.judge(t.tab, t.status, true);
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
  }

  private async judge(tab: string, status: "FAILING" | "FLAKY", refresh: boolean): Promise<void> {
    const id = this.idOf(tab);
    this.skipped.delete(id);
    this.slots.set(id, { state: "pending" });
    this.paint(id);
    this.paintBar();
    try {
      const result = await send({
        type: "tg.judge",
        ref: { dashboard: this.dashboard, tab },
        status,
        refresh,
      });
      this.slots.set(id, { state: "done", result });
    } catch (e) {
      this.slots.set(id, { state: "error", message: e instanceof Error ? e.message : String(e) });
    }
    this.paint(id);
    this.paintBar();
    this.hover.refresh(id);
  }

  /** What Accept would apply: judged tabs whose action Accept may take (or the reviewer picked), with writes. */
  private plan(): { id: number; result: TgResult }[] {
    return [...this.slots].flatMap(([id, s]) => {
      if (s.state !== "done" || this.skipped.has(id) || this.applied.get(id)?.state === "done") return [];
      const o = this.overrides.get(id) ?? {};
      if (!o.action && !decideTg(s.result).auto) return [];
      return chosenTgSteps(s.result, o).length ? [{ id, result: s.result }] : [];
    });
  }

  private async accept(): Promise<void> {
    const plan = this.plan();
    if (this.applying || !plan.length) return;
    this.applying = true;
    this.paintBar();
    for (const p of plan) await this.apply(p.id);
    this.applying = false;
    this.paintBar();
  }

  private async apply(id: number): Promise<void> {
    const s = this.slots.get(id);
    if (s?.state !== "done" || this.applied.get(id)?.state === "pending") return;
    const steps = chosenTgSteps(s.result, this.overrides.get(id) ?? {});
    if (!steps.length) return;
    this.applied.set(id, { state: "pending" });
    this.paint(id);
    this.hover.refresh(id);
    try {
      const r = await send({ type: "tg.apply", steps });
      this.applied.set(id, { state: "done" });
      this.status.textContent = `wrote ${r.wrote.join(", ")}`;
    } catch (e) {
      this.applied.set(id, { state: "error", message: e instanceof Error ? e.message : String(e) });
    }
    this.paint(id);
    this.hover.refresh(id);
  }

  private paint(id: number): void {
    const b = document.querySelector<HTMLElement>(`.snba-badge[data-rest-id="${id}"]`);
    if (!b) return;
    const s = this.slots.get(id);
    let [tint, text, title] = ["idle", "Tackle", "Judge this job with Jev"];
    if (s?.state === "pending")
      [tint, text, title] = ["pending", "judging", "Reading the runs and asking Jev"];
    else if (s?.state === "error")
      [tint, text, title] = ["error", "error", `${s.message}. Click to try again.`];
    else if (s?.state === "done") {
      const o = this.overrides.get(id) ?? {};
      const a = chosenTg(s.result, o);
      const unsure = !o.action && !decideTg(s.result).auto;
      const v = verdict(s.result);
      const word =
        a === "keep" && v.verdict !== "tracked"
          ? "watch"
          : a === "keep" && v.issue
            ? `#${v.issue.number}`
            : BADGE[a]!;
      [tint, text, title] = [unsure ? "BORDERLINE" : TG_TINT[a], unsure ? `${word}?` : word, ""];
    }
    const ap = this.applied.get(id);
    if (ap?.state === "pending") text = "applying";
    else if (ap?.state === "done") text = "applied";
    else if (ap?.state === "error") [tint, text] = ["error", "failed"];
    if (this.skipped.has(id)) [tint, text] = ["idle", "Tackle"];
    b.dataset.verdict = tint;
    b.querySelector(".snba-text")!.textContent = text;
    b.title = title;
  }

  private paintBar(): void {
    const all = this.tabs.map((t) => this.slots.get(this.idOf(t.tab)));
    const pending = all.filter((s) => s?.state === "pending").length;
    const done = all.filter((s) => s?.state === "done").length;
    this.runBtn.disabled = pending > 0 || this.applying;
    this.runBtn.textContent = pending ? `${done}/${this.tabs.length}` : done ? "Tackle again" : "Tackle";
    this.runBtn.title = `Judge the ${this.tabs.length} failing and flaky periodic jobs on ${this.dashboard}`;
    const plan = this.plan();
    this.acceptBtn.hidden = !done || pending > 0;
    this.acceptBtn.disabled = this.applying || !plan.length;
    this.acceptBtn.title = plan.length
      ? `Apply the suggestion to ${plan.length} job${plan.length === 1 ? "" : "s"}`
      : "Nothing to apply";
    if (!this.applying && !this.status.textContent?.startsWith("wrote"))
      this.status.textContent = done ? `${done} judged` : "";
  }

  private key(id: number): string {
    const s = this.slots.get(id);
    return [
      s?.state,
      s?.state === "done" ? decideTg(s.result).action : "",
      this.applied.get(id)?.state,
      this.applying,
      JSON.stringify(this.overrides.get(id) ?? {}),
    ].join("|");
  }

  private render(id: number): HTMLElement | null {
    const s = this.slots.get(id);
    if (s?.state !== "done" || this.skipped.has(id)) return null;
    return renderTgHoverCard({
      result: s.result,
      overrides: this.overrides.get(id) ?? {},
      setOverride: (k, v) => {
        const o = { ...(this.overrides.get(id) ?? {}), [k]: v };
        const d = decideTg(s.result);
        if (k === "action" && v === d.action && d.auto) delete o.action;
        this.overrides.set(id, o);
        this.paint(id);
        this.paintBar();
        this.hover.refresh(id);
      },
      applied: this.applied.get(id),
      canApply: !this.applying,
      testMode: this.testMode,
      scope: document,
      apply: () => void this.apply(id).then(() => this.paintBar()),
      skip: () => {
        this.skipped.add(id);
        this.slots.delete(id);
        this.hover.close();
        this.paint(id);
        this.paintBar();
      },
    });
  }
}

if (typeof chrome !== "undefined" && chrome.runtime?.id) void new TestGridReview().start();
