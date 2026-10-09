/** Typed request/response protocol between the content script / options page and the background worker.
 *  Every request is a read except `item.apply`, which the worker only runs on boards marked writable, `tg.apply`,
 *  `issue.comment` (the related-issues comment, from the issue page or a Triage card) and `feedback.submit`, which opens an issue on the
 *  extension's own repo. */
import type { Placement } from "../core/lookup";
import type { ProgressResult } from "../core/inprogress";
import type { ApproveResult } from "../core/approver";
import type { AuthorResult } from "../core/author";
import type { BugResult } from "../core/bugs";
import type { InfoResult } from "../core/needsinfo";
import type { BacklogResult } from "../core/backlog";
import type { DraColumn, DraResult } from "../core/dra";
import type { TgStep, TgResult } from "../core/tgreview";
import type { CiJob, FailedCheck, PrChecks } from "../core/prci";
import type { IssueCiResult } from "../core/issuecheck";
import type { RelatedResult } from "../core/related";
import type { TgRef } from "../core/testgrid";
import type { ReviewResult } from "../core/reviewer";
import type { DuplicateOf, TodoResult } from "../core/todo";
import type { FeedbackReport } from "../core/feedback";
import type { ActionStep, BoardFields, BoardItem, BoardRef, TriageResult } from "../core/types";

export interface Settings {
  githubToken: string;
  /** Where Jev is called: TypeSafe, or OpenRouter (the same model, billed to an OpenRouter key). */
  jevProvider: "typesafe" | "openrouter";
  typesafeApiKey: string;
  typesafeModel: string;
  openrouterApiKey: string;
  openrouterModel: string;
  /** On: writes go only to the test boards and the test repo (boards.ts `writable`, TG_TEST_REPO).
   *  Off: Apply and Accept also write to the real boards and TestGrid's issues. Only a test build has test mode
   *  (build.d.ts): it starts on there, and is always off in a normal build. */
  testMode: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  githubToken: "",
  jevProvider: "typesafe",
  typesafeApiKey: "",
  typesafeModel: "jev-latest",
  openrouterApiKey: "",
  openrouterModel: "~typesafe/jev-latest",
  testMode: __TEST_BUILD__,
};

export type Request =
  | { type: "settings.get" }
  | { type: "settings.set"; settings: Partial<Settings> }
  | { type: "settings.test" }
  | { type: "options.open" }
  | { type: "board.fields"; board: BoardRef }
  | { type: "column.items"; board: BoardRef; column: string }
  | { type: "item.lookup"; repo: string; number: number }
  | { type: "item.judge"; item: BoardItem }
  | { type: "todo.judge"; item: BoardItem }
  | { type: "todo.duplicates"; board: BoardRef; targets: BoardItem[] }
  | { type: "progress.judge"; item: BoardItem }
  | { type: "review.judge"; item: BoardItem }
  | { type: "approve.judge"; item: BoardItem }
  | { type: "author.judge"; item: BoardItem }
  | { type: "bugs.judge"; item: BoardItem }
  | { type: "info.judge"; item: BoardItem }
  | { type: "backlog.judge"; item: BoardItem }
  | { type: "backlog.duplicates"; board: BoardRef; targets: BoardItem[] }
  | { type: "dra.judge"; column: DraColumn; item: BoardItem }
  | { type: "item.apply"; board: BoardRef; restId: number; steps: ActionStep[] }
  | { type: "tg.judge"; ref: TgRef; status: "FAILING" | "FLAKY" }
  | { type: "tg.apply"; steps: TgStep[] }
  | { type: "ci.checks"; repo: string; number: number }
  | { type: "ci.judge"; repo: string; number: number; check: FailedCheck }
  | { type: "issue.scope"; repo: string; number: number }
  | { type: "issue.ci"; repo: string; number: number }
  | { type: "issue.dups"; repo: string; number: number }
  | { type: "issue.comment"; repo: string; number: number; body: string }
  | { type: "feedback.preview"; report: FeedbackReport }
  | { type: "feedback.submit"; report: FeedbackReport };

/** The judge requests: each result carries a `trace_id` naming the Jev calls behind it (feedback). */
export const TRACED = new Set<Request["type"]>([
  "item.judge",
  "todo.judge",
  "progress.judge",
  "review.judge",
  "approve.judge",
  "author.judge",
  "bugs.judge",
  "info.judge",
  "backlog.judge",
  "dra.judge",
  "tg.judge",
  "ci.judge",
  "issue.ci",
  "issue.dups",
]);

