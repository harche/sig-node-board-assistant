// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { h, itemRef, jobLink, linkifyTree, prowHistory } from "../src/content/ui";

const hrefs = (el: Element) =>
  [...el.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);

describe("linkifyTree", () => {
  it("links URLs, org/repo#N and, with the item's repo, #N", () => {
    const el = h(
      "p",
      {},
      "Fixed by kubernetes/test-infra#38166 and #142268, see https://prow.k8s.io/view/gs/b/logs/j/1. Done",
    );
    linkifyTree(el, "kubernetes/kubernetes");
    expect(hrefs(el)).toEqual([
      ["kubernetes/test-infra#38166", "https://github.com/kubernetes/test-infra/issues/38166"],
      ["#142268", "https://github.com/kubernetes/kubernetes/issues/142268"],
      ["https://prow.k8s.io/view/gs/b/logs/j/1", "https://prow.k8s.io/view/gs/b/logs/j/1"],
    ]);
    expect(el.textContent).toBe(
      "Fixed by kubernetes/test-infra#38166 and #142268, see https://prow.k8s.io/view/gs/b/logs/j/1. Done",
    );
  });
  it("keeps a reference's text as written, in the item's own repo too", () => {
    const el = linkifyTree(h("p", {}, "see kubernetes/kubernetes#7"), "kubernetes/kubernetes");
    expect(hrefs(el)).toEqual([
      ["kubernetes/kubernetes#7", "https://github.com/kubernetes/kubernetes/issues/7"],
    ]);
  });
  it("leaves links, controls, command blocks and TestGrid tabs alone, and #N without a repo", () => {
    const el = h(
      "div",
      {},
      h("a", { href: "x" }, "#1"),
      h("button", {}, "#2"),
      h("pre", {}, "gh issue view #3"),
      h("code", {}, 'Step #4 - "build" failed'),
      h("span", {}, "sig-node-release-blocking#ci-node-e2e"),
    );
    linkifyTree(el, "kubernetes/kubernetes");
    expect(el.querySelectorAll("a")).toHaveLength(1);
    const bare = linkifyTree(h("p", {}, "see #5"));
    expect(bare.querySelector("a")).toBeNull();
  });
});

describe("link helpers", () => {
  it("names an item by #N in its own repo and org/repo#N elsewhere", () => {
    expect(itemRef("kubernetes/kubernetes", 1, "kubernetes/kubernetes").textContent).toBe("#1");
    expect(itemRef("kubernetes/test-infra", 2, "kubernetes/kubernetes").textContent).toBe(
      "kubernetes/test-infra#2",
    );
  });
  it("opens a job's Prow history from its GCS path or any run's Prow page, else the fallback", () => {
    expect(prowHistory("ci-a", { gcs: "kubernetes-ci-logs/logs/ci-a" })).toBe(
      "https://prow.k8s.io/job-history/gs/kubernetes-ci-logs/logs/ci-a",
    );
    expect(prowHistory("pull-x", { gcs: "kubernetes-ci-logs/pr-logs/directory/pull-x" })).toBe(
      "https://prow.k8s.io/job-history/gs/kubernetes-ci-logs/pr-logs/directory/pull-x",
    );
    const run = "https://prow.k8s.io/view/gs/kubernetes-ci-logs/logs/ci-a/123";
    expect(prowHistory("ci-a", { runUrl: run })).toBe(
      "https://prow.k8s.io/job-history/gs/kubernetes-ci-logs/logs/ci-a",
    );
    // Another job's run says nothing about this job's bucket.
    expect(prowHistory("ci-b", { runUrl: run })).toBeNull();
    const a = jobLink("ci-c", {}, "c", "https://testgrid.k8s.io/d#c") as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe("https://testgrid.k8s.io/d#c");
  });
});
