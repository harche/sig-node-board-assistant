import { describe, expect, it } from "vitest";
import { isDraftedComment } from "../src/core/comments";
import { changesSomething, isFixComment, suspects } from "../src/core/prowcmds";
import type { ItemDetail } from "../src/core/types";
import { withFixes } from "../src/content/workflows";

const d = (...bodies: [string, string][]): ItemDetail => ({
  title: "t",
  body: "",
  labels: [],
  state: "open",
  author: { login: "a" },
  createdAt: "2026-09-01T00:00:00Z",
  url: "u",
  comments: bodies.map(([login, body]) => ({ author: { login }, body, createdAt: "2026-09-02T00:00:00Z" })),
});

describe("suspects", () => {
  it("flags unknown commands close to a real one, bad values, and labels typed as commands", () => {
    const s = suspects(
      d(
        ["h", "/assing @ndixita"],
        ["m", "seems green now\ntriage/accept"],
        ["s", "/priority imporant-soon"],
        ["k", "/triage accept"],
      ),
    );
    expect(s.map((x) => [x.wrote, x.options[0]])).toEqual([
      ["/assing @ndixita", "assign"],
      ["triage/accept", "triage accepted"],
      ["/priority imporant-soon", "priority important-soon"],
      ["/triage accept", "triage accepted"],
    ]);
  });

  it("leaves valid commands, paths, quotes, code blocks and bots alone", () => {
    const s = suspects(
      d(
        ["h", "/assign @x\n/lgtm\n/retest"],
        ["h", "look at /usr/bin/kubelet and /var/lib/kubelet/pods"],
        ["h", "> /assing @quoted"],
        ["h", "```\n/assing @in-code\n```"],
        ["k8s-ci-robot", "/assing @bot"],
      ),
    );
    expect(s).toEqual([]);
  });
});

describe("fix comments", () => {
  it.each([
    "/assign @ndixita",
    "/triage accepted\n/priority important-soon",
    "/cc @a @b",
    "/kind flake",
    "/hold",
  ])("accepts %j", (b) => {
    expect(isFixComment(b)).toBe(true);
    expect(isDraftedComment(b)).toBe(true);
  });
  it.each([
    "/lgtm",
    "/approve",
    "/close",
    "/priority whenever",
    "/assign ndixita",
    "/assign @x please",
    "hello",
  ])("refuses %j", (b) => expect(isFixComment(b)).toBe(false));
});

describe("withFixes", () => {
  const item = { repository: "o/r", number: 1, id: "I", restId: 2 } as never;
  const r = { prow_fixes: [{ fix: "/assign @x" }, { fix: "/triage accepted" }] };
  it("posts the fixes before the action, without repeating a line the action already posts", () => {
    const steps = withFixes(item, r, [
      { kind: "comment", repo: "o/r", number: 1, body: "/triage accepted\n/priority backlog" },
    ]);
    expect(steps.map((s) => (s.kind === "comment" ? s.body : s.lane))).toEqual([
      "/assign @x",
      "/triage accepted\n/priority backlog",
    ]);
  });
  it("skips them when the action closes or archives the item", () => {
    const move = [{ kind: "move" as const, itemId: "I", restId: 2, lane: "Archive-it" }];
    expect(withFixes(item, r, move)).toEqual(move);
  });
  it("gives a card with nothing else to do a fix of its own", () => {
    expect(withFixes(item, r, [])).toHaveLength(1);
  });
});

describe("review fixes", () => {
  it("drops a fix for the same kind of label the action sets itself", () => {
    const item = { repository: "o/r", number: 1, id: "I", restId: 2 } as never;
    const r = { prow_fixes: [{ fix: "/priority important-soon" }, { fix: "/assign @x" }] };
    const steps = withFixes(item, r, [
      { kind: "comment", repo: "o/r", number: 1, body: "/triage accepted\n/priority critical-urgent" },
    ]);
    expect(steps.map((s) => (s.kind === "comment" ? s.body : ""))).toEqual([
      "/assign @x",
      "/triage accepted\n/priority critical-urgent",
    ]);
  });

  it("only changes labels that need changing", () => {
    const labels = new Set(["kind/flake", "sig/node", "do-not-merge/hold"]);
    expect(changesSomething("/kind flake", labels)).toBe(false);
    expect(changesSomething("/kind bug", labels)).toBe(true);
    expect(changesSomething("/sig node", labels)).toBe(false);
    expect(changesSomething("/remove-priority backlog", labels)).toBe(false);
    expect(changesSomething("/remove-kind flake", labels)).toBe(true);
    expect(changesSomething("/hold", labels)).toBe(false);
    expect(changesSomething("/unhold", labels)).toBe(true);
    expect(changesSomething("/assign @x", labels)).toBe(true);
  });

  it.each(["/assign", "/assign foo", "/sig node apps", "/hold cancel", "/kind flaky"])(
    "a fix the worker would refuse is never offered: %j",
    (fix) => expect(isFixComment(fix)).toBe(false),
  );
});
