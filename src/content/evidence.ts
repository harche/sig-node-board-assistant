/** The evidence block: verdict, decision band, Jev's answers, the code's checks and what a reviewer could do.
 *  It is rendered into GitHub's own sidebar (the project pane for issues, the PR page for pull requests) through
 *  an adapter that supplies the page's native section and row markup, so it reads as part of the page. */
import { f2, KEEP_AT, REMOVE_AT, tieBreak } from "../core/policy";
import { proposedActions } from "../core/triage";
import type { BoardFields, BoardItem, JevChoice, ProposedAction, Signals, TriageResult } from "../core/types";
import { h } from "./ui";

/** How to build a section and a label/value row that look native on the host page. */
export interface SidebarAdapter {
  /** A section with a heading; `body` is where content goes. */
  section(title: string): { root: HTMLElement; body: HTMLElement };
  /** A label/value row inside a section body. */
  row(label: string, value: Node | string): HTMLElement;
}

export interface EvidenceHandlers {
  rejudge(item: BoardItem): Promise<void>;
}

export type EvidenceState =
  | { state: "pending" }
  | { state: "error"; message: string }
  | { state: "done"; result: TriageResult; fields: BoardFields | null };

export const SECTION_TITLE = "SIG Node board assistant";

export function renderEvidence(
  adapter: SidebarAdapter,
  item: BoardItem,
  st: EvidenceState,
  handlers: EvidenceHandlers,
): HTMLElement {
  const { root, body } = adapter.section(SECTION_TITLE);
  root.classList.add("snba-evidence");
  root.dataset.snbaItem = String(item.restId);
  if (st.state === "pending") {
    body.append(h("p.snba-muted", {}, "Reading the thread and asking Jev…"));
    return root;
  }
  if (st.state === "error") {
    body.append(h("p.snba-error", {}, st.message), rejudgeLink(item, handlers));
    return root;
  }
  const r = st.result;
  const a = r.answers;
  const s = r.signals;
  body.append(decision(r));
  body.append(
    adapter.row("Kind of work", choice(a.bucket)),
    adapter.row("Owning SIG", choice(a.owner)),
    adapter.row("Urgency", h("span", {}, r.priority, h("span.snba-muted", {}, ` · ${r.priority_why}`))),
    adapter.row(
      "Routing",
      s.human_slash_routing_comments.length
        ? s.human_slash_routing_comments.map((x) => `${x.who}: ${x.cmd}`).join(", ")
        : "none",
    ),
    adapter.row("Comments", `${s.human_comment_count} by humans`),
  );
  if (r.kind === "PullRequest") {
    body.append(
      adapter.row("Files", `${s.file_count}, ${s.test_or_ci_file_count} in test or CI paths`),
      adapter.row("Review", reviewState(s)),
      adapter.row("Lane", r.lane),
    );
  }
  body.append(h("div.snba-subhead", {}, "What a reviewer could do"));
  if (st.fields) {
    const { accept, reject, recommended } = proposedActions(item, r, st.fields);
    const cards = recommended === "reject" ? [reject, accept] : [accept, reject];
    for (const c of cards)
      body.append(choiceCard(c, c === (recommended === "reject" ? reject : accept) && recommended !== null));
  } else {
    body.append(h("p.snba-muted", {}, "Board field ids are still loading; commands will appear shortly."));
  }
  body.append(
    h(
      "div.snba-foot",
      {},
      h(
        "span.snba-muted",
        {},
        `Read-only. Nothing here writes to GitHub. Jev read ${r.state_chars.toLocaleString()} chars${r.usage.cached ? ", cached" : ` for $${r.usage.cost.toFixed(5)}`}.`,
      ),
      rejudgeLink(item, handlers),
    ),
  );
  return root;
}

function rejudgeLink(item: BoardItem, handlers: EvidenceHandlers): HTMLElement {
  const b = h("button.snba-link", { type: "button" }, "Judge again") as HTMLButtonElement;
  b.title = "Re-fetch the thread and ask Jev again, bypassing the cache";
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await handlers.rejudge(item);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

function decision(r: TriageResult): HTMLElement {
  const p = r.answers.in_scope.noul;
  const word = r.verdict === "BORDERLINE" ? "Borderline" : r.verdict === "KEEP" ? "Keep" : "Remove";
  const sub =
    r.verdict === "BORDERLINE" ? "your call" : r.verdict === "KEEP" ? "accept onto the board" : "archive";
  const marker = h("span.snba-marker", { style: `left:${p * 100}%` });
  const band = h(
    "div.snba-band",
    {
      role: "img",
      "aria-label": `In scope with probability ${f2(p)}; below ${REMOVE_AT} removes, above ${KEEP_AT} keeps`,
    },
    marker,
  );
  const grey = p > REMOVE_AT && p < KEEP_AT;
  if (grey)
    band.append(
      h("span.snba-marker.snba-tie", {
        style: `left:${tieBreak(r.answers).m * 100}%`,
        title: `tie-break ${f2(tieBreak(r.answers).m)}`,
      }),
    );
  return h(
    "div.snba-decision",
    {},
    h(
      "div",
      {},
      h(`span.snba-verdict.snba-${r.verdict.toLowerCase()}`, {}, word),
      h("span.snba-muted", {}, ` ${sub}`),
    ),
    band,
    h(
      "div.snba-scale",
      {},
      h("span", {}, "remove"),
      h("span", {}, String(REMOVE_AT)),
      h("span", {}, String(KEEP_AT)),
      h("span", {}, "keep"),
    ),
    h("p.snba-why", {}, r.why),
  );
}

function choice(c: JevChoice): HTMLElement {
  const runnerUp = Object.entries(c.probabilities)
    .filter(([k]) => k !== c.choice)
    .sort((x, y) => y[1] - x[1])[0];
  return h(
    "span",
    {},
    c.choice.replaceAll("_", " "),
    h(
      "span.snba-muted",
      {},
      ` ${f2(c.probabilities[c.choice] ?? c.confidence)}`,
      runnerUp ? `, then ${runnerUp[0].replaceAll("_", " ")} ${f2(runnerUp[1])}` : "",
    ),
  );
}

function reviewState(s: Signals): string {
  const bits = [];
  if (s.is_draft) bits.push("draft");
  if (s.has_lgtm_label) bits.push("lgtm");
  if (s.review_decision) bits.push(s.review_decision === "APPROVED" ? "approved" : "changes requested");
  if (s.blocked_labels?.length) bits.push(`blocked by ${s.blocked_labels.join(", ")}`);
  return bits.length ? bits.join(", ") : "no review yet";
}

function choiceCard(a: ProposedAction, recommended: boolean): HTMLElement {
  const name = a.steps.some((st) => st.kind === "move" && st.lane === "Archive-it") ? "Archive" : "Accept";
  const steps = a.steps.map((st) =>
    st.kind === "comment" ? `comment "${st.body.replace("\n", " ")}"` : `move to "${st.lane}"`,
  );
  return h(
    `div.snba-choice${recommended ? ".snba-rec" : ""}`,
    {},
    h(
      "div",
      {},
      h("b", {}, name),
      recommended ? h("span.snba-rec-tag", {}, " recommended") : null,
      h("span.snba-muted", {}, `: ${steps.join(", then ")}`),
    ),
    h(
      "details",
      {},
      h("summary.snba-link", {}, "Show the commands"),
      h("pre.snba-pre", {}, a.ghCommands.join("\n")),
    ),
  );
}
