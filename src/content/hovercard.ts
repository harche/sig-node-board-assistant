/** The board's hover card: hovering a card's verdict badge shows Jev's scores for that item and buttons to apply
 *  either action to that one item. It floats beside the card (right, or left when there is no room) so the board
 *  never reflows under the pointer; it looks like GitHub's own hovercards. The full evidence stays in GitHub's pane. */
import { f2, OWNER_OTHER_AT, tieBreak } from "../core/policy";
import { proposedActions } from "../core/triage";
import type { BoardFields, BoardItem, ProposedAction, TriageResult } from "../core/types";
import { nativeButton } from "./adapters";
import { decision } from "./evidence";
import { h } from "./ui";

export type Applied = { state: "pending" | "done" } | { state: "error"; message: string };

export interface HoverContent {
  item: BoardItem;
  result: TriageResult;
  fields: BoardFields | null;
  applied: Applied | undefined;
  /** False while the header's Accept is running: single-item buttons wait for it. */
  canApply: boolean;
  /** Skipped, as the CLI's `s`: the header's Accept leaves it alone. Its own buttons still work. */
  skipped: boolean;
  /** Where GitHub's button classes are borrowed from (the column). */
  scope: ParentNode;
  apply(choice: "accept" | "reject"): void;
  toggleSkip(): void;
}

export function renderHoverCard(c: HoverContent): HTMLElement {
  const { result: r } = c;
  const a = r.answers;
  const { ci } = tieBreak(a);
  const node = a.owner.probabilities.node ?? 0;
  const other = a.owner.probabilities.other ?? 0;
  const body = h(
    "div.snba-hc-body",
    {},
    h("div.snba-hc-title", {}, h("span.snba-muted", {}, `${r.repo}#${r.number} `), r.title),
    decision(r),
    h(
      "dl.snba-hc-scores",
      {},
      ...score("In scope", a.in_scope.noul),
      ...score("CI or test work", ci),
      ...score("SIG Node owns it", node),
      ...score("Another SIG owns it", other, other >= OWNER_OTHER_AT),
      h("dt", {}, "Priority"),
      h("dd.snba-hc-text", {}, r.priority, h("span.snba-muted", {}, ` · ${r.priority_why}`)),
    ),
  );
  body.append(actions(c));
  return body;
}

function score(label: string, p: number, warn = false): HTMLElement[] {
  return [
    h("dt", {}, label),
    h(
      "dd",
      {},
      h(
        "span.snba-hc-meter",
        { "aria-hidden": "true" },
        h("span", { style: `width:${Math.round(p * 100)}%` }),
      ),
      h(`span.snba-hc-num${warn ? ".snba-error" : ""}`, {}, f2(p)),
    ),
  ];
}

function actions(c: HoverContent): HTMLElement {
  const box = h("div.snba-hc-actions");
  if (c.applied?.state === "done") {
    box.append(h("p.snba-hc-status", {}, "Applied."));
    return box;
  }
  if (!c.fields) {
    box.append(h("p.snba-muted", {}, "Board fields are still loading."));
    return box;
  }
  const { accept, reject, recommended } = proposedActions(c.item, c.result, c.fields);
  const busy = c.applied?.state === "pending" || !c.canApply;
  const row = h("div.snba-hc-buttons");
  const lines = h("ul.snba-hc-steps");
  // Recommended first, as GitHub's primary button; borderline has none, so both are plain.
  const order: ["accept" | "reject", ProposedAction][] =
    recommended === "reject"
      ? [
          ["reject", reject],
          ["accept", accept],
        ]
      : [
          ["accept", accept],
          ["reject", reject],
        ];
  for (const [choice, action] of order) {
    const name = choice === "accept" ? "Accept" : "Archive";
    const { root } = nativeButton(c.scope, null, name, choice === recommended ? "primary" : "default");
    root.classList.add("snba-hc-btn");
    if (busy) root.setAttribute("aria-disabled", "true");
    root.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (root.getAttribute("aria-disabled") !== "true") c.apply(choice);
    });
    row.append(root);
    lines.append(h("li", {}, h("b", {}, name), h("span.snba-muted", {}, `: ${describe(action)}`)));
  }
  // Skip, as in the CLI: no write, and the header's Accept passes over it. Clicking again takes it back.
  const skip = nativeButton(c.scope, null, c.skipped ? "Unskip" : "Skip", "invisible").root;
  skip.classList.add("snba-hc-btn");
  if (busy) skip.setAttribute("aria-disabled", "true");
  skip.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (skip.getAttribute("aria-disabled") !== "true") c.toggleSkip();
  });
  row.append(skip);
  lines.append(
    h(
      "li",
      {},
      h("b", {}, c.skipped ? "Unskip" : "Skip"),
      h(
        "span.snba-muted",
        {},
        c.skipped
          ? ": let Accept apply the recommendation again"
          : ": leave it in Triage; Accept passes over it",
      ),
    ),
  );
  box.append(row, lines);
  if (c.applied?.state === "pending") box.append(h("p.snba-hc-status", {}, "Applying…"));
  else if (c.applied?.state === "error") box.append(h("p.snba-hc-status.snba-error", {}, c.applied.message));
  else if (!c.canApply) box.append(h("p.snba-hc-status.snba-muted", {}, "Waiting for Accept to finish."));
  else if (c.skipped) box.append(h("p.snba-hc-status.snba-muted", {}, "Skipped."));
  return box;
}

