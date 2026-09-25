import { describe, expect, it } from "vitest";
import { boardFromUrl, isBot, knownBoard } from "../src/core/boards";

describe("boardFromUrl", () => {
  it.each([
    ["https://github.com/orgs/kubernetes/projects/151", { owner: "kubernetes", number: 151 }],
    [
      "https://github.com/orgs/kubernetes/projects/151/views/2?pane=issue",
      { owner: "kubernetes", number: 151 },
    ],
    ["https://github.com/users/harche/projects/3", { owner: "harche", number: 3 }],
    ["https://github.com/kubernetes/kubernetes/pull/1", undefined],
    ["https://github.com/orgs/kubernetes/projects/", undefined],
  ])("%s", (url, want) => expect(boardFromUrl(url)).toEqual(want));
});

describe("knownBoard", () => {
  it("151 has the triage workflow on the Triage column", () =>
    expect(knownBoard({ owner: "kubernetes", number: 151 })?.workflows.triage).toBe("Triage"));
  it("185 and its test copy work on Triage and Needs Information", () => {
    expect(knownBoard({ owner: "kubernetes", number: 185 })?.workflows).toEqual({
      bugs: "Triage",
      info: "Needs Information",
    });
    expect(knownBoard({ owner: "harche", number: 6 })).toMatchObject({
      workflows: { bugs: "Triage" },
      writable: true,
    });
  });
  it("95 is known but has no workflow yet", () =>
    expect(knownBoard({ owner: "kubernetes", number: 95 })?.workflows).toEqual({}));
  it("a sandbox board is unknown", () => expect(knownBoard({ owner: "harche", number: 1 })).toBeUndefined());
});

describe("isBot", () => {
  it.each([
    ["k8s-ci-robot", true],
    ["dependabot[bot]", true],
    ["alice", false],
  ])("%s", (login, want) => expect(isBot(login)).toBe(want));
});

import { paneItemId } from "../src/content/dom";
describe("paneItemId", () => {
  it.each([
    [
      "https://github.com/orgs/kubernetes/projects/151/views/1?pane=issue&itemId=199530312&issue=kubernetes%7Ckubernetes%7C139659",
      199530312,
    ],
    ["https://github.com/orgs/kubernetes/projects/151", null],
    ["https://github.com/orgs/kubernetes/projects/151?pane=info", null],
  ])("%s", (url, want) => expect(paneItemId(url)).toBe(want));
});
