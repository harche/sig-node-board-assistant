/** The Feedback link every card carries, and the dialog it opens: the reader's words, optionally what the outcome
 *  should have been, and a look at what is attached. The worker opens the issue (core/feedback.ts); when the token
 *  may not, the dialog offers GitHub's prefilled new-issue page with the attachments on the clipboard. The dialog
 *  lives on <body>, so the hover card it was opened from can close under it. */
import { knownBoard } from "../core/boards";
import { FEEDBACK_REPO, type FeedbackReport } from "../core/feedback";
import type { BoardFields, BoardItem, BoardRef } from "../core/types";
import { send } from "../shared/messages";
import { h } from "./ui";

/** What a card hands the dialog; the page and the reader's words are added here. */
export type FeedbackCtx = Omit<FeedbackReport, "text" | "expected" | "page"> & {
  /** The card's own outcomes for "Should have been", e.g. the board's columns. */
  options?: string[];
};

/** The card's decision text as shown, whitespace collapsed. */
export function shownText(el: ParentNode | null | undefined, fallback = ""): string {
  const d = el?.querySelector(".snba-decision");
  if (!d) return fallback;
  // Each text node on its own, so a heading and the line under it do not run together.
  const parts: string[] = [];
  const walk = document.createTreeWalker(d, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) parts.push(n.textContent ?? "");
  return (
    parts
      .join(" ")
      .replace(/\s+/g, " ")
      .replace(/ ([,.:;)])/g, "$1")
      .trim() || fallback
  );
}

/** A small "Feedback" link for a card's foot. `ctx` is read on click, so it is what the card shows then. */
export function feedbackLink(ctx: () => FeedbackCtx | null): HTMLElement {
  const b = h(
    "button.snba-link.snba-feedback-link",
    { type: "button", title: "Tell us this card got something wrong, or anything else about it" },
    "Feedback",
  );
  // The board treats clicks and keys inside a card as its own.
  for (const ev of ["mousedown", "keydown"]) b.addEventListener(ev, (e) => e.stopPropagation());
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const c = ctx();
    if (c) openFeedback(c);
  });
  return h("div.snba-feedback-row", {}, b);
}

