/** Native-looking section and row markup for the two hosts the evidence is rendered into.
 *
 *  Project pane / new issue page (React, hashed CSS-module classes): the adapter clones GitHub's own "Fields"
 *  section (header, and a label/value row) and swaps the text, so whatever GitHub's stylesheet says today is
 *  what our section gets. If no such section exists, it falls back to plain markup styled by content.css.
 *
 *  Classic PR page (`#partial-discussion-sidebar`): `discussion-sidebar-item` + `discussion-sidebar-heading`,
 *  the same classes GitHub's Milestone and Projects items use. */
import { FEEDBACK_REPO } from "../core/feedback";
import { missedAnchor } from "./dom";
import type { SidebarAdapter } from "./evidence";
import { h } from "./ui";

/** GitHub's sections container. Its class lost the "IssueSidebar-module__" prefix (now "sidebarContent__<hash>"), so
 *  it is also found by its sections' test ids ("sidebar-labels-section"…), which outlast the class names. */
export const PANE_SIDEBAR =
  '[class*="IssueSidebar-module__sidebarContent"], [class*="sidebarContent"]:has(> [data-testid^="sidebar-"][data-testid$="-section"])';
export const CLASSIC_SIDEBAR = "#partial-discussion-sidebar";

/** True when a sidebar section's text starts with one of `names` as a whole heading ("FieldsPriority…" counts,
 *  "Fieldset…" does not). */
export function headed(el: Element, ...names: string[]): boolean {
  const t = el.textContent?.trim() ?? "";
  return names.some((n) => t.startsWith(n) && !/[a-z]/.test(t.charAt(n.length)));
}

function fallbackRow(label: string, value: Node | string): HTMLElement {
  return h("div.snba-row", {}, h("span.snba-label", {}, label), h("span.snba-value", {}, value));
}

/** Adapter for the project pane and the React issue page. `sidebar` is the sections container. */
export function paneAdapter(sidebar: HTMLElement): SidebarAdapter {
  const sections = [...sidebar.children] as HTMLElement[];
  // Prefer "Fields": its header is a bare heading. "Type" and "Milestone" keep their value inside the header wrapper.
  const template =
    sections.find((s) => headed(s, "Fields")) ??
    sections.find((s) => headed(s, "Milestone")) ??
    sections.find((s) => headed(s, "Type"));
  const fieldRow = sections.find((s) => headed(s, "Fields"))?.children[1]?.firstElementChild as
    HTMLElement | undefined;
  return {
    section(title) {
      if (!template) {
        const body = h("div");
        return { root: h("div.snba-section", {}, h("h3.snba-heading", {}, title), body), body };
      }
      const root = template.cloneNode(false) as HTMLElement;
      const header = template.firstElementChild!.cloneNode(true) as HTMLElement;
      const h3 = header.querySelector("h3");
      if (h3) {
        h3.textContent = title;
        h3.removeAttribute("id");
      }
      // keep only the heading and its ancestors: drop buttons, menus and any value the template header carried
      if (h3) {
        for (let e: HTMLElement | null = h3; e && e !== header; e = e.parentElement) {
          for (const sib of [...e.parentElement!.children]) if (sib !== e) sib.remove();
        }
      }
      header.querySelectorAll("button, a, svg").forEach((e) => e.remove());
      const body = (template.children[1]?.cloneNode(false) as HTMLElement | undefined) ?? h("div");
      body.replaceChildren();
      root.append(header, body);
      return { root, body };
    },
    row(label, value) {
      if (!fieldRow) return fallbackRow(label, value);
      const row = fieldRow.cloneNode(true) as HTMLElement;
      const [l, v] = row.children as unknown as [HTMLElement | undefined, HTMLElement | undefined];
      if (!l || !v) return fallbackRow(label, value);
      l.textContent = label;
      v.replaceChildren(value instanceof Node ? value : document.createTextNode(value));
      v.removeAttribute("title");
      row.classList.add("snba-row");
      return row;
    },
  };
}

/** Adapter for the classic PR page sidebar. */
export function classicAdapter(): SidebarAdapter {
  return {
    section(title) {
      const body = h("div");
      const root = h(
        "div.discussion-sidebar-item.snba-section",
        {},
        h("h3.discussion-sidebar-heading.text-bold", {}, title),
        body,
      );
      return { root, body };
    },
    row: fallbackRow,
  };
}

