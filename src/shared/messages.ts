/** Typed request/response protocol between the content script / options page and the background worker.
 *  Every request is a read: there is no message that mutates GitHub. */
import type { Placement } from "../core/lookup";
import type { BoardFields, BoardItem, BoardRef, TriageResult } from "../core/types";

export interface Settings {
  githubToken: string;
  typesafeApiKey: string;
  typesafeModel: string;
}

export const DEFAULT_SETTINGS: Settings = {
  githubToken: "",
  typesafeApiKey: "",
  typesafeModel: "jev-latest",
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
  | { type: "item.judge"; item: BoardItem; refresh?: boolean };

export interface ResponseMap {
  "settings.get": { settings: Settings; configured: { github: boolean; typesafe: boolean } };
  "settings.set": { ok: true };
  "settings.test": { github: { ok: boolean; detail: string }; typesafe: { ok: boolean; detail: string } };
  "options.open": { ok: true };
  "cache.clear": { removed: number };
  "board.fields": BoardFields;
  "column.items": BoardItem[];
  "item.lookup": Placement | null;
  "item.judge": TriageResult;
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
