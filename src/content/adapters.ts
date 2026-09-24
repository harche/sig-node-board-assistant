/** Native-looking section and row markup for the two hosts the evidence is rendered into.
 *
 *  Project pane / new issue page (React, hashed CSS-module classes): the adapter clones GitHub's own "Fields"
 *  section (header, and a label/value row) and swaps the text, so whatever GitHub's stylesheet says today is
 *  what our section gets. If no such section exists, it falls back to plain markup styled by content.css.
 *
 *  Classic PR page (`#partial-discussion-sidebar`): `discussion-sidebar-item` + `discussion-sidebar-heading`,
 *  the same classes GitHub's Milestone and Projects items use. */
import type { SidebarAdapter } from "./evidence";
import { h } from "./ui";

export const PANE_SIDEBAR = '[class*="IssueSidebar-module__sidebarContent"]';
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
export function findSidebar(doc: Document): { el: HTMLElement; adapter: SidebarAdapter } | null {
  const pane = [...doc.querySelectorAll<HTMLElement>(PANE_SIDEBAR)].find(
    (e) => e.getBoundingClientRect().width > 0,
  );
  if (pane) return { el: pane, adapter: paneAdapter(pane) };
  const classic = doc.querySelector<HTMLElement>(CLASSIC_SIDEBAR);
  if (classic) return { el: classic, adapter: classicAdapter() };
  return null;
}

/** Inserts our section after the "Fields" or "Labels" section in the pane, or after "Projects" on the PR page;
 *  otherwise at the end. */
export function placeSection(sidebar: HTMLElement, section: HTMLElement): void {
  const kids = [...sidebar.children] as HTMLElement[];
  const after = kids.find((k) => headed(k, "Fields", "Projects")) ?? kids.find((k) => headed(k, "Labels"));
  if (after) after.after(section);
  else sidebar.append(section);
}
