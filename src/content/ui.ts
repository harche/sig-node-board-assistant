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

/** A 16px Octicon from its path data, coloured by currentColor. */
export function octicon(d: string): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "currentColor");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

// ---------------------------------------------------------------------------------------------------- links
// Everything that names something on GitHub, Prow or TestGrid opens it: these build the links, and linkifyTree
// turns the references left in text (Jev's reasons, a guard, an issue title) into links after a section is drawn.

export function link(href: string, text: Child): HTMLAnchorElement {
  return h("a", { href, target: "_blank", rel: "noopener" }, text) as HTMLAnchorElement;
}

/** `#N`, or `org/repo#N` when the item is in another repo than `own`; GitHub redirects an issue URL to the PR. */
export function itemRef(repo: string, number: number, own?: string, url?: string): HTMLAnchorElement {
  return link(
    url ?? `https://github.com/${repo}/issues/${number}`,
    own && own !== repo ? `${repo}#${number}` : `#${number}`,
  );
}

export function userRef(login: string): HTMLAnchorElement {
  return link(`https://github.com/${encodeURIComponent(login)}`, login);
}

/** Logins as profile links, comma-separated. */
export function logins(xs: string[]): HTMLElement {
  return h("span", {}, ...xs.flatMap((l, i) => [i ? ", " : "", userRef(l)]));
}

export const testgridUrl = (testgrid: string) => `https://testgrid.k8s.io/${testgrid}`;

/** Prow's run history of `job`: from its GCS path (`bucket/logs/<job>`, `bucket/pr-logs/directory/<job>`), or
 *  from the Prow page of one of the job's own periodic runs (`…/view/gs/<bucket>/logs/<job>/<build>`). Null when
 *  neither is known. */
export function prowHistory(job: string, from: { gcs?: string; runUrl?: string }): string | null {
  if (from.gcs) return `https://prow.k8s.io/job-history/gs/${from.gcs.replace(/\/$/, "")}`;
  const run = /prow\.k8s\.io\/view\/gs\/([\w.-]+)\/logs\/([\w.-]+)\//.exec(from.runUrl ?? "");
  return run && run[2] === job ? `https://prow.k8s.io/job-history/gs/${run[1]}/logs/${job}` : null;
}

/** A job's name, opening its Prow run history when the bucket is known, else `fallback` (its TestGrid tab). */
export function jobLink(
  job: string,
  from: { gcs?: string; runUrl?: string },
  text: string = job,
  fallback?: string,
): HTMLElement | string {
  const href = prowHistory(job, from) ?? fallback;
  if (!href) return text;
  const a = link(href, text);
  a.title = job;
  return a;
}

const REF =
  /https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]]|\b([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)#(\d+)\b|(?<![\w/&#])#(\d+)\b/g;
const SKIP = "a, button, select, option, textarea, pre, code, script, style";

/** Turns URLs, `org/repo#N` and (with `own`, the item's repo) `#N` in the text under `root` into links, keeping the
 *  text as written. Text in links, controls, code (log lines) and command blocks is left alone. */
export function linkifyTree(root: HTMLElement, own?: string): HTMLElement {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest(SKIP) || !/https?:|#\d/.test(n.nodeValue ?? "")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const t of texts) {
    const s = t.nodeValue ?? "";
    const out: (Node | string)[] = [];
    let at = 0;
    for (const m of s.matchAll(REF)) {
      const bare = m[3] !== undefined;
      if (bare && !own) continue;
      out.push(s.slice(at, m.index));
      out.push(
        link(
          m[1] !== undefined
            ? `https://github.com/${m[1]}/issues/${m[2]}`
            : bare
              ? `https://github.com/${own}/issues/${m[3]}`
              : m[0],
          m[0],
        ),
      );
      at = m.index + m[0].length;
    }
    if (at === 0) continue;
    out.push(s.slice(at));
    t.replaceWith(...out);
  }
  return root;
}
