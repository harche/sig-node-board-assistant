/** The issue page's duplicates and related issues, current and past.
 *
 *  Finding candidates is the hard part: in an offline trial on 153 SIG Node issues people marked as duplicates, a
 *  keyword search on the title found the original 12% of the time. Each source below finds different ones, so all
 *  run, in one batched GraphQL request: keyword search on the title's telling words and on the tests and jobs it
 *  names, GitHub's semantic search on the title and on the title with the body's opening, hybrid search on the
 *  title, exact search for distinctive strings (error text, Go identifiers, .go files), and the issues the thread
 *  itself links. Together they found 71%. A long thread adds its own distinctive strings.
 *
 *  Jev then reads each candidate against the issue, both with their threads (prompts/related.ts): the relation, and
 *  for a duplicate or same-root-cause match, whether one could be closed in favour of the other and what links them.
 *  Nothing here writes. */
import { isBot } from "./boards";
import type { SearchQuery, ThreadIssue } from "./github";
import type { JevClient } from "./jev";
import { RELATION_QUESTION, VERIFY_QUESTIONS } from "./prompts/related";
import { refsFrom, testsFrom } from "./testgrid";
import { fragment } from "./tgreview";
import type { ItemDetail, JevUsage } from "./types";

export const RELATIONS = [
  "duplicate",
  "same_root_cause",
  "regression",
  "part_of",
  "follow_up",
  "unrelated",
] as const;
export type Relation = (typeof RELATIONS)[number];

/** Shown as a duplicate: P(duplicate) + P(same root cause) at least this, and P(closable) at least CLOSABLE_AT. */
export const DUPLICATE_AT = 0.65;
export const CLOSABLE_AT = 0.35;
/** Shown as related: P(regression), P(part of) or P(follow-up) at least this. */
export const RELATED_AT = 0.65;
/** Candidates Jev reads, at most. */
const MAX_CANDIDATES = 50;
/** Results kept per search. */
const PER_SEARCH = 20;
/** A thread this long gets searched too: its stack traces and root-cause talk name what the body did not. */
const LONG_THREAD = 8;

export interface RelatedMatch {
  repository: string;
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  relation: Relation;
  /** Filed before the issue on the page: which way a regression or follow-up points. */
  older: boolean;
  /** P of the match: duplicate + same root cause for a duplicate, the relation's own for a related issue. */
  p: number;
  probabilities: Record<string, number>;
  /** For a duplicate: P(one could be closed in favour of the other), and the strongest link the texts show. */
  closable?: number;
  link?: string;
}

export interface RelatedResult {
  kind: "related";
  duplicates: RelatedMatch[];
  related: RelatedMatch[];
  /** Candidates Jev read. */
  asked: number;
  usage: JevUsage;
}

// ---------------------------------------------------------------------------------------------------- candidates

const STOP = new Set(
  "the and for with when from that this into after before should does not are was were has have been failing failed fails flaky flake flaking test tests job jobs issue kubernetes kubelet node pod pods e2e sig what how why can cannot doesn don't using use via".split(
    " ",
  ),
);
const words = (s: string) =>
  (s.toLowerCase().match(/[a-z0-9][a-z0-9_.-]{2,}/g) ?? []).filter((w) => !STOP.has(w));

/** Identifiers too common to tell issues apart: Ginkgo tags, Kubernetes API types every status dump prints, and the
 *  node e2e harness's files. */
const GENERIC =
  /^(?:NodeConformance|NodeFeature|Conformance|LinuxOnly|Serial|Disruptive|Slow|Flaky|Feature\w*|FeatureGate\w*|Pod(?:Status|Condition|Spec|IP|IPs|Phase)|Container(?:Status|State\w*|Port)|ResourceList|ResourceRequirements|ObjectMeta|TypeMeta|HostIP|ContainerUser|LinuxContainerUser|VolumeMount\w*|run_remote\.go|e2e_node\.go|framework\.go|util\.go|suite_test\.go)$/;

/** Strings rare enough to search verbatim: Go identifiers with two humps or a package (GetVfsStats,
 *  cm.ContainerManager), .go files, and the words after error / failed / panic, numbers, ids and paths dropped. */
