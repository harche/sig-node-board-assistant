// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { cardsIn, columnActions, isOurs, itemLink, placeBadge, placeRunButton } from "../src/content/dom";

const BOARD = `
<div data-board-column="Triage" id="c1">
  <div class="Container__a"><div class="Heading__b"><div class="Box__c"><h2>Triage</h2><span>4</span></div></div>
    <div class="ColumnActions__d"><button data-component="IconButton" id="menu">…</button><button data-component="IconButton">+</button></div></div>
  <div data-board-card-id="253226794" role="button">
    <div class="Box__v"><div class="Header__3M"><div class="Box_4__j"><div id="board-card-header-icon-253226794"></div><div id="board-card-header-title-253226794"><span>kubernetes #142303</span></div><div><button data-component="IconButton">…</button></div></div></div>
    <a href="https://github.com/kubernetes/kubernetes/pull/142303?x=1">title</a></div>
  </div>
  <div data-board-card-id="nope"></div>
</div>
<div data-board-column="Issues - To do">
  <div data-board-card-id="36298908"><a href="https://github.com/kubernetes/kubernetes/issues/116123">t</a></div>
</div>`;

describe("cardsIn", () => {
  it("finds cards in one column, by numeric id, with the item url", () => {
    document.body.innerHTML = BOARD;
    const cards = cardsIn(document, "Triage");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ restId: 253226794 });
    const badge = document.createElement("button");
    badge.className = "snba-badge";
    placeBadge(cards[0]!.el, badge);
    const cell = document.getElementById("board-card-header-title-253226794")!;
    expect([...cell.children].map((c) => c.className)).toEqual(["", "snba-badge"]);
  });
  it("falls back to the repo #number text, then to the card", () => {
    document.body.innerHTML = `<div data-board-card-id="1"><div><span>kubernetes #5</span></div></div><div data-board-card-id="2"><p>x</p></div>`;
    const b1 = document.createElement("i");
    placeBadge(document.querySelector('[data-board-card-id="1"]')!, b1);
    expect(b1.parentElement?.textContent).toBe("kubernetes #5");
    const b2 = document.createElement("i");
    placeBadge(document.querySelector('[data-board-card-id="2"]')!, b2);
    expect(b2.parentElement?.getAttribute("data-board-card-id")).toBe("2");
  });
  it("puts the run buttons before GitHub's column actions, found without class names", () => {
    document.body.innerHTML = BOARD;
    const col = document.getElementById("c1")!;
    expect(columnActions(col)?.className).toBe("ColumnActions__d");
    const run = document.createElement("button");
    run.className = "snba-run";
    expect(placeRunButton(col, run)).toBe(true);
    expect(run.nextElementSibling?.id).toBe("menu");
  });
  it("falls back to the column title when there are no column actions", () => {
    document.body.innerHTML = `<div data-board-column="X" id="x"><div><h2>X</h2></div></div>`;
    const run = document.createElement("button");
    expect(placeRunButton(document.getElementById("x")!, run)).toBe(true);
    expect(run.previousElementSibling?.tagName).toBe("H2");
  });
  it("escapes column names with spaces and dashes", () => {
    document.body.innerHTML = BOARD;
    expect(cardsIn(document, "Issues - To do")).toHaveLength(1);
  });
});

describe("itemLink / isOurs", () => {
  it("skips repository and avatar links and finds the issue or PR link", () => {
    document.body.innerHTML = `<div id="c"><a href="https://github.com/kubernetes/kubernetes">repo</a><a href="https://github.com/alice">av</a><a href="https://github.com/kubernetes/kubernetes/issues/9">t</a></div>`;
    expect(itemLink(document.getElementById("c")!)!.href).toContain("/issues/9");
  });
  it("recognises nodes inside our own badge, section and pill", () => {
    document.body.innerHTML = `<div class="snba-badge"><span id="a">x</span></div><div id="b"></div>`;
    expect(isOurs(document.getElementById("a")!.firstChild!)).toBe(true);
    expect(isOurs(document.getElementById("b")!)).toBe(false);
  });
});
