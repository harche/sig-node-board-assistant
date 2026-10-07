/** Shared judging state for one page: verdict per project item, and a small queue so at most a few items are
 *  judged at once. Used by the board script and the item-page script. */
import type { BoardFields, BoardItem, BoardRef, TriageResult } from "../core/types";
import { send } from "../shared/messages";

export type Slot<R = TriageResult> =
  { state: "pending" } | { state: "done"; result: R } | { state: "error"; message: string };

/** How one column's items are judged: Triage asks `item.judge`, To do `todo.judge`. */
export type JudgeFn<R> = (item: BoardItem) => Promise<R>;

export const judgeTriage: JudgeFn<TriageResult> = (item) => send({ type: "item.judge", item });

export class Judged<R = TriageResult> {
  readonly slots = new Map<number, Slot<R>>();
  fields: BoardFields | null = null;
  private queue: (() => Promise<void>)[] = [];
  private running = 0;
  private listeners = new Set<(restId: number) => void>();
  constructor(
    private concurrency = 4,
    private judgeFn: JudgeFn<R> = judgeTriage as unknown as JudgeFn<R>,
  ) {}

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

  judge(item: BoardItem): Promise<void> {
    this.slots.set(item.restId, { state: "pending" });
    this.emit(item.restId);
    return new Promise((resolve) => {
      this.queue.push(async () => {
        try {
          const result = await this.judgeFn(item);
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

  /** Replaces a settled result (e.g. with a duplicate found after judging) and tells the listeners. */
  update(restId: number, result: R): void {
    this.slots.set(restId, { state: "done", result });
    this.emit(restId);
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
