/** Which judged column of which known board holds a given issue or PR. Item pages ask this so they only decorate
 *  items that are actually up for triage. Reads the cached column listings; no new fetch unless stale. */
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
  for (const b of KNOWN_BOARDS) {
    for (const column of Object.values(b.workflows)) {
      const items = await gh.itemsIn(b, column);
      const item = items.find((i) => i.repository === repo && i.number === number);
      if (item) return { board: { owner: b.owner, number: b.number }, column, item };
    }
  }
  return null;
}
