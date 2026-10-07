/** Which judged column of which known board holds a given issue or PR. Item pages ask this so they only decorate
 *  items that are actually up for triage: one GraphQL read of the item's board items. */
import { KNOWN_BOARDS } from "./boards";
import type { GitHubClient } from "./github";
import type { BoardItem, BoardRef } from "./types";

export interface Placement {
  board: BoardRef;
  column: string;
  item: BoardItem;
}

export async function findOnBoards(
  gh: GitHubClient,
  repo: string,
  number: number,
): Promise<Placement | null> {
  const on = await gh.boardItems(repo, number);
  for (const b of KNOWN_BOARDS) {
    const columns: string[] = Object.values(b.workflows);
    const hit = on.find(
      (x) => x.board.owner === b.owner && x.board.number === b.number && columns.includes(x.item.status),
    );
    if (hit) return { board: { owner: b.owner, number: b.number }, column: hit.item.status, item: hit.item };
  }
  return null;
}