export function distinctive(text: string, max = 3): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    if (s.length >= 8 && !out.includes(s) && !GENERIC.test(s)) out.push(s);
  };
  // Not a field name in a dumped struct ("LastProbeTime:", "PodStatus{"): those print on every status dump.
  for (const m of text.matchAll(
    /\b(?:[a-z]\w*\.)?[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b(?![:{])|\b[\w-]+\.go\b/g,
  ))
    add(m[0]);
  for (const m of text.matchAll(
    /(?:error|failed|Error|Failed|panic)[:=]?\s+"?([A-Za-z][^\n"{}[\]]{15,90})/g,
  )) {
    const s = m[1]!
      .replace(/[0-9a-f]{8,}|\d+|\/[\w./-]+|"/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 9)
      .join(" ");
    if (s.length >= 15) add(s);
  }
  return out.slice(0, max);
}

/** Issue numbers the text links in `repo`: `#N` and full issue URLs. */
export function xrefs(text: string, repo: string): number[] {
  const esc = repo.replace(/[.]/g, "\\.");
  const re = new RegExp(`(?:github\\.com/${esc}/issues/|(?<![\\w/])#)(\\d{2,7})\\b`, "g");
  return [...new Set([...text.matchAll(re)].map((m) => Number(m[1])))];
}

const humanComments = (cs: { author: string; body: string }[]) =>
  cs.filter((c) => !isBot(c.author) && c.body.trim() && !/^\s*\/[a-z-]+/.test(c.body.trim()));

