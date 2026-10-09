/** Duplicates and related issues as a list to comment from: one row per match, ticked by default, and a button that
 *  posts the comment pointing the thread at the ticked ones (core/related.ts relatedComment). Shared by the issue
 *  page's section and Triage's hover card; the caller owns the state and the write. */
import { MAX_REFS, relatedComment, shortRef, type RelatedMatch, type RelatedResult } from "../core/related";
import { h } from "./ui";

/** How a match relates to the issue it was found for, in that issue's terms. */
export function relationLabel(m: RelatedMatch): string {
  switch (m.relation) {
    case "duplicate":
      return "duplicate";
    case "same_root_cause":
      return "same root cause";
    case "regression":
      return m.older ? "this is it coming back" : "it came back there";
    case "follow_up":
      return m.older ? "this follows up on it" : "follows up on this";
    case "part_of":
      return "umbrella or sub-item";
    default:
      return m.relation;
  }
}

export const LINK_LABEL: Record<string, string> = {
  same_error: "same error",
  same_test: "same test",
  same_code_path: "same code path",
  same_request: "same request",
  same_trigger: "same trigger",
};

export type Post =
  | { state: "idle" }
  | { state: "pending" }
  | { state: "done"; wrote: string; already: boolean }
  | { state: "error"; message: string };

export const matchKey = (m: { repository: string; number: number }) => `${m.repository}#${m.number}`;

/** What the reader did with one issue's matches, kept by the caller across re-renders: what they unticked, whether
 *  the preview is open, and the comment's write. */
export interface PickState {
  dropped: Set<string>;
  preview: boolean;
  post: Post;
}

/** Every match ticked, up to the MAX_REFS one comment may carry (duplicates first, as the comment lists them). */
export function freshPicks(r: RelatedResult | null, post: Post = { state: "idle" }): PickState {
  const all = r ? [...r.duplicates, ...r.related] : [];
  return { dropped: new Set(all.slice(MAX_REFS).map(matchKey)), preview: false, post };
}

/** The comment for the ticked matches, or null when none is ticked. */
export function pickedComment(repo: string, r: RelatedResult, dropped: Set<string>): string | null {
  const keep = (ms: RelatedMatch[]) => ms.filter((m) => !dropped.has(matchKey(m)));
  const dups = keep(r.duplicates);
  const related = keep(r.related);
  return dups.length || related.length ? relatedComment(repo, dups, related) : null;
}

export interface Picker {
  /** The issue the matches were found for. */
  repo: string;
  number: number;
  result: RelatedResult;
  /** Ticks and the preview change here, in place: ticking does not re-render the caller. */
  state: PickState;
  /** Why Comment has to wait (another write to the item is running), or null. */
  blocked: string | null;
  /** A button in the place's own style (GitHub's on the board, the sidebar's on the issue page). */
  button(label: string): HTMLElement;
  comment(body: string): void;
}

/** The board takes keys and clicks inside a card as its own: keep them here. Tab still reaches the hover card, which
 *  closes when focus leaves either end. */
function own<T extends HTMLElement>(el: T): T {
  for (const ev of ["click", "mousedown"]) el.addEventListener(ev, (e) => e.stopPropagation());
  el.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key !== "Tab") e.stopPropagation();
  });
  return el;
}

export function relatedPicker(p: Picker): HTMLElement[] {
  const st = p.state;
  const posted = st.post.state === "pending" || st.post.state === "done";
  const ref = (m: RelatedMatch) => shortRef(m.repository, m.number, p.repo);
  const r = p.result;
  const boxes: [string, HTMLInputElement][] = [];
  const row = (m: RelatedMatch) => {
    const key = matchKey(m);
    const box = own(
      h("input.snba-rel-pick", {
        type: "checkbox",
        "aria-label": `Include ${ref(m)} in the comment`,
        "data-focus-key": `rel:${key}`,
      }) as HTMLInputElement,
    );
    box.checked = !st.dropped.has(key);
    box.addEventListener("change", () => {
      if (box.checked) st.dropped.delete(key);
      else st.dropped.add(key);
      paint();
    });
    boxes.push([key, box]);
    return h(
      "div.snba-rel",
      {},
      h(
        "div",
        {},
        box,
        own(h("a", { href: m.url, target: "_blank", rel: "noopener" }, ref(m))),
        ` ${m.state === "closed" ? "(closed) " : ""}${m.title.slice(0, 90)}`,
      ),
      h(
        "div.snba-muted",
        {},
        [relationLabel(m), m.link ? LINK_LABEL[m.link] : null, `P ${m.p.toFixed(2)}`]
          .filter(Boolean)
          .join(" · "),
      ),
    );
  };
  const out: HTMLElement[] = [];
  if (r.duplicates.length) out.push(h("div.snba-subhead", {}, "Duplicates"), ...r.duplicates.map(row));
  if (r.related.length) out.push(h("div.snba-subhead", {}, "Related"), ...r.related.map(row));
  const label =
    st.post.state === "done"
      ? st.post.already
        ? "Already commented"
        : "Commented"
      : `Comment on #${p.number}`;
  const btn = own(p.button(label));
  btn.dataset.focusKey = "rel:comment";
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    const body = pickedComment(p.repo, r, st.dropped);
    if (btn.getAttribute("aria-disabled") !== "true" && body) p.comment(body);
  });
  const limit = h("p.snba-muted", {}, `One comment lists at most ${MAX_REFS}: untick one to pick another.`);
  const preview = h("pre.snba-rel-preview");
  const details = own(
    h("details", {}, h("summary.snba-link", {}, "What it posts"), preview),
  ) as HTMLDetailsElement;
  details.open = st.preview;
  details.addEventListener("toggle", () => (st.preview = details.open));
  /** Everything a tick changes: the boxes past the limit, the button, the preview. */
  const paint = () => {
    const ticked = boxes.filter(([k]) => !st.dropped.has(k)).length;
    const full = ticked >= MAX_REFS;
    for (const [, b] of boxes) b.disabled = posted || (full && !b.checked);
    limit.hidden = !full || boxes.length <= MAX_REFS || posted;
    const body = pickedComment(p.repo, r, st.dropped);
    const off = posted || !body || p.blocked !== null;
    if (off) btn.setAttribute("aria-disabled", "true");
    else btn.removeAttribute("aria-disabled");
    btn.title =
      p.blocked ??
      (body
        ? "Post a comment listing the ticked issues as possible duplicates or related, for the thread to look at"
        : "Tick at least one issue");
    preview.textContent = body ?? "";
    details.hidden = !body;
  };
  paint();
  const status =
    st.post.state === "pending"
      ? h("p.snba-muted", {}, "Commenting…")
      : st.post.state === "done"
        ? h(
            "p.snba-muted",
            {},
            st.post.already
              ? `${st.post.wrote} already has this comment: not posted again.`
              : `Commented on ${st.post.wrote}.`,
          )
        : st.post.state === "error"
          ? h("p.snba-error", {}, st.post.message)
          : p.blocked
            ? h("p.snba-muted", {}, p.blocked)
            : null;
  out.push(h("div.snba-rel-comment", {}, limit, btn, details, status));
  return out;
}
