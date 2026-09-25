/** Board DOM anchors. GitHub Projects is a React app with hashed class names; only the data-* attributes below
 *  are relied on. If GitHub renames them, this file is the one place to fix. */

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

/** Puts the run button in the column's header, before GitHub's own "…" and "+" buttons. The actions row is found by
 *  its CSS-module class prefix, then by the column title (h2); failing both, the button is not placed. */
export function placeRunButton(col: HTMLElement, ...btns: HTMLElement[]): boolean {
  const actions = col.querySelector<HTMLElement>('[class*="__ColumnActions"]');
  if (actions) {
    actions.prepend(...btns);
    return true;
  }
  const title = col.querySelector<HTMLElement>("h2");
  if (!title?.parentElement) return false;
  title.parentElement.append(...btns);
  return true;
}

/** Puts the badge in the card's header row (repo #number … avatar), before the avatar. The row is found by
 *  its CSS-module class prefix, then by the "repo #123" text; failing both, the badge goes at the end of the card. */
export function placeBadge(card: HTMLElement, badge: HTMLElement): void {
  const header = card.querySelector<HTMLElement>('[class*="__Header"]');
  const row = header?.firstElementChild as HTMLElement | null;
  if (row) {
    if (badge.parentElement === row) return;
    if (row.children.length >= 2) row.insertBefore(badge, row.lastElementChild);
    else row.append(badge);
    return;
  }
  if (badge.isConnected && card.contains(badge)) return;
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
    el?.closest(".snba-badge, .snba-run, .snba-tip, .snba-evidence, .snba-hovercard, #snba-pill"),
  );
}
