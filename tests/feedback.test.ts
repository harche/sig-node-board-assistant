import { describe, expect, it } from "vitest";
import {
  code,
  fence,
  FEEDBACK_REPO,
  gistFiles,
  feedbackTitle,
  prefilled,
  renderFeedback,
  URL_BODY_LIMIT,
  type FeedbackEnv,
  type FeedbackReport,
  type Trace,
} from "../src/core/feedback";

const report: FeedbackReport = {
  text: "The reporter gave repro steps in the third comment.",
  expected: "Triaged",
  surface: "Board card · SIG Node Bugs · Triage",
  item: {
    repo: "kubernetes/kubernetes",
    number: 12345,
    url: "https://github.com/kubernetes/kubernetes/issues/12345",
  },
  shown: "Keep in Triage  Too thin to act on: @alice asked for logs",
  result: { verdict: "keep", why: "too thin", trace_id: "t1" },
  context: { Board: "kubernetes/185", Column: "Triage" },
  page: "https://github.com/orgs/kubernetes/projects/185",
};
const env: FeedbackEnv = {
  version: "0.1.2",
  commit: "abc1234",
  provider: "typesafe",
  model: "jev-latest",
  testMode: false,
  time: "2026-10-02T00:00:00Z",
};
const trace = (stateChars: number): Trace => ({
  at: "2026-10-01T00:00:00Z",
  request: { type: "bugs.judge" },
  calls: [
    {
      state: { description: "x".repeat(stateChars), note: "```inner fence```" },
      questions: { in_scope: { type: "noul" }, bucket: { type: "choice" } },
      answers: { in_scope: { noul: 0.9 } },
      cached: true,
    },
  ],
});

describe("fence and code", () => {
  it("cannot be closed by the content", () => {
    expect(fence("a ```` b")).toMatch(/^`{5}\n/);
    expect(code("a `b` c")).toBe("`` a `b` c ``");
    expect(code("plain")).toBe("`plain`");
  });
});

describe("feedbackTitle", () => {
  it("names the surface, the item, what was shown and what it should have been", () => {
    const t = feedbackTitle(report);
    expect(t).toMatch(/^\[feedback\] Board card · SIG Node Bugs · Triage kubernetes#12345: Keep in Triage/);
    expect(t).toMatch(/→ should be Triaged$/);
    expect(t.length).toBeLessThanOrEqual(140);
  });
});

describe("renderFeedback", () => {
  it("puts the words, the card, the context and every Jev call in the issue", () => {
    const out = renderFeedback(report, env, trace(100));
    expect(out.comments).toEqual([]);
    expect(out.body).toContain(report.text);
    expect(out.body).toContain("**Should have been:** `Triaged`");
    expect(out.body).toContain("0.1.2 (abc1234)");
    expect(out.body).toContain("Jev call 1/1 (in_scope, bucket; cached answer): questions");
    expect(out.body).toContain("Jev call 1/1 (in_scope, bucket; cached answer): state sent");
    expect(out.body).toContain('"trace_id": "t1"');
  });

  it("keeps item references and logins out of plain text, so nothing links or notifies", () => {
    const { body } = renderFeedback({ ...report, text: "" }, env, trace(10));
    const plain = body.replace(/(`+)[\s\S]*?\1/g, "");
    expect(plain).not.toMatch(/kubernetes\/kubernetes|#12345|@alice/);
  });

  it("writes a state or questions sent before only once", () => {
    const t = trace(100);
    t.calls.push({ ...t.calls[0]!, answers: { in_scope: { noul: 0.2 } }, cached: false });
    const { body } = renderFeedback(report, env, t);
    expect(body).toContain("Jev call 2/2 (in_scope, bucket): state sent: the same as call 1's.");
    expect(body).toContain("Jev call 2/2 (in_scope, bucket): questions: the same as call 1's.");
    expect(body).toContain("Jev call 2/2 (in_scope, bucket): answers</summary>");
  });

  it("says when no Jev calls were kept", () => {
    expect(renderFeedback(report, env, null).body).toContain("not available");
  });

  it("spills what does not fit into comments, each under the limit, cutting a big state into parts", () => {
    const out = renderFeedback(report, env, trace(150_000));
    expect(out.comments.length).toBeGreaterThan(1);
    for (const p of [out.body, ...out.comments]) expect(p.length).toBeLessThanOrEqual(60_000);
    const all = [out.body, ...out.comments].join("\n");
    expect(all).toMatch(/state sent, part 1\/3/);
    expect(all).toMatch(/state sent, part 3\/3/);
  });
});

describe("with a gist", () => {
  const gist = "https://gist.github.com/harche/abc123";

  it("is the head and the gist's link, nothing else", () => {
    const out = renderFeedback(report, env, trace(150_000), undefined, gist);
    expect(out.comments).toEqual([]);
    expect(out.body).toContain(report.text);
    expect(out.body).toContain(`secret gist on the reporter's account: ${gist}`);
    expect(out.body).toContain("`trace.json`: the 1 Jev calls");
    expect(out.body).not.toMatch(/<details>|Card result/);
    expect(out.body.length).toBeLessThan(3_000);
  });

  it("holds the whole trace as one JSON, and the issue's text", () => {
    const t = trace(150_000);
    const files = gistFiles(report, env, t);
    expect(Object.keys(files)).toEqual(["feedback.md", "result.json", "trace.json"]);
    expect(JSON.parse(files["trace.json"]!)).toEqual(t);
    expect(files["feedback.md"]).toContain(report.text);
  });

  it("leaves nothing to paste on the prefilled page", () => {
    const p = prefilled(FEEDBACK_REPO, report, env, trace(50_000), gist);
    expect(p.paste).toBe("");
    expect(new URL(p.url).searchParams.get("body")).toContain(gist);
  });
});

describe("prefilled", () => {
  it("fits the head in a URL and hands over the attachments to paste", () => {
    const p = prefilled(FEEDBACK_REPO, { ...report, text: "y".repeat(20_000) }, env, trace(50_000));
    const u = new URL(p.url);
    expect(u.pathname).toBe(`/${FEEDBACK_REPO}/issues/new`);
    expect(encodeURIComponent(u.searchParams.get("body")!).length).toBeLessThanOrEqual(URL_BODY_LIMIT);
    expect(p.paste).toContain("state sent");
    expect(p.paste.length).toBeGreaterThan(50_000);
  });
});
