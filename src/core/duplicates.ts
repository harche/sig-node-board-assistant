/** The duplicate passes, run after a column is judged: the CI board's To do (each card against the other open issues
 *  in To do and In progress) and the SIG Node Bugs backlog (each Triaged or High Priority card against the open cards
 *  in both). One Jev call per target card over every candidate at once, each issue with its whole evidence:
 *  description, human comments and linked PRs, which the survivor question weighs (a fix in progress, the better
 *  reproduction, more discussion). Per candidate Jev answers whether it is the same failure or bug (P at or above
 *  DUPLICATE_AT counts) and which of the two should stay open; closeDuplicates (todo.ts) groups the answers and keeps
 *  one issue per group.
 *
 *  The questions' wording and the threshold are the pairwise ones, validated pair by pair (prompts/todo.ts,
 *  prompts/backlog.ts); asked over a whole column they have not been measured again. */
import { isBot, isProwOnly } from "./boards";
import { fitMiddle, fitText, MAX_STATE_CHARS, size } from "./fit";
import type { JevClient } from "./jev";
import { refsFrom, testsFrom } from "./testgrid";
import { closeDuplicates, type DupPair, type DuplicateOf } from "./todo";
import type { BoardItem, ItemDetail, JevChoice, JevNoul, LinkedPr } from "./types";

/** Candidates per target, at most: the ones sharing the most words with it. A whole SIG Node Bugs Triaged column
 *  (about 170 cards) would leave each issue a sliver of the state guard, and the issues sharing the fewest words with
 *  the target are the least likely duplicates. Below it, every other open issue in the column is a candidate. */
export const MAX_CANDIDATES = 40;

const DAY_MS = 86_400_000;
/** Email replies quoting GitHub notifications (`***@***`) are almost always spam on k/k. */
const EMAIL_REPLY = /\*\*\*@\*\*\*/;

/** One issue as the duplicate question reads it. */
export interface DupIssue {
  repository: string;
  number: number;
  created: string;
  title: string;
  author: string;
  assignees: string[];
  /** To do only: the tests and CI jobs the issue names. */
  tests?: string[];
  jobs?: string[];
  description: string;
  human_comments: { author: string; days_ago: number; text: string }[];
  linked_prs: { pr: string; title: string; author: string; state: LinkedPr["state"]; description: string }[];
}

/** `ci`: a CI issue (To do), so the tests and jobs it names go in too. */
export function dupIssue(item: BoardItem, d: ItemDetail, prs: LinkedPr[], now: number, ci = false): DupIssue {
  const days = (iso: string) => Math.floor((now - Date.parse(iso)) / DAY_MS);
  const refs = ci ? refsFrom(d.body) : null;
  return {
    repository: item.repository,
    number: item.number,
    created: d.createdAt.slice(0, 10),
    title: d.title,
    author: d.author.login,
    assignees: item.assignees,
    ...(refs
      ? {
          tests: testsFrom(d.title, d.body),
          jobs: [...new Set([...refs.jobs, ...refs.tabs.map((t) => t.tab)])],
        }
      : {}),
    description: d.body,
    human_comments: d.comments
      .filter(
        (c) => !isBot(c.author.login) && c.body.trim() && !isProwOnly(c.body) && !EMAIL_REPLY.test(c.body),
      )
      .map((c) => ({ author: c.author.login, days_ago: days(c.createdAt), text: c.body })),
    linked_prs: prs.map((p) => ({
      pr: `${p.repository}#${p.number}`,
      title: p.title,
      author: p.author,
      state: p.state,
      description: p.body.replace(/<!--[\s\S]*?-->/g, "").trim(),
    })),
  };
}

const WORD = /[a-z0-9][a-z0-9_.-]{2,}/g;
const STOP = new Set([
  "the",
  "and",
  "for",
  "when",
  "with",
  "not",
  "are",
  "that",
  "this",
  "from",
  "pod",
  "pods",
  "kubelet",
]);

function words(s: string): Set<string> {
  return new Set((s.toLowerCase().match(WORD) ?? []).filter((w) => !STOP.has(w)));
}

/** The target's candidates: every other card of `pool`, the ones whose title and description share the most words
 *  with it first (Jaccard), at most `k`. */
export function nearest<T extends { restId: number }>(
  target: T,
  pool: T[],
  text: (x: T) => string,
  k = MAX_CANDIDATES,
): T[] {
  const a = words(text(target));
  return pool
    .filter((o) => o.restId !== target.restId)
    .map((o) => {
      const b = words(text(o));
      const inter = [...a].filter((x) => b.has(x)).length;
      return { o, j: inter / (a.size + b.size - inter || 1) };
    })
    .sort((x, y) => y.j - x.j)
    .slice(0, k)
    .map((x) => x.o);
}

/** An issue within `max` characters: past it, comments go from the middle (the first and the newest stay), then the
 *  description's middle, then each linked PR description's middle alike. */
