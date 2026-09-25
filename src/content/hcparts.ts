/** Pieces every column's hover card is built from, so the cards read the same: Jev's readings as bars, a select
 *  that keeps the board's keys to itself, and the Apply / Skip box that says what the chosen action writes. */
import { f2 } from "../core/policy";
import type { Reading } from "../core/readings";
import type { ActionStep } from "../core/types";
import { nativeButton } from "./adapters";
import type { Applied } from "./hovercard";
import { h } from "./ui";

const meter = (p: number) =>
  h("span.snba-hc-meter", { "aria-hidden": "true" }, h("span", { style: `width:${Math.round(p * 100)}%` }));
const num = (p: number, warn = false) => h(`span.snba-hc-num${warn ? ".snba-error" : ""}`, {}, f2(p));

/** Everything Jev answered for a card: its readings, plus the Prow fixes it read and any `extra` (a duplicate
 *  match, reviewer picks) from the column's other passes. */
export function allReadings(
  r: { readings?: Reading[]; prow_fixes?: { wrote: string; fix: string; p: number }[] },
  extra: Reading[] = [],
): Reading[] {
  return [
    ...(r.readings ?? []),
    ...extra,
    ...(r.prow_fixes ?? []).map((f) => ({ label: `"${f.wrote}" meant "${f.fix}"`, p: f.p })),
  ];
}

/** Options below this share one "more" line: a choice among many (twelve SIGs) is mostly zeros. */
export const MINOR = 0.02;

/** Every reading in one grid, so all bars line up: a probability is one row; a choice is its label, then a row per
 *  option, most likely first. */
export function readingsBlock(xs: Reading[]): HTMLElement {
  const row = (label: Node | string, p: number, warn = false) => [
    h("span.snba-bar-label", {}, label),
    meter(p),
    num(p, warn),
  ];
  return h(
    "div.snba-readings",
    {},
    ...xs.flatMap((x) => {
      if ("p" in x) return row(x.label, x.p, x.warn);
      const opts = Object.entries(x.probabilities).sort((a, b) => b[1] - a[1]);
      const opt = ([k, p]: [string, number]) => row(h("span.snba-opt", {}, k.replaceAll("_", " ")), p);
      const shown = opts.filter(([, p], i) => i === 0 || p >= MINOR);
      const minor = opts.filter((o) => !shown.includes(o)).flatMap(opt);
      if (!minor.length) return [h("span.snba-readings-head", {}, x.label), ...shown.flatMap(opt)];
      // The small options stay folded until asked for; the button shows and hides them in place.
      for (const el of minor) el.hidden = true;
      const more = h(
        "button.snba-readings-more",
        { type: "button", "aria-expanded": "false" },
        `+${minor.length / 3} more under ${MINOR}`,
      ) as HTMLButtonElement;
      for (const ev of ["mousedown", "keydown"]) more.addEventListener(ev, (e) => e.stopPropagation());
      more.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const open = more.getAttribute("aria-expanded") !== "true";
        for (const el of minor) el.hidden = !open;
        more.setAttribute("aria-expanded", String(open));
        more.textContent = open ? "show fewer" : `+${minor.length / 3} more under ${MINOR}`;
        // A hover card is placed when it opens; grown, it is moved back inside the window (it scrolls past that).
        const card = more.closest<HTMLElement>(".snba-hovercard");
        if (card) {
          const r = card.getBoundingClientRect();
          if (r.bottom > window.innerHeight - 8)
            card.style.top = `${Math.max(8, window.innerHeight - 8 - r.height)}px`;
        }
      });
      return [h("span.snba-readings-head", {}, x.label), ...shown.flatMap(opt), ...minor, more];
    }),
  );
}

/** A label and free text (a `dt` / `dd` pair). */
export function fact(label: string, v: Node | string): HTMLElement[] {
  return [h("dt", {}, label), h("dd.snba-hc-text", {}, v)];
}

/** What a list of steps writes, in plain words. */
export function describe(steps: ActionStep[]): string {
  if (!steps.length) return "nothing to write";
  return steps
    .map((st) =>
      st.kind === "comment" ? `comment "${st.body.replaceAll("\n", " / ")}"` : `move to '${st.lane}'`,
    )
    .join(", then ");
}

/** A select styled like GitHub's. `placeholder` adds a first, unselectable option shown until something is picked. */
export function select(
  label: string,
  key: string,
  options: [string, string][],
  current: string | null,
  locked: boolean,
  onChange: (v: string) => void,
  placeholder?: string,
): HTMLSelectElement {
  const all: [string, string][] = placeholder ? [["", placeholder], ...options] : options;
  const sel = h(
    "select.snba-hc-select",
    { "aria-label": label, "data-focus-key": key },
    ...all.map(([v, text], i) => {
      const o = h("option", { value: v }, text) as HTMLOptionElement;
      o.selected = v === (current ?? "");
      if (placeholder && i === 0) o.disabled = true;
      return o;
    }),
  ) as HTMLSelectElement;
  sel.disabled = locked;
  // The board treats keys and clicks inside a card as its own; keep them in the select.
  for (const ev of ["click", "keydown", "mousedown"]) sel.addEventListener(ev, (e) => e.stopPropagation());
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

export interface ActionBox {
  scope: ParentNode;
  applied: Applied | undefined;
  canApply: boolean;
  /** The chosen action's name and steps (Prow fixes included). */
  label: string;
  steps: ActionStep[];
  /** Where Skip leaves the card: "in Triage", "in To do", or "" for wherever it is. */
  where: string;
  apply(): void;
  skip(): void;
}

/** Apply and Skip, what each does, and the apply state. */
export function actionBox(c: ActionBox): HTMLElement {
  const box = h("div.snba-hc-actions");
  if (c.applied?.state === "done") {
    box.append(h("p.snba-hc-status", {}, "Applied."));
    return box;
  }
  const locked = c.applied?.state === "pending" || !c.canApply;
  const button = (text: string, variant: "primary" | "invisible", disabled: boolean, go: () => void) => {
    const b = nativeButton(c.scope, null, text, variant).root;
    b.classList.add("snba-hc-btn");
    if (disabled) b.setAttribute("aria-disabled", "true");
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (b.getAttribute("aria-disabled") !== "true") go();
    });
    return b;
  };
  box.append(
    h(
      "div.snba-hc-buttons",
      {},
      button("Apply", "primary", locked || !c.steps.length, c.apply),
      button("Skip", "invisible", locked, c.skip),
    ),
    h(
      "ul.snba-hc-steps",
      {},
      h("li", {}, h("b", {}, c.label), h("span.snba-muted", {}, `: ${describe(c.steps)}`)),
      h(
        "li",
        {},
        h("b", {}, "Skip"),
        h(
          "span.snba-muted",
          {},
          `: leave it ${c.where ? `${c.where} ` : ""}untouched and drop the verdict; Accept passes over it`,
        ),
      ),
    ),
  );
  if (c.applied?.state === "pending") box.append(h("p.snba-hc-status", {}, "Applying…"));
  else if (c.applied?.state === "error") box.append(h("p.snba-hc-status.snba-error", {}, c.applied.message));
  else if (!c.canApply) box.append(h("p.snba-hc-status.snba-muted", {}, "Waiting for Accept to finish."));
  return box;
}
