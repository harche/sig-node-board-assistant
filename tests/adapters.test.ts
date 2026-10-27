// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  FLOAT_AFTER_MS,
  findSidebar,
  itemSidebar,
  nativeButton,
  PANE_SIDEBAR,
  paneAdapter,
  placeSection,
} from "../src/content/adapters";
import { renderEvidence } from "../src/content/evidence";
import { proposedActions } from "../src/core/triage";
import type { BoardFields, BoardItem, TriageResult } from "../src/core/types";
import fixture from "./fixtures/parity.json";

const PANE = `
<div class="IssueSidebar-module__sidebarContent__HKaGK" id="side">
  <div class="Section-module__SectionContainer__DFzgf"><div class="Section-module__headerContentWrapper__gjSPk"><div><h3 class="prc-Heading">Assignees</h3><button>edit</button></div></div><div class="Section-module__childrenContainer__tpT2L">nobody</div></div>
  <div class="Section-module__SectionContainer__DFzgf"><div class="Section-module__headerContentWrapper__gjSPk"><div><h3 class="prc-Heading">Labels</h3></div></div><div class="Section-module__childrenContainer__tpT2L">x</div></div>
  <div class="Section-module__SectionContainer__DFzgf"><div class="Section-module__headerContentWrapper__gjSPk"><div class="FieldsSection-module__sectionHeaderWrapper"><h3 class="FieldsSection-module__compactSectionHeader prc-Heading">Fields</h3></div></div><div class="Section-module__childrenContainer__tpT2L"><div class="IssueFieldItem-module__issueFieldFormWrapper"><p class="IssueFieldItem-module__issueFieldLabel">Priority</p><div class="IssueFieldItem-module__issueFieldValueText" title="None yet">None yet</div></div></div></div>
  <div class="Section-module__SectionContainer__DFzgf"><div class="Section-module__headerContentWrapper__gjSPk"><div><h3 class="prc-Heading">Projects</h3></div></div><div>p</div></div>
</div>`;

const CLASSIC = `
<div id="partial-discussion-sidebar">
  <div class="discussion-sidebar-item"><h3 class="discussion-sidebar-heading text-bold">Labels</h3></div>
  <div class="discussion-sidebar-item"><h3 class="discussion-sidebar-heading text-bold">Projects</h3></div>
  <div class="discussion-sidebar-item"><h3 class="discussion-sidebar-heading text-bold">Milestone</h3></div>
</div>`;

const item: BoardItem = {
  id: "PVTI_x",
  restId: 1,
  status: "Triage",
  type: "PullRequest",
  number: 7,
  url: "https://github.com/kubernetes/kubernetes/pull/7",
  repository: "kubernetes/kubernetes",
  title: "t",
  state: "open",
  merged: false,
  draft: false,
  labels: [],
  assignees: [],
  updatedAt: "",
  closedAt: null,
};
const dec = (
  fixture.decisions as {
    answers: TriageResult["answers"];
    signals: TriageResult["signals"];
    verdict: string;
    why: string;
  }[]
)[0]!;
const result: TriageResult = {
  item_id: item.id,
  repo: item.repository,
  number: 7,
  kind: "PullRequest",
  title: "t",
  url: item.url,
  verdict: dec.verdict as TriageResult["verdict"],
  why: dec.why,
  priority: "important-longterm",
  priority_why: "default",
  lane: "PRs - Needs Reviewer",
  answers: dec.answers,
  signals: {
    ...dec.signals,
    is_draft: false,
    file_count: 2,
    test_or_ci_file_count: 1,
    test_or_ci_file_share_percent: 50,
    has_lgtm_label: false,
    blocked_labels: [],
    review_decision: null,
  },
  usage: { input_tokens: 10, cost: 0.0001 },
  state_chars: 100,
};
const fields = fixture.fields as BoardFields;
const handlers = { rejudge: async () => {} };