/** Finds the sidebar container on the current page, if either host is present. */
export type Sidebar = { el: HTMLElement; adapter: SidebarAdapter };

export function findSidebar(doc: Document): Sidebar | null {
  const pane = [...doc.querySelectorAll<HTMLElement>(PANE_SIDEBAR)].find(
    (e) => e.getBoundingClientRect().width > 0,
  );
  if (pane) return { el: pane, adapter: paneAdapter(pane) };
  const classic = doc.querySelector<HTMLElement>(CLASSIC_SIDEBAR);
  if (classic) return { el: classic, adapter: classicAdapter() };
  return null;
}

/** An issue's page or a PR's Conversation tab: the pages that have a sidebar. */
export function onConversationTab(path: string = location.pathname): boolean {
  return /^\/[^/]+\/[^/]+\/(?:issues|pull)\/\d+\/?$/.test(path);
}

/** How long an issue or PR page may go without a sidebar we recognise before its sections float instead. */
export const FLOAT_AFTER_MS = 4000;
let missingSince = 0;
let missingPath = "";

/** The issue or PR page's sidebar. An item's conversation tab always has one, so if none is recognised there for
 *  FLOAT_AFTER_MS GitHub has changed its markup: the sections then go in a floating panel that says so, rather than
 *  not showing at all. Null while still waiting, and on a PR's other tabs (Files changed, Commits, Checks), which
 *  have no sidebar. Call it only with something to show. */
export function itemSidebar(doc: Document): Sidebar | null {
  const side = findSidebar(doc);
  if (side) {
    missingSince = 0;
    doc.getElementById("snba-float")?.remove();
    return side;
  }
  if (!onConversationTab()) return null;
  if (!missingSince || missingPath !== location.pathname) {
    missingSince = Date.now();
    missingPath = location.pathname;
  }
  if (Date.now() - missingSince < FLOAT_AFTER_MS) return null;
  missedAnchor("the issue sidebar");
  const body = floatingPanel(doc);
  return { el: body, adapter: paneAdapter(body) };
}

