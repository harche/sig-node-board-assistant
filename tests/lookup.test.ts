import { describe, expect, it } from "vitest";
import { findOnBoards } from "../src/core/lookup";
import type { GitHubClient } from "../src/core/github";
import type { BoardItem } from "../src/core/types";

const mk = (repository: string, number: number): BoardItem => ({
  id: "x",
  restId: number,
  status: "Triage",
  type: "Issue",
  number,
  url: "",
  repository,
  title: "",
  state: "open",
  merged: false,
  draft: false,
  labels: [],
  assignees: [],
  updatedAt: "",
  closedAt: null,
});

describe("findOnBoards", () => {
  const gh = {
    itemsIn: async (board: { number: number }, column: string) =>
      board.number === 151 && column === "Triage"
        ? [mk("kubernetes/kubernetes", 1), mk("kubernetes/test-infra", 2)]
        : [],
  } as unknown as GitHubClient;
  it("finds an item in a judged column", async () => {
    const p = await findOnBoards(gh, "kubernetes/test-infra", 2);
    expect(p).toMatchObject({
      board: { owner: "kubernetes", number: 151 },
      column: "Triage",
      item: { number: 2 },
    });
  });
  it("returns null for anything else", async () => {
    expect(await findOnBoards(gh, "kubernetes/kubernetes", 3)).toBeNull();
  });
});