describe("paneAdapter", () => {
  it("clones GitHub's own section header and field row so styling is inherited", () => {
    document.body.innerHTML = PANE;
    const side = document.getElementById("side")!;
    const a = paneAdapter(side);
    const { root, body } = a.section("SIG Node board assistant");
    expect(root.className).toContain("Section-module__SectionContainer");
    expect(root.querySelector("h3")!.textContent).toBe("SIG Node board assistant");
    expect(root.querySelector("button")).toBeNull();
    expect(root.firstElementChild!.textContent).toBe("SIG Node board assistant");
    expect(body.className).toContain("childrenContainer");
    const row = a.row("Lane", "PRs - Needs Reviewer");
    expect(row.querySelector("p")!.textContent).toBe("Lane");
    expect(row.lastElementChild!.textContent).toBe("PRs - Needs Reviewer");
    expect(row.lastElementChild!.getAttribute("title")).toBeNull();
  });
  it("strips a value that lives inside the template header (the Type section)", () => {
    document.body.innerHTML = `<div class="IssueSidebar-module__sidebarContent__x" id="side">
      <div class="Section-module__SectionContainer__x"><div class="Section-module__headerContentWrapper__x"><div><h3>Type</h3><span>No type</span></div><button>x</button></div><div>No type</div></div></div>`;
    const a = paneAdapter(document.getElementById("side")!);
    const { root, body } = a.section("Ours");
    expect(root.textContent).toBe("Ours");
    expect(body.childElementCount).toBe(0);
  });
  it("falls back to plain markup when no template section exists", () => {
    document.body.innerHTML = `<div class="IssueSidebar-module__sidebarContent__x" id="side"></div>`;
    const a = paneAdapter(document.getElementById("side")!);
    expect(a.section("x").root.querySelector("h3.snba-heading")).not.toBeNull();
    expect(a.row("k", "v").className).toBe("snba-row");
  });
});

describe("PANE_SIDEBAR", () => {
  it("matches the sections container with or without the IssueSidebar-module prefix, and nothing else", () => {
    document.body.innerHTML = `<div class="IssueSidebar-module__sidebarContent__x" id="old"></div>
      <div data-testid="sticky-sidebar"><div class="sidebarContent__xBd6hp" id="new">
        <div data-testid="sidebar-labels-section"></div></div></div>
      <div class="sidebarContent__y" id="other"><div></div></div>`;
    expect([...document.querySelectorAll(PANE_SIDEBAR)].map((e) => e.id)).toEqual(["old", "new"]);
  });
});

