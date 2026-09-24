/** Tiny DOM builder: `h("div.cls", {attr}, children…)`. Text children are text nodes, never HTML. */
export type Child = Node | string | number | null | undefined | false;

export function h(
  spec: string,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: Child[]
): HTMLElement {
  const [tag, ...classes] = spec.split(".");
  const el = document.createElement(tag || "div");
  if (classes.length) el.className = classes.join(" ");
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}