/** The floating panel's sections container, created on first use. */
function floatingPanel(doc: Document): HTMLElement {
  const old = doc.querySelector<HTMLElement>("#snba-float .snba-float-body");
  if (old) return old;
  const report = `https://github.com/${FEEDBACK_REPO}/issues/new?${new URLSearchParams({
    title: "GitHub's page changed: the issue sidebar was not found",
    // In a code span: a plain item reference would show up on that item's timeline.
    body: `On \`${location.pathname}\` the extension did not recognise GitHub's sidebar and floated its sections.`,
  })}`;
  const body = h("div.snba-float-body");
  const panel = h(
    "div",
    { id: "snba-float", role: "complementary", "aria-label": "SIG Node board assistant" },
    h(
      "p.snba-float-note",
      {},
      "GitHub's page changed, so these sections float here instead of in the sidebar. ",
      h("a", { href: report, target: "_blank", rel: "noopener" }, "Report it"),
    ),
    body,
  );
  doc.body.append(panel);
  return body;
}

/** Inserts our section after the "Fields" or "Labels" section in the pane, or after "Projects" on the PR page;
 *  otherwise at the end. */
export function placeSection(sidebar: HTMLElement, section: HTMLElement): void {
  const kids = [...sidebar.children] as HTMLElement[];
  const after = kids.find((k) => headed(k, "Fields", "Projects")) ?? kids.find((k) => headed(k, "Labels"));
  if (after) after.after(section);
  else sidebar.append(section);
}

/** A button built from GitHub's own Primer button classes, so the page's stylesheet draws it: the classes of an
 *  existing labelled button in `scope` (the column's "Add item") with the size and variant of the header's icon
 *  buttons (small, invisible). Returns plain elements for content.css to style if no such button is found. */
export function nativeButton(
  scope: ParentNode,
  icon: SVGSVGElement | null,
  label: string,
  variant: "invisible" | "primary" | "default" = "invisible",
): { root: HTMLElement; label: HTMLElement; native: boolean } {
  // The first of GitHub's buttons with both a leading visual and a label; ours (no visual) never qualify.
  const tpl = [
    ...scope.querySelectorAll<HTMLElement>('button:not(.snba-run) [data-component="buttonContent"]'),
  ]
    .map((c) => c.closest<HTMLElement>("button"))
    .find(
      (b) =>
        b?.querySelector('[data-component="leadingVisual"]') && b.querySelector('[data-component="text"]'),
    );
  const content = tpl?.querySelector<HTMLElement>('[data-component="buttonContent"]');
  const visual = tpl?.querySelector<HTMLElement>('[data-component="leadingVisual"]');
  const text = tpl?.querySelector<HTMLElement>('[data-component="text"]');
  if (!tpl || !content || !visual || !text) {
    // Not a GitHub change: a page or a reader (read-only, no "Add item") may have no such button.
    // Styled by content.css from Primer's own CSS variables, which outlast its class names.
    const l = h("span", {}, label);
    return {
      root: h("button.snba-btn", { type: "button", "data-variant": variant }, icon, l),
      label: l,
      native: false,
    };
  }
  // Only Primer's own classes (prc-*): the template's column-module class makes it full-width.
  const prc = (el: HTMLElement) => [...el.classList].filter((c) => c.startsWith("prc-")).join(" ");
  const l = h(`span.${prc(text).replace(/ /g, ".")}`, { "data-component": "text" }, label);
  const root = h(
    `button.${prc(tpl).replace(/ /g, ".")}`,
    {
      type: "button",
      "data-component": "Button",
      "data-size": "small",
      "data-variant": variant,
      "data-loading": "false",
      "data-no-visuals": String(!icon),
    },
    h(
      `span.${prc(content).replace(/ /g, ".")}`,
      { "data-component": "buttonContent", "data-align": "center" },
      icon ? h(`span.${prc(visual).replace(/ /g, ".")}`, { "data-component": "leadingVisual" }, icon) : null,
      l,
    ),
  );
  return { root, label: l, native: true };
}

/** A small default button drawn by GitHub's own styles, for the sidebar's "Check" and "Judge again": Primer React's
 *  classes where the page has such a button to copy, else `.snba-btn` from Primer's CSS variables. */
export function pageButton(label: string): HTMLButtonElement {
  const { root } = nativeButton(document, null, label, "default");
  root.classList.add("snba-run-check");
  return root as HTMLButtonElement;
}

let tipSeq = 0;

/** GitHub's own tooltip for `btn`: a popover span with the class of a Primer tooltip found in `scope` (the header's
 *  "…" and "+" have one), shown 4px below the button and centred, like GitHub's. The text is read from
 *  `btn.dataset.tip` each time it opens, so callers just update that. Falls back to .snba-tip-plain styling. */
export function attachTooltip(btn: HTMLElement, scope: ParentNode): void {
  const tpl = scope.querySelector<HTMLElement>('[data-component="Tooltip"]:not(.snba-tip)');
  const cls = [...(tpl?.classList ?? [])].filter((c) => c.startsWith("prc-"));
  const tip = h(`span.snba-tip${cls.length ? "." + cls.join(".") : ".snba-tip-plain"}`, {
    "data-component": "Tooltip",
    "data-direction": "s",
    role: "tooltip",
    id: `snba-tip-${++tipSeq}`,
    popover: "manual",
  });
  btn.setAttribute("aria-describedby", tip.id);
  document.body.append(tip);
  const show = () => {
    const text = btn.dataset.tip;
    if (!text || !btn.isConnected) return;
    tip.textContent = text;
    tip.showPopover();
    const b = btn.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const left = Math.min(Math.max(4, b.left + b.width / 2 - t.width / 2), window.innerWidth - t.width - 4);
    tip.style.top = `${b.bottom + 4 + window.scrollY}px`;
    tip.style.left = `${left + window.scrollX}px`;
  };
  const hide = () => {
    if (tip.matches(":popover-open")) tip.hidePopover();
  };
  btn.addEventListener("mouseenter", show);
  btn.addEventListener("focus", show);
  btn.addEventListener("mouseleave", hide);
  btn.addEventListener("blur", hide);
  btn.addEventListener("click", hide);
}