function fitIssue(x: DupIssue, max: number): DupIssue {
  if (size(x) <= max) return x;
  const out = { ...x };
  out.human_comments = fitMiddle(
    x.human_comments,
    (kept) => size({ ...x, human_comments: kept }),
    max,
    (n) => ({
      author: "",
      days_ago: x.human_comments[n]!.days_ago,
      text: `(${n} comments left out here: the thread is too long)`,
    }),
  );
  let over = size(out) - max;
  if (over > 0) out.description = fitText(out.description, Math.max(0, out.description.length - over));
  over = size(out) - max;
  if (over > 0 && out.linked_prs.length) {
    const each = Math.ceil(over / out.linked_prs.length);
    out.linked_prs = out.linked_prs.map((p) => ({
      ...p,
      description: fitText(p.description, Math.max(0, p.description.length - each)),
    }));
  }
  return out;
}

/** The state for one target: `issue` and its candidates, each with the facts code computes against `issue`. Whole,
 *  unless that is over the guard (fit.ts): then each issue gets an even share of the room the smaller ones leave, and
 *  an issue over its share is cut (fitIssue). */
export function dupState(target: DupIssue, cands: DupIssue[], max = MAX_STATE_CHARS) {
  const facts = (c: DupIssue) => ({
    same_author: c.author === target.author,
    shared_assignee: c.assignees.some((x) => target.assignees.includes(x)),
    ...(target.jobs && c.jobs ? { shared_job: c.jobs.some((j) => target.jobs!.includes(j)) } : {}),
  });
  const build = (t: DupIssue, cs: DupIssue[]) => ({
    issue: t,
    candidates: Object.fromEntries(
      cs.map((c, k) => [`candidate_${k}`, { ...c, "precomputed (use as given)": facts(cands[k]!) }]),
    ),
  });
  const whole = build(target, cands);
  if (size(whole) <= max) return whole;
  const all = [target, ...cands];
  let room = max - (size(whole) - all.reduce((s, x) => s + size(x), 0));
  const fitted = [...all];
  all
    .map((x, i) => ({ x, i }))
    .sort((p, q) => size(p.x) - size(q.x))
    .forEach(({ x, i }, k, arr) => {
      fitted[i] = fitIssue(x, room / (arr.length - k));
      room -= size(fitted[i]);
    });
  return build(fitted[0]!, fitted.slice(1));
}

/** The duplicate and survivor questions for candidates `candidate_0` … (prompts/todo.ts, prompts/backlog.ts). */
export type DupQuestions = (keys: string[]) => Record<string, unknown>;

/** One target's call: every candidate at once, read back as one pair per candidate (`a` the target, `b` the
 *  candidate). A missing answer reads as not a duplicate. */
export async function targetPairs(
  jev: JevClient,
  target: BoardItem,
  cands: BoardItem[],
  issues: Map<number, DupIssue>,
  questions: DupQuestions,
): Promise<DupPair[]> {
  if (!cands.length) return [];
  const st = dupState(
    issues.get(target.restId)!,
    cands.map((c) => issues.get(c.restId)!),
  );
  const keys = cands.map((_, k) => `candidate_${k}`);
  const a = (await jev.ask<Record<string, JevNoul | JevChoice | undefined>>(st, questions(keys))).answers;
  return cands.map((b, k) => {
    const survivor = (a[`survivor_${k}`] as JevChoice | undefined)?.choice;
    return {
      a: target,
      b,
      // Without a survivor there is no saying which one closes: not a duplicate, rather than close the target.
      p:
        survivor === "issue" || survivor === "candidate"
          ? ((a[`duplicate_${k}`] as JevNoul | undefined)?.noul ?? 0)
          : 0,
      survivor: survivor === "issue" ? "A" : "B",
    };
  });
}

/** A whole pass: each open target against its candidates from `pool` (the open cards it may duplicate), every issue
 *  read once. `run` runs the reads and the calls (the worker caps how many at once). A pair of two targets is asked
 *  from both sides, and closeDuplicates weighs both answers. */
export async function duplicatePass(
  jev: JevClient,
  targets: BoardItem[],
  pool: BoardItem[],
  read: (i: BoardItem) => Promise<DupIssue>,
  questions: DupQuestions,
  cols?: Parameters<typeof closeDuplicates>[2],
  run: <T>(jobs: (() => Promise<T>)[]) => Promise<T[]> = (jobs) => Promise.all(jobs.map((j) => j())),
): Promise<Record<number, DuplicateOf | null>> {
  const open = targets.filter((i) => i.type === "Issue" && i.state === "open");
  const members = new Map([...pool, ...open].map((i) => [i.restId, i]));
  const issues = new Map<number, DupIssue>();
  await run([...members.values()].map((i) => async () => void issues.set(i.restId, await read(i))));
  const text = (i: BoardItem) => `${issues.get(i.restId)!.title}\n${issues.get(i.restId)!.description}`;
  const pairs = (
    await run(open.map((t) => () => targetPairs(jev, t, nearest(t, pool, text), issues, questions)))
  ).flat();
  const closing = closeDuplicates(pairs, new Set(targets.map((t) => t.restId)), cols);
  return Object.fromEntries(targets.map((t) => [t.restId, closing.get(t.restId) ?? null]));
}
