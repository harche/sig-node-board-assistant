/** Board DOM anchors. GitHub Projects is a React app with hashed class names, and it renames them (the
 *  "Module-module__" prefixes went in 2026), so nothing here relies on a class: only data-* attributes, Primer's
 *  data-component, ids GitHub builds from the item id, and the page's structure. If GitHub renames those, this file
 *  is the one place to fix; a miss is reported once on the console (missedAnchor). */

const attr = (v: string) => v.replace(/["\\]/g, "\\$&");

export const SEL = {
  column: (name: string) => `[data-board-column="${attr(name)}"]`,
  card: "[data-board-card-id]",
  badge: ".snba-badge",
  run: ".snba-run",
} as const;

export interface CardRef {
  el: HTMLElement;
  /** Numeric project item id, matches BoardItem.restId. */
  restId: number;
}

/** Cards currently rendered in `column` (the board virtualises long columns; call again after scrolling). */
export function cardsIn(root: ParentNode, column: string): CardRef[] {
  const out: CardRef[] = [];
  for (const el of root.querySelectorAll<HTMLElement>(`${SEL.column(column)} ${SEL.card}`)) {
    const restId = Number(el.dataset.boardCardId);
    if (Number.isFinite(restId)) out.push({ el, restId });
  }
  return out;
}

/** The card's own issue / PR link (not the repository link or an avatar). Clicking it is what opens GitHub's
 *  pane for an issue, or the PR in a new tab. */
export function itemLink(card: HTMLElement): HTMLAnchorElement | null {
  return (
    [...card.querySelectorAll<HTMLAnchorElement>("a[href]")].find((a) =>
      /\/(issues|pull)\/\d+(?:[?#]|$)/.test(a.href),
    ) ?? null
  );
}

/** Every column the board has rendered, by its Status name. */
export function columns(root: ParentNode): { name: string; el: HTMLElement }[] {
  return [...root.querySelectorAll<HTMLElement>("[data-board-column]")].map((el) => ({
    name: el.dataset.boardColumn ?? "",
    el,
  }));
}

const missed = new Set<string>();
const missListeners: ((what: string) => void)[] = [];

/** Says once per page, on the console and to onMissedAnchor's listeners (the board's pill), that an anchor was not
 *  found, so a GitHub redesign is noticed rather than silently degrading what the page shows. */
export function missedAnchor(what: string): void {
  if (missed.has(what)) return;
  missed.add(what);
  console.warn(`SIG Node board assistant: GitHub's page changed, ${what} not found; using a fallback.`);
  for (const f of missListeners) f(what);
}

export function onMissedAnchor(f: (what: string) => void): void {
  missListeners.push(f);
  for (const what of missed) f(what);
}

/** The row holding GitHub's own "…" and "+" buttons in a column's header: the parent of the first Primer icon
 *  button (data-component="IconButton") that shares an ancestor with the column title (h2) and is not on a card. */
export function columnActions(col: HTMLElement): HTMLElement | null {
  const title = col.querySelector<HTMLElement>("h2");
  for (let e = title?.parentElement; e && e !== col; e = e.parentElement) {
    const btn = [...e.querySelectorAll<HTMLElement>('[data-component="IconButton"]')].find(
      (b) => !b.closest(SEL.card) && !b.closest(SEL.run),
    );
    if (btn?.parentElement) return btn.parentElement;
  }
  return null;
}

/** Puts the run button in the column's header, before GitHub's own "…" and "+" buttons; failing that, after the
 *  column title (h2); failing both, the button is not placed. */
export function placeRunButton(col: HTMLElement, ...btns: HTMLElement[]): boolean {
  const actions = columnActions(col);
  if (actions) {
    actions.prepend(...btns);
    return true;
  }
  missedAnchor("the column header's actions row");
  const title = col.querySelector<HTMLElement>("h2");
  if (!title?.parentElement) return false;
  title.parentElement.append(...btns);
  return true;
}

/** Puts the badge after the card's "repo #number", in the title cell GitHub ids by the item
 *  (`board-card-header-title-<id>`); failing that, beside the "repo #123" text; failing both, at the card's end. */
export function placeBadge(card: HTMLElement, badge: HTMLElement): void {
  const cell = card.querySelector<HTMLElement>('[id^="board-card-header-title-"]');
  if (cell) {
    if (badge.parentElement !== cell) cell.append(badge);
    return;
  }
  if (badge.isConnected && card.contains(badge)) return;
  // A card GitHub has not drawn yet (the board virtualises) has no link: nothing is missing there.
  if (itemLink(card)) missedAnchor("the card's title cell");
  for (const el of card.querySelectorAll<HTMLElement>("span, div, a")) {
    if (el.children.length === 0 && /#\d+$/.test(el.textContent?.trim() ?? "")) {
      (el.parentElement ?? card).append(badge);
      return;
    }
  }
  card.append(badge);
}

/** The project item id GitHub puts in the URL while its pane is open (`?pane=issue&itemId=N`). */
export function paneItemId(url: string = location.href): number | null {
  const u = new URL(url);
  if (u.searchParams.get("pane") !== "issue") return null;
  const id = Number(u.searchParams.get("itemId"));
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** True when a mutation happened inside something this extension drew, so observers can ignore their own work. */
export function isOurs(node: Node): boolean {
  const el = node instanceof Element ? node : node.parentElement;
  return Boolean(
    el?.closest(
      ".snba-badge, .snba-run, .snba-tip, .snba-evidence, .snba-act, .snba-ci, .snba-hovercard, #snba-pill, #snba-float",
    ),
  );
}

/** The board's filter bar is set (typed, or saved with the view): drawn cards are then not the whole column. */
export function boardFiltered(root: ParentNode = document): boolean {
  return Boolean(
    root.querySelector<HTMLInputElement>('input[name="filter-bar-component-inputname"]')?.value.trim(),
  );
}