describe("itemSidebar", () => {
  it("floats the sections, with a note, once no sidebar has been recognised for a while", () => {
    vi.useFakeTimers();
    try {
      // A PR's Files changed tab has no sidebar: nothing floats there.
      history.replaceState(null, "", "/kubernetes/kubernetes/pull/1/files");
      document.body.innerHTML = `<main></main>`;
      expect(itemSidebar(document)).toBeNull();
      vi.advanceTimersByTime(FLOAT_AFTER_MS + 1);
      expect(itemSidebar(document)).toBeNull();
      expect(document.getElementById("snba-float")).toBeNull();
      history.replaceState(null, "", "/kubernetes/kubernetes/issues/1");
      expect(itemSidebar(document)).toBeNull();
      vi.advanceTimersByTime(FLOAT_AFTER_MS + 1);
      const side = itemSidebar(document)!;
      expect(side.el.closest("#snba-float")).not.toBeNull();
      expect(document.querySelector(".snba-float-note a")!.getAttribute("href")).toContain("/issues/new?");
      const { root } = side.adapter.section("Apply");
      expect(root.querySelector("h3.snba-heading")!.textContent).toBe("Apply");
      // The real sidebar wins as soon as it is there, and the floating panel goes.
      document.body.insertAdjacentHTML("beforeend", `<div id="partial-discussion-sidebar"></div>`);
      expect(itemSidebar(document)!.el.id).toBe("partial-discussion-sidebar");
      expect(document.getElementById("snba-float")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("nativeButton", () => {
  it("copies a GitHub button that has a visual and a label, skipping ones it cannot copy", () => {
    document.body.innerHTML = `
      <button class="prc-Button-x snba-run-check"><span data-component="buttonContent"><span data-component="text">Ours</span></span></button>
      <button class="prc-Button-x mod__y"><span class="prc-C" data-component="buttonContent"><span class="prc-V" data-component="leadingVisual"></span><span class="prc-T" data-component="text">Search</span></span></button>`;
    const { root, native } = nativeButton(document, null, "Accept", "primary");
    expect(native).toBe(true);
    expect(root.className).toBe("prc-Button-x");
    expect(root.dataset.variant).toBe("primary");
  });
  it("falls back to a button styled from Primer's variables", () => {
    document.body.innerHTML = ``;
    const { root, native } = nativeButton(document, null, "Accept", "primary");
    expect(native).toBe(false);
    expect(root.className).toBe("snba-btn");
    expect(root.dataset.variant).toBe("primary");
  });
});

describe("placeSection", () => {
  it("goes after Fields in the pane and after Projects on the PR page", () => {
    document.body.innerHTML = PANE + CLASSIC;
    const pane = document.getElementById("side")!;
    const s1 = document.createElement("div");
    placeSection(pane, s1);
    expect([...pane.children].indexOf(s1)).toBe(3);
    const classic = document.getElementById("partial-discussion-sidebar")!;
    const s2 = document.createElement("div");
    placeSection(classic, s2);
    expect([...classic.children].indexOf(s2)).toBe(2);
  });
});

describe("findSidebar + renderEvidence", () => {
  it("renders the full block into the classic PR sidebar with native heading classes", () => {
    document.body.innerHTML = CLASSIC;
    const side = findSidebar(document)!;
    const el = renderEvidence(side.adapter, item, { state: "done", result, fields }, handlers);
    placeSection(side.el, el);
    expect(el.classList.contains("discussion-sidebar-item")).toBe(true);
    expect(el.querySelector("h3.discussion-sidebar-heading")!.textContent).toBe("SIG Node board assistant");
    expect(el.querySelector(".snba-verdict")!.textContent).toMatch(/Keep|Remove|Borderline/);
    expect(el.querySelectorAll(".snba-choice")).toHaveLength(2);
    expect(el.querySelector(".snba-rec")).not.toBeNull();
    expect(el.textContent).toMatch(/Jev read \d+ chars/);
    expect(el.textContent).toContain("gh project item-edit");
    expect(el.querySelectorAll("button, a")).toHaveLength(1); // only "Judge again"
  });
  it("offers only Archive, and no priority, for an item Jev says to remove", () => {
    const removed: TriageResult = { ...result, verdict: "REMOVE", priority: null, priority_why: "" };
    const p = proposedActions(item, removed, fields);
    expect(p.accept).toBeNull();
    expect(p.recommended).toBe("reject");
    document.body.innerHTML = CLASSIC;
    const el = renderEvidence(
      findSidebar(document)!.adapter,
      item,
      { state: "done", result: removed, fields },
      handlers,
    );
    expect(el.querySelectorAll(".snba-choice")).toHaveLength(1);
    expect(el.textContent).not.toContain("Urgency");
    expect(el.textContent).not.toContain("/triage accepted");
  });
  it("renders pending and error states", () => {
    document.body.innerHTML = CLASSIC;
    const side = findSidebar(document)!;
    expect(renderEvidence(side.adapter, item, { state: "pending" }, handlers).textContent).toContain(
      "asking Jev",
    );
    expect(
      renderEvidence(side.adapter, item, { state: "error", message: "boom" }, handlers).querySelector(
        ".snba-error",
      )!.textContent,
    ).toBe("boom");
  });
  it("prefers the visible pane sidebar when both are present", () => {
    document.body.innerHTML = PANE + CLASSIC;
    // jsdom has no layout: getBoundingClientRect is all zeros, so the pane is treated as hidden and classic wins
    expect(findSidebar(document)!.el.id).toBe("partial-discussion-sidebar");
    const pane = document.getElementById("side")!;
    pane.getBoundingClientRect = () => ({ width: 296 }) as DOMRect;
    expect(findSidebar(document)!.el.id).toBe("side");
  });
});