function describe(a: ProposedAction): string {
  return a.steps
    .map((st) => (st.kind === "comment" ? `comment ${st.body.replace("\n", " + ")}` : `move to '${st.lane}'`))
    .join(", then ");
}

/** Opening, placing and closing the one floating card. Opens after a short delay like GitHub's hovercards, and
 *  stays open while the pointer is on the badge or the card itself, so its buttons can be reached. */
export class HoverCard {
  readonly el: HTMLElement;
  private restId: number | null = null;
  private anchor: HTMLElement | null = null;
  private openTimer: number | null = null;
  private closeTimer: number | null = null;

  /** What the open card was rendered from; a refresh with the same key leaves the DOM (and any click) alone. */
  private key: string | null = null;
  /** Set while focus is handed back to the anchor, so its focus handler does not reopen the card. */
  private returning = false;

  constructor(
    private render: (restId: number) => HTMLElement | null,
    private keyOf: (restId: number) => string,
  ) {
    this.el = h("div.snba-hovercard", { role: "dialog", "aria-label": "Jev's verdict" });
    this.el.hidden = true;
    this.el.addEventListener("mouseenter", () => this.cancelClose());
    this.el.addEventListener("mouseleave", () => this.scheduleClose());
    this.el.addEventListener("focusout", (e) => {
      if (!this.el.contains(e.relatedTarget as Node | null)) this.scheduleClose();
    });
    // Capture phase: the badge stops keydown from bubbling (the board would treat it as a drag), so a listener on
    // document in the bubble phase would never see Escape pressed on the badge.
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape" && !this.el.hidden) {
          this.closeAndReturn();
        }
      },
      true,
    );
    // Tabbing past either end of the card goes back to what opened it, and the card closes.
    this.el.addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      const f = this.focusables();
      const edge = e.shiftKey ? f[0] : f[f.length - 1];
      if (document.activeElement !== edge) return;
      e.preventDefault();
      this.closeAndReturn();
    });
    // The card is placed against the board card; once the board scrolls it would point at the wrong place.
    window.addEventListener(
      "scroll",
      (e) => {
        if (!this.el.hidden && !this.el.contains(e.target as Node)) this.close();
      },
      true,
    );
    document.body.append(this.el);
  }

  hoverStart(restId: number, anchor: HTMLElement, delay = 350): void {
    if (this.returning) return;
    this.cancelClose();
    if (!this.el.hidden && this.restId === restId) return;
    if (this.openTimer !== null) clearTimeout(this.openTimer);
    this.openTimer = window.setTimeout(() => {
      this.openTimer = null;
      this.show(restId, anchor);
    }, delay);
  }

  hoverEnd(): void {
    if (this.openTimer !== null) clearTimeout(this.openTimer);
    this.openTimer = null;
    this.scheduleClose();
  }

  /** Re-renders the open card only when its item's state changed (judged again, applying, applied). */
  refresh(restId: number): void {
    if (this.el.hidden || this.restId !== restId || !this.anchor) return;
    if (!this.anchor.isConnected) this.close();
    else if (this.keyOf(restId) !== this.key) this.show(restId, this.anchor);
  }

  isOpenFor(restId: number): boolean {
    return !this.el.hidden && this.restId === restId;
  }

  /** Keyboard users reach the buttons: the card lives at the end of the page, so Tab would skip it. */
  focusInto(): boolean {
    const first = this.focusables()[0];
    first?.focus();
    return Boolean(first);
  }

  private focusables(): HTMLElement[] {
    return [...this.el.querySelectorAll<HTMLElement>("button, a[href], [tabindex]")].filter(
      (x) => x.getAttribute("aria-disabled") !== "true",
    );
  }

  /** Closes and gives focus back to what opened the card, without that focus opening it again. */
  private closeAndReturn(): void {
    const back = this.anchor;
    this.close();
    this.returning = true;
    try {
      back?.focus();
    } finally {
      this.returning = false;
    }
  }

  close(): void {
    this.cancelClose();
    this.el.hidden = true;
    this.el.replaceChildren();
    this.restId = null;
    this.anchor = null;
    this.key = null;
  }

  private show(restId: number, anchor: HTMLElement): void {
    const content = this.render(restId);
    if (!content || !anchor.isConnected) return this.close();
    this.restId = restId;
    this.anchor = anchor;
    this.key = this.keyOf(restId);
    this.el.replaceChildren(content);
    this.el.hidden = false;
    this.place(anchor);
  }

  private place(anchor: HTMLElement): void {
    const card = anchor.closest<HTMLElement>("[data-board-card-id]") ?? anchor;
    const r = card.getBoundingClientRect();
    const w = this.el.offsetWidth;
    const ht = this.el.offsetHeight;
    const gap = 8;
    let left = r.right + gap;
    if (left + w > window.innerWidth - gap) left = r.left - gap - w;
    left = Math.max(gap, Math.min(left, window.innerWidth - w - gap));
    const top = Math.max(gap, Math.min(r.top, window.innerHeight - ht - gap));
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }

  private scheduleClose(delay = 250): void {
    this.cancelClose();
    this.closeTimer = window.setTimeout(() => this.close(), delay);
  }

  private cancelClose(): void {
    if (this.closeTimer !== null) clearTimeout(this.closeTimer);
    this.closeTimer = null;
  }
}