export interface ResponseMap {
  "settings.get": { settings: Settings; configured: { github: boolean; jev: boolean } };
  "settings.set": { ok: true };
  "settings.test": { github: { ok: boolean; detail: string }; jev: { ok: boolean; detail: string } };
  "options.open": { ok: true };
  "board.fields": BoardFields;
  "column.items": BoardItem[];
  "item.lookup": Placement | null;
  "item.judge": TriageResult;
  "todo.judge": TodoResult;
  /** For each target's restId, the issue it duplicates and should be closed in favour of, or null. */
  "todo.duplicates": Record<number, DuplicateOf | null>;
  "progress.judge": ProgressResult;
  "review.judge": ReviewResult;
  "approve.judge": ApproveResult;
  "author.judge": AuthorResult;
  "bugs.judge": BugResult;
  "info.judge": InfoResult;
  "backlog.judge": BacklogResult;
  /** For each target's restId, the card it duplicates and should be closed in favour of, or null. */
  "backlog.duplicates": Record<number, DuplicateOf | null>;
  "dra.judge": DraResult;
  "item.apply": { ok: true };
  "tg.judge": TgResult;
  /** What was written, as `repo#number` of each issue created or commented on. */
  "tg.apply": { wrote: string[] };
  "ci.checks": PrChecks;
  "ci.judge": CiJob;
  /** Whether the issue is one the issue page's checks cover (SIG Node or DRA). */
  "issue.scope": boolean;
  /** null when the issue is out of scope or names no job TestGrid has. */
  "issue.ci": IssueCiResult | null;
  /** null when the issue is out of scope. */
  "issue.dups": RelatedResult | null;
  /** Where the comment is, as `repo#number`: the issue, or its mirror in test mode. `already`: the thread had one,
   *  so nothing was posted. */
  "issue.comment": { wrote: string; already: boolean };
  /** Where the issue would go, its title and head, and the size of what is attached. `gist`: the attachments are too
   *  big for the issue and go to a secret gist on the reader's account. */
  "feedback.preview": {
    repo: string;
    title: string;
    head: string;
    calls: number;
    attachedKb: number;
    gist: boolean;
  };
  /** The issue opened (and the gist it links, if any), or, when the token may not open it, a prefilled new-issue page
   *  and the attachments to paste (none when it links a gist). */
  "feedback.submit":
    | { opened: string; gist?: string }
    | { opened: null; error: string; prefill: { url: string; paste: string }; gist?: string };
}

export type Response<R extends Request> = ResponseMap[R["type"]];

export type Envelope<T> = { ok: true; value: T } | { ok: false; error: string };

export function send<R extends Request>(req: R): Promise<Response<R>> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(req, (env: Envelope<Response<R>> | undefined) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!env) return reject(new Error("no response from the background worker"));
      if (env.ok) resolve(env.value);
      else reject(new Error(env.error));
    });
  });
}

/** The port a batch of requests travels over. */
export const BATCH_PORT = "batch";

/** Several requests from one click, answered one by one as each finishes (`onEach`, with the request's index), by
 *  one set of clients in the worker: what they all read (a PR and its diff, for each failed job) is read once.
 *  Resolves when every request has answered; a lost worker answers the rest with an error. */
export function sendEach<R extends Request>(
  reqs: R[],
  onEach: (i: number, env: Envelope<Response<R>>) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const answered = new Set<number>();
    const port = chrome.runtime.connect({ name: BATCH_PORT });
    port.onMessage.addListener((m: { i?: number; env?: Envelope<Response<R>>; done?: boolean }) => {
      if (m.done) {
        port.disconnect();
        resolve();
      } else if (m.i !== undefined && m.env) {
        answered.add(m.i);
        onEach(m.i, m.env);
      }
    });
    port.onDisconnect.addListener(() => {
      const why = chrome.runtime.lastError?.message ?? "the background worker stopped";
      reqs.forEach((_, i) => answered.has(i) || onEach(i, { ok: false, error: why }));
      resolve();
    });
    port.postMessage({ reqs });
  });
}

/** The Jev key and model of the chosen provider. */
export function jevSettings(s: Settings): {
  provider: Settings["jevProvider"];
  apiKey: string;
  model: string;
} {
  return s.jevProvider === "openrouter"
    ? { provider: "openrouter", apiKey: s.openrouterApiKey, model: s.openrouterModel }
    : { provider: "typesafe", apiKey: s.typesafeApiKey, model: s.typesafeModel };
}