export function openFeedback(ctx: FeedbackCtx): void {
  document.querySelector(".snba-feedback")?.remove();
  const { options, ...base } = ctx;
  const report = (text: string, expected: string): FeedbackReport => ({
    ...base,
    text,
    ...(expected ? { expected } : {}),
    page: location.href,
  });

  const text = h("textarea.snba-feedback-text", {
    rows: "5",
    placeholder: "What did it get wrong, or what would you change?",
    "aria-label": "Your feedback",
  }) as HTMLTextAreaElement;
  const expected = h(
    "select.snba-hc-select",
    { "aria-label": "Should have been" },
    h("option", { value: "" }, "—"),
    ...(options ?? []).map((o) => h("option", { value: o }, o)),
  ) as HTMLSelectElement;
  const where = h("p.snba-muted", {}, "Reading what will be attached…");
  const preview = h("pre.snba-pre.snba-feedback-preview");
  const status = h("p.snba-feedback-status");
  const submit = h("button.snba-fb-btn.snba-fb-primary", { type: "submit" }, "Submit") as HTMLButtonElement;
  const cancel = h("button.snba-fb-btn", { type: "button" }, "Cancel") as HTMLButtonElement;
  const sync = () => (submit.disabled = !text.value.trim() && !expected.value);
  sync();
  text.addEventListener("input", sync);
  expected.addEventListener("change", sync);

  const form = h(
    "form.snba-feedback-form",
    { method: "dialog" },
    h("h2.snba-feedback-title", {}, "Feedback on this card"),
    text,
    options?.length
      ? h("label.snba-feedback-expected", {}, h("span", {}, "Should have been "), expected)
      : null,
    where,
    h("details.snba-feedback-more", {}, h("summary.snba-link", {}, "What is attached"), preview),
    status,
    h("div.snba-feedback-buttons", {}, cancel, submit),
  );
  const dialog = h("dialog.snba-feedback", { "aria-label": "Feedback" }, form) as HTMLDialogElement;
  // GitHub's and the board's shortcuts listen on the document; typing here is for the textarea.
  for (const ev of ["keydown", "keyup", "keypress", "mousedown"])
    dialog.addEventListener(ev, (e) => {
      if (!(e instanceof KeyboardEvent && e.key === "Escape")) e.stopPropagation();
    });
  dialog.addEventListener("close", () => dialog.remove());
  cancel.addEventListener("click", () => dialog.close());
  document.body.append(dialog);
  dialog.showModal();
  text.focus();

  // The issue as it would be sent, redrawn as the reader types.
  let shown = 0;
  const refresh = () => {
    const mine = ++shown;
    void send({ type: "feedback.preview", report: report(text.value, expected.value) })
      .then((p) => {
        if (mine !== shown) return;
        where.textContent =
          `Opens ${p.repo === FEEDBACK_REPO ? "a public issue" : "an issue"} on ${p.repo} under your GitHub account, ` +
          `with what the card showed, its result and ` +
          (p.calls
            ? `the ${p.calls} Jev calls behind it (${p.attachedKb} KB` +
              (p.gist
                ? ", too big for the issue: they go to a secret gist on your account, linked from the issue)."
                : ").")
            : `no Jev calls (none kept for this card).`);
        preview.textContent = `${p.title}\n\n${p.head}`;
      })
      .catch((e: unknown) => (where.textContent = e instanceof Error ? e.message : String(e)));
  };
  let timer: number | undefined;
  const later = () => {
    clearTimeout(timer);
    timer = window.setTimeout(refresh, 300);
  };
  text.addEventListener("input", later);
  expected.addEventListener("change", refresh);
  refresh();

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    text.disabled = true;
    expected.disabled = true;
    status.className = "snba-feedback-status snba-muted";
    status.textContent = "Opening the issue…";
    const r = report(text.value, expected.value);
    void send({ type: "feedback.submit", report: r })
      .then((out) => {
        if (out.opened !== null) {
          status.className = "snba-feedback-status";
          status.replaceChildren(
            "Thanks. Filed ",
            h(
              "a",
              { href: out.opened, target: "_blank", rel: "noopener" },
              out.opened.replace(/^.*\/issues\//, "#"),
            ),
            ...(out.gist
              ? [
                  ", with its Jev calls in ",
                  h("a", { href: out.gist, target: "_blank", rel: "noopener" }, "a gist"),
                  ".",
                ]
              : ["."]),
          );
          cancel.textContent = "Close";
          submit.hidden = true;
          return;
        }
        // The token may not open issues there: the reader files it on GitHub, one click. The page links the gist when
        // one was made; otherwise the attachments go on the clipboard.
        const { url, paste } = out.prefill;
        status.className = "snba-feedback-status";
        const go = h(
          "button.snba-fb-btn.snba-fb-primary",
          { type: "button" },
          paste ? "Copy attachments and open GitHub" : "Open GitHub",
        );
        go.addEventListener("click", () => {
          if (paste) void navigator.clipboard.writeText(paste).catch(() => undefined);
          window.open(url, "_blank", "noopener");
          go.textContent = paste ? "Copied; paste them into the issue" : "Opened; submit it there";
        });
        status.replaceChildren(
          h(
            "span.snba-muted",
            {},
            `Your token cannot open the issue (${out.error}). File it on GitHub instead: `,
          ),
          go,
        );
        submit.hidden = true;
      })
      .catch((err: unknown) => {
        status.className = "snba-feedback-status snba-error";
        status.textContent = err instanceof Error ? err.message : String(err);
        submit.disabled = false;
        text.disabled = false;
        expected.disabled = false;
      });
  });
}

/** A board card's feedback, the same for every column of every board (hover card, GitHub's pane, the item page):
 *  "Should have been" offers the board's columns. */
export function boardFeedback(c: {
  board: BoardRef;
  column: string;
  item: BoardItem;
  result: unknown;
  fields: BoardFields | null;
  /** The reader's picks on the card in place of the suggestion. */
  overrides?: Record<string, string>;
  applied?: string;
  where: string;
  card: () => ParentNode | null;
}): HTMLElement {
  return feedbackLink(() => ({
    surface: `${c.where} · ${knownBoard(c.board)?.title ?? `${c.board.owner}/${c.board.number}`} · ${c.column}`,
    item: { repo: c.item.repository, number: c.item.number, url: c.item.url },
    shown: shownText(c.card()),
    result: c.result,
    context: {
      Board: `${c.board.owner}/${c.board.number}`,
      Column: c.column,
      ...(c.overrides && Object.keys(c.overrides).length
        ? { "Reader's picks": JSON.stringify(c.overrides) }
        : {}),
      ...(c.applied ? { Applied: c.applied } : {}),
    },
    options: [...Object.keys(c.fields?.options ?? {}), OFF_BOARD],
  }));
}

export const OFF_BOARD = "Off the board (archived)";
