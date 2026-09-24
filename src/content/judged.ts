/** Shared judging state for one page: verdict per project item, and a small queue so at most a few items are
 *  judged at once. Used by the board script and the item-page script. */
import type { BoardFields, BoardItem, BoardRef, TriageResult } from "../core/types";
import { send } from "../shared/messages";

export type Slot =
  { state: "pending" } | { state: "done"; result: TriageResult } | { state: "error"; message: string };

export class Judged {
  readonly slots = new Map<number, Slot>();
  fields: BoardFields | null = null;
  private queue: (() => Promise<void>)[] = [];
  private running = 0;
  private listeners = new Set<(restId: number) => void>();
  constructor(private concurrency = 4) {}

  onChange(fn: (restId: number) => void): void {
    this.listeners.add(fn);
  }

  async loadFields(board: BoardRef): Promise<BoardFields> {
    this.fields ??= await send({ type: "board.fields", board });
    return this.fields;
  }

  /** Records a failure that happened outside judge() (e.g. loading board fields) so the UI shows it. */
  fail(restId: number, message: string): void {
    this.slots.set(restId, { state: "error", message });
    this.emit(restId);
  }

  judge(item: BoardItem, refresh = false): Promise<void> {
    this.slots.set(item.restId, { state: "pending" });
    this.emit(item.restId);
    return new Promise((resolve) => {
      this.queue.push(async () => {
        try {
          const result = await send({ type: "item.judge", item, refresh });
          this.slots.set(item.restId, { state: "done", result });
        } catch (e) {
          this.slots.set(item.restId, {
            state: "error",
            message: e instanceof Error ? e.message : String(e),
          });
        }
        this.emit(item.restId);
        resolve();
      });
      this.pump();
    });
  }

  private emit(restId: number): void {
    for (const fn of this.listeners) fn(restId);
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      this.running++;
      void job().finally(() => {
        this.running--;
        this.pump();
      });
    }
  }
}