/** Every search, tagged with its source (for tracing; the sources are merged). */
export function candidateQueries(
  repo: string,
  title: string,
  body: string,
  comments: { author: string; body: string }[],
): { source: string; query: SearchQuery }[] {
  const base = `repo:${repo} is:issue`;
  const clean = (s: string) => s.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
  const t = [...new Set(words(title.replace(/\[[^\]]*\]/g, " ")))].sort((a, b) => b.length - a.length);
  const opening = clean(body.replace(/<!--[\s\S]*?-->|```[\s\S]*?```|^#+.*$/gm, " "));
  const r = refsFrom(`${title}\n${body}`);
  const out: { source: string; query: SearchQuery }[] = [
    ...[4, 3, 2]
      .filter((k) => t.slice(0, k).length >= 2)
      .map((k) => ({ source: "keyword", query: `${base} in:title ${t.slice(0, k).join(" ")}` })),
    ...testsFrom(title, body)
      .map(fragment)
      .filter(Boolean)
      .slice(0, 2)
      .map((f) => ({ source: "test", query: `${base} "${clean(f)}"` })),
    ...[...r.jobs, ...r.tabs.map((x) => x.tab)]
      .slice(0, 2)
      .map((j) => ({ source: "job", query: `${base} "${j}"` })),
    // GitHub rejects a search over 256 characters; a [Flaking Test] title with the whole Ginkgo name gets close.
    {
      source: "semantic_title",
      query: { q: `${base} ${clean(title)}`.slice(0, 250), type: "ISSUE_SEMANTIC" },
    },
    {
      source: "semantic_body",
      query: { q: `${base} ${clean(title)} ${opening}`.slice(0, 250), type: "ISSUE_SEMANTIC" },
    },
    { source: "hybrid_title", query: { q: `${base} ${clean(title)}`.slice(0, 250), type: "ISSUE_HYBRID" } },
    ...distinctive(body).map((s) => ({ source: "distinctive", query: `${base} "${clean(s)}"` })),
  ];
  const thread = humanComments(comments);
  if (thread.length >= LONG_THREAD)
    for (const s of distinctive(thread.map((c) => c.body).join("\n"), 4))
      out.push({ source: "thread", query: `${base} "${clean(s)}"` });
  // Dedupe by the query itself: short titles make some sources ask the same thing.
  const seen = new Set<string>();
  return out.filter((x) => {
    const k = JSON.stringify(x.query);
    return !seen.has(k) && !!seen.add(k);
  });
}

/** Candidate numbers: each search's results interleaved (first of each, then second of each…), then the issues the
 *  thread links, without the issue itself, at most MAX_CANDIDATES. */
export function mergeCandidates(results: number[][], linked: number[], self: number): number[] {
  const out: number[] = [];
  const push = (n: number) => n !== self && !out.includes(n) && out.push(n);
  for (let i = 0; i < PER_SEARCH; i++) for (const r of results) if (r[i] !== undefined) push(r[i]!);
  // Linked issues first among equals: a person put them there.
  const merged = [...linked.filter((n) => n !== self), ...out.filter((n) => !linked.includes(n))];
  return [...new Set(merged)].slice(0, MAX_CANDIDATES);
}

// ---------------------------------------------------------------------------------------------------- judging

/** What Jev reads of one issue: no bots, no comment that is only a Prow command, the last 10 comments. */
function facet(x: {
  number: number;
  created: string;
  title: string;
  labels: string[];
  body: string;
  comments: { author: string; body: string }[];
}) {
  return {
    number: x.number,
    created: x.created.slice(0, 10),
    title: x.title,
    labels: x.labels.filter((l) => /^(kind|area|sig)\//.test(l)),
    body: x.body.replace(/<!--[\s\S]*?-->/g, "").slice(0, 4000),
    comments: humanComments(x.comments)
      .slice(-10)
      .map((c) => ({ author: c.author, text: c.body.slice(0, 800) })),
  };
}

/** Which bucket a candidate falls in, from its relation and (for a duplicate) its verification. */
export function classify(
  probabilities: Record<string, number>,
  closable: number | undefined,
): { bucket: "duplicate" | "related" | null; relation: Relation; p: number } {
  const pr = (k: Relation) => probabilities[k] ?? 0;
  const dup = pr("duplicate") + pr("same_root_cause");
  if (dup >= DUPLICATE_AT && (closable ?? 0) >= CLOSABLE_AT)
    return {
      bucket: "duplicate",
      relation: pr("duplicate") >= pr("same_root_cause") ? "duplicate" : "same_root_cause",
      p: dup,
    };
  const [rel, p] = (["regression", "part_of", "follow_up"] as const)
    .map((k) => [k, pr(k)] as const)
    .sort((a, b) => b[1] - a[1])[0]!;
  if (p >= RELATED_AT && dup < DUPLICATE_AT) return { bucket: "related", relation: rel, p };
  return { bucket: null, relation: "unrelated", p: pr("unrelated") };
}

/** Where a closed issue's failure is tracked now: an open duplicate, or an open newer issue reporting it came back
 *  (Jev reads a report of a fixed problem returning as a regression, not a duplicate). */
export function openDuplicate(r: RelatedResult | null): RelatedMatch | null {
  return (
    r?.duplicates.find((d) => d.state === "open") ??
    r?.related.find((d) => d.state === "open" && d.relation === "regression" && !d.older) ??
    null
  );
}

// ---------------------------------------------------------------------------------------------------- comment

/** The comment that points the thread at the matches the reader picked. Hedged on purpose: a search found them, a
 *  person decides. The issues are bare references, one per list item, which GitHub draws with their titles. */
export const RELATED_PREFIX =
  "A search of existing issues turned up some that may be duplicates of this one or related to it. They may not be, but please take a look:";
const DUP_HEAD = "Possible duplicates:";
const REL_HEAD = "Possibly related:";
/** References one comment may carry. */
export const MAX_REFS = 10;
const REF_LINE = /^- (?:[\w.-]+\/[\w.-]+)?#\d+$/;

/** `#N` in `own` (the issue's repo), `owner/repo#N` elsewhere: how the comment and the pages name an issue. */
export const shortRef = (repo: string, number: number, own: string) =>
  `${repo === own ? "" : repo}#${number}`;

export function relatedComment(
  repo: string,
  dups: { repository: string; number: number }[],
  related: { repository: string; number: number }[],
): string {
  const line = (m: { repository: string; number: number }) => `- ${shortRef(m.repository, m.number, repo)}`;
  const parts = [RELATED_PREFIX];
  if (dups.length) parts.push("", DUP_HEAD, ...dups.map(line));
  if (related.length) parts.push("", REL_HEAD, ...related.map(line));
  return parts.join("\n");
}

/** Whether `body` is a comment relatedComment drafted: its opening, its two headings, and 1 to MAX_REFS references. */
export function isRelatedComment(body: string): boolean {
  const [first, ...rest] = body.split("\n");
  if (first !== RELATED_PREFIX) return false;
  const refs = rest.filter((l) => REF_LINE.test(l));
  return (
    refs.length >= 1 &&
    refs.length <= MAX_REFS &&
    rest.every((l) => l === "" || l === DUP_HEAD || l === REL_HEAD || REF_LINE.test(l))
  );
}

/** Whether a comment already on a thread is one of these, as posted or as mirrored: one per issue is enough. */
export const isPostedRelated = (body: string) => body.startsWith(`${RELATED_PREFIX}\n`);

/** The same comment for a stand-in issue in another repo: each reference in backticks and in full, so it neither
 *  points at that repo's own issues nor shows up on the real issues' timelines. */
export function mirroredComment(body: string, repo: string): string {
  return body.replace(
    /^- ([\w.-]+\/[\w.-]+)?#(\d+)$/gm,
    (_, r: string | undefined, n: string) => `- \`${r ?? repo}#${n}\``,
  );
}

export interface RelatedDeps {
  search(queries: SearchQuery[], n?: number): Promise<{ number: number }[][]>;
  threads(repo: string, numbers: number[]): Promise<Map<number, ThreadIssue | null>>;
  jev: JevClient;
}

export async function judgeRelated(
  d: RelatedDeps,
  repo: string,
  number: number,
  detail: ItemDetail,
): Promise<RelatedResult> {
  const comments = detail.comments.map((c) => ({ author: c.author.login, body: c.body }));
  const qs = candidateQueries(repo, detail.title, detail.body, comments);
  const found = await d.search(
    qs.map((x) => x.query),
    PER_SEARCH,
  );
  const linked = xrefs([detail.body, ...comments.map((c) => c.body)].join("\n"), repo);
  const numbers = mergeCandidates(
    found.map((r) => r.map((x) => x.number)),
    linked,
    number,
  );
  const threads = await d.threads(repo, numbers);
  const me = facet({
    number,
    created: detail.createdAt,
    title: detail.title,
    labels: detail.labels.map((l) => l.name),
    body: detail.body,
    comments,
  });
  const usage: JevUsage = { input_tokens: 0, cost: 0 };
  const add = (u: JevUsage) => {
    usage.input_tokens += u.input_tokens;
    usage.cost += u.cost;
  };
  const cands = numbers.flatMap((n) => {
    const t = threads.get(n);
    return t ? [t] : [];
  });
  // Every candidate at once: rate limits are the clients' retries' job. One that still fails is left out alone.
  const judged = await Promise.all(
    cands
      .map(async (c) => {
        const them = facet({ ...c, created: c.created_at });
        // issue_A is the older of the two, as in the trial.
        const s =
          c.created_at <= detail.createdAt ? { issue_A: them, issue_B: me } : { issue_A: me, issue_B: them };
        const rel = await d.jev.ask<{ relation: { probabilities: Record<string, number> } }>(s, {
          relation: RELATION_QUESTION.relation,
        });
        add(rel.usage);
        const probabilities = rel.answers.relation?.probabilities ?? {};
        let closable: number | undefined;
        let link: string | undefined;
        if ((probabilities.duplicate ?? 0) + (probabilities.same_root_cause ?? 0) >= DUPLICATE_AT) {
          const v = await d.jev.ask<{
            closable: { noul: number };
            link: { probabilities: Record<string, number> };
          }>(s, VERIFY_QUESTIONS);
          add(v.usage);
          closable = v.answers.closable?.noul;
          const lp = v.answers.link?.probabilities ?? {};
          link = Object.entries(lp).sort((a, b) => b[1] - a[1])[0]?.[0];
        }
        return { c, probabilities, closable, link };
      })
      .map((p) => p.catch(() => null)),
  );
  const duplicates: RelatedMatch[] = [];
  const related: RelatedMatch[] = [];
  for (const j of judged) {
    if (!j) continue;
    const k = classify(j.probabilities, j.closable);
    if (!k.bucket) continue;
    const m: RelatedMatch = {
      repository: repo,
      number: j.c.number,
      title: j.c.title,
      url: j.c.url,
      state: j.c.state,
      relation: k.relation,
      older: j.c.created_at <= detail.createdAt,
      p: k.p,
      probabilities: j.probabilities,
      ...(j.closable !== undefined ? { closable: j.closable } : {}),
      ...(j.link && j.link !== "none" ? { link: j.link } : {}),
    };
    (k.bucket === "duplicate" ? duplicates : related).push(m);
  }
  duplicates.sort((a, b) => b.p - a.p);
  related.sort((a, b) => b.p - a.p);
  return { kind: "related", duplicates, related, asked: cands.length, usage };
}
