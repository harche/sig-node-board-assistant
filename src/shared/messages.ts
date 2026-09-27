/** Typed request/response protocol between the content script / options page and the background worker.
 *  Every request is a read except `item.apply`, which the worker only runs on boards marked writable. */
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
import type { ActionStep, BoardFields, BoardItem, BoardRef, TriageResult } from "../core/types";

export interface Settings {
  githubToken: string;
  /** Where Jev is called: TypeSafe, or OpenRouter (the same model, billed to an OpenRouter key). */
  jevProvider: "typesafe" | "openrouter";
  typesafeApiKey: string;
  typesafeModel: string;
  openrouterApiKey: string;
  openrouterModel: string;
  /** On (the default): writes go only to the test boards and the test repo (boards.ts `writable`, TG_TEST_REPO).
   *  Off: Apply and Accept also write to the real boards and TestGrid's issues. */
  testMode: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  githubToken: "",
  jevProvider: "typesafe",
  typesafeApiKey: "",
  typesafeModel: "jev-latest",
  openrouterApiKey: "",
  openrouterModel: "~typesafe/jev-latest",
  testMode: true,
};

export type Request =
  | { type: "settings.get" }
  | { type: "settings.set"; settings: Partial<Settings> }
  | { type: "settings.test" }
  | { type: "options.open" }
  | { type: "cache.clear" }
  | { type: "board.fields"; board: BoardRef }
  | { type: "column.items"; board: BoardRef; column: string; refresh?: boolean }
  | { type: "item.lookup"; repo: string; number: number }
  | { type: "item.judge"; item: BoardItem; refresh?: boolean }
  | { type: "todo.judge"; item: BoardItem; refresh?: boolean }
  | { type: "todo.duplicates"; board: BoardRef; targets: BoardItem[] }
  | { type: "progress.judge"; item: BoardItem; refresh?: boolean }
  | { type: "review.judge"; item: BoardItem; refresh?: boolean }
  | { type: "approve.judge"; item: BoardItem; refresh?: boolean }
  | { type: "author.judge"; item: BoardItem; refresh?: boolean }
  | { type: "bugs.judge"; item: BoardItem; refresh?: boolean }
  | { type: "info.judge"; item: BoardItem; refresh?: boolean }
  | { type: "backlog.judge"; item: BoardItem; refresh?: boolean }
  | { type: "backlog.duplicates"; board: BoardRef; targets: BoardItem[] }
  | { type: "dra.judge"; column: DraColumn; item: BoardItem; refresh?: boolean }
  | { type: "item.apply"; board: BoardRef; restId: number; steps: ActionStep[] }
  | { type: "tg.judge"; ref: TgRef; status: "FAILING" | "FLAKY"; refresh?: boolean }
  | { type: "tg.apply"; steps: TgStep[] }
  | { type: "ci.checks"; repo: string; number: number; refresh?: boolean }
  | { type: "ci.judge"; repo: string; number: number; check: FailedCheck; refresh?: boolean }
  | { type: "issue.scope"; repo: string; number: number }
  | { type: "issue.ci"; repo: string; number: number; refresh?: boolean }
  | { type: "issue.dups"; repo: string; number: number; refresh?: boolean };

export interface ResponseMap {
  "settings.get": { settings: Settings; configured: { github: boolean; jev: boolean } };
  "settings.set": { ok: true };
  "settings.test": { github: { ok: boolean; detail: string }; jev: { ok: boolean; detail: string } };
  "options.open": { ok: true };
  "cache.clear": { removed: number };
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
