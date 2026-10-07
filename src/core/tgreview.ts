/** The TestGrid review (on testgrid.k8s.io): for each FAILING or FLAKY job on a SIG Node dashboard, what fails,
 *  whether an issue tracks it, and what to do: nothing, a comment adding the job to the tracking issue, or a new
 *  issue from the kubernetes/kubernetes failing-test or flaking-test template.
 *
 *  Code computes the facts: the run history from TestGrid's table, and from each failed run's artifacts in GCS the
 *  failed junit test cases (by their real name, not the suite's classname) and the build log's signal lines
 *  (Ginkgo's failure markers and summary, timeouts and kills, or the job's last lines when no test ran). A build
 *  log's tail is the kubetest wrapper's traceback on every failed run, so it says nothing. Jev judges from those
 *  facts: what kind of failure it is, and whether each candidate issue tracks it. Evaluated on 2026-06..09 issues
 *  (docs/design.md): kind 24/26, the tracking issue found 25/28 at P ≥ 0.65. */
import type { JevChoice, JevNoul, JevUsage } from "./types";
import type { Reading } from "./readings";
import type { TgTable } from "./testgrid";

export const TRACKED_AT = 0.65;
export const MAYBE_AT = 0.35;
/** Jev's P(the thread already reports this job) at which a comment adding it would repeat it. */
export const NAMED_AT = 0.5;
/** A FLAKY job worth an issue: this many failed runs, or this share of runs (the CLI's "frequent"). */
export const FREQUENT_RUNS = 5;
export const FREQUENT_SHARE = 0.2;

export const GCS = "https://storage.googleapis.com";
export const PROW = "https://prow.k8s.io/view/gs";

// ---------------------------------------------------------------------------------------------------- job facts

/** TestGrid cell values (its TestStatus enum): passes, and every kind of failure: FAIL, FLAKY (failed, then passed
 *  on retry), TIMED_OUT, CATEGORIZED_FAIL, BUILD_FAIL, TOOL_FAIL, CATEGORIZED_ABORT. */
const PASSES = new Set([1, 2, 3, 15]);
const FAILS = new Set([5, 9, 10, 11, 12, 13, 14]);

export interface JobFacts {
  dashboard: string;
  tab: string;
  status: "FAILING" | "FLAKY";
  /** The Prow job, from the table's GCS query. */
  job: string;
  /** `bucket/prefix` of the job's runs in GCS. */
  gcs: string;
  runs: number;
  failed_runs: number;
  /** Failed runs since the last passing one, newest first. */
  streak: number;
  first_failure_days_ago: number | null;
  last_pass_days_ago: number | null;
  /** Test rows that failed in the window, most failures first; harness rows (Overall, kubetest.*) left out. */
  failing_tests: { name: string; failed: number }[];
  /** Only harness rows fail: the job breaks around its tests, not in them. */
  harness_only: boolean;
  /** The newest failed runs, newest first. */
  failed_builds: { build: string; started: number }[];
}

const expand = (st: { count: number; value: number }[]) =>
  st.flatMap((s) => Array<number>(s.count).fill(s.value));
const HARNESS =
  /(^|\.)Overall$|^kubetest\.|^Node Tests$|^Test$|^Up$|^Down$|^TearDown|^DumpClusterLogs|^Timeout$|^listResources/;
const DAY = 86_400_000;

export function jobFacts(
  dashboard: string,
  tab: string,
  status: "FAILING" | "FLAKY",
  t: TgTable,
  now: number,
  keep = 3,
): JobFacts {
  const gcs = (t.query ?? "").replace(/\/$/, "");
  const overall = t.tests.find((r) => /(^|\.)Overall$/.test(r.name));
  const cells = overall ? expand(overall.statuses) : [];
  const ids = t.column_ids ?? [];
  const failed = cells.flatMap((v, i) => (FAILS.has(v) ? [i] : []));
  let streak = 0;
  for (const v of cells) {
    if (FAILS.has(v)) streak++;
    else if (PASSES.has(v)) break;
  }
  const lastPass = cells.findIndex((v) => PASSES.has(v));
  const tests = t.tests
    .filter((r) => !HARNESS.test(r.name))
    .map((r) => ({ name: r.name, failed: expand(r.statuses).filter((v) => FAILS.has(v)).length }))
    .filter((r) => r.failed > 0)
    .sort((a, b) => b.failed - a.failed);
  const ago = (i: number) =>
    i < 0 || t.timestamps[i] === undefined ? null : Math.floor((now - t.timestamps[i]!) / DAY);
  return {
    dashboard,
    tab,
    status,
    // No query (a table TestGrid could not map to GCS): the tab name is the best name the job has.
    job: gcs.split("/").at(-1) || tab,
    gcs,
    runs: cells.length,
    failed_runs: failed.length,
    streak,
    first_failure_days_ago: failed.length ? ago(failed.at(-1)!) : null,
    last_pass_days_ago: ago(lastPass),
    failing_tests: tests.slice(0, 12),
    harness_only: failed.length > 0 && tests.length === 0,
    failed_builds: failed
      .slice(0, keep)
      .flatMap((i) => (ids[i] ? [{ build: ids[i]!, started: t.timestamps[i]! }] : [])),
  };
}

// ---------------------------------------------------------------------------------------------------- run evidence

export interface JunitFailure {
  test: string;
  /** The case's classname, when it says more than the suite ("[sig-node] k8s.io/kubernetes/pkg/kubelet.cm" for a
   *  Go package; not "E2eNode Suite"). TestGrid names a Go test's row `<classname>.<name>`. */
  classname?: string;
  message: string;
}

export interface RunEvidence {
  build: string;
  started: number;
  /** Prow's page for the run. */
  url: string;
  result: string | null;
  junit_failures: JunitFailure[];
  /** Null when the build log could not be read. */
  log_signals: string[] | null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) =>
    e[0] === "#"
      ? String.fromCodePoint(
          parseInt(
            e[1] === "x" || e[1] === "X" ? e.slice(2) : e.slice(1),
            e[1]?.toLowerCase() === "x" ? 16 : 10,
          ),
        )
      : (ENTITIES[e] ?? m),
  );
const attr = (a: string, k: string) => new RegExp(`(?:^|\\s)${k}="([^"]*)"`).exec(a)?.[1] ?? "";

/** A failure message that says nothing ("Failed", "see stderr for details"): the case's output says what failed. */
const GENERIC = /^(?:failed|failure|error|see stderr for details|)$/i;
const cdata = (s: string) =>
  unescape(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"))
    .replace(/\s+/g, " ")
    .trim();

/** Failed test cases of one junit file, by the test's `name` (not the suite's `classname`, which comes first in
 *  Ginkgo's output and names every case "E2eNode Suite"). A generic message is replaced by the failure's text, else
 *  the case's stderr (a verify script's reason is only there). */
export function junitFailures(xml: string): JunitFailure[] {
  const out: JunitFailure[] = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g)) {
    const f = /<failure\b([^>]*)>([\s\S]*?)<\/failure>|<failure\b([^>]*)\/>/.exec(m[2]!);
    if (!f) continue;
    let msg = unescape(attr(f[1] ?? f[3] ?? "", "message"))
      .replace(/\s+/g, " ")
      .trim();
    if (GENERIC.test(msg)) msg = cdata(f[2] ?? "");
    if (GENERIC.test(msg)) {
      const err = cdata(/<system-err>([\s\S]*?)<\/system-err>/.exec(m[2]!)?.[1] ?? "");
      if (err) msg = err.slice(-400);
    }
    const classname = unescape(attr(m[1]!, "classname"));
    out.push({
      test: unescape(attr(m[1]!, "name")).slice(0, 250),
      ...(classname && !/suite$/i.test(classname) ? { classname: classname.slice(0, 150) } : {}),
      message: msg.slice(0, 400),
    });
  }
  return out;
}

const SIGNAL =
  /\[FAILED\]|\[TIMEDOUT\]|\[PANICKED\]|\[INTERRUPTED\]|Ran \d+ of \d+ Specs|Test Suite Failed|^\s*(FAIL|--- FAIL)\b|^panic:|fatal error:|A suite timeout occurred|kubetest --timeout|did not finish before|Entrypoint received interrupt|signal: killed|Boskos|could not (create|find) instance|failed to (create|start) (cluster|node|instance)|timed out waiting for the condition|error: timed out/;
const NOISE =
  /^\s*File "|^\s*raise |^\+ |check_call|CalledProcessError|^\s*$|ENTRYPOINT_OPTIONS|JOB_SPEC|^Run: /;
const TEST_OUTPUT = /\[FAILED\]|\[TIMEDOUT\]|Ran \d+ of \d+ Specs|--- FAIL/;
const END = /^\+ atexit|EXIT_VALUE=|Cleaning up after docker|CalledProcessError/;

/** The lines of a build log that say what failed, deduplicated, about `cap` characters in all. */
export function signalLines(log: string, cap = 5000): string[] {
  const lines = log.split("\n");
  const seen = new Set<string>();
  const out: string[] = [];
  let n = 0;
  const add = (line: string) => {
    const key = line
      .trim()
      .replace(/[0-9a-f]{6,}|\d+/g, "#")
      .slice(0, 160);
    if (seen.has(key) || NOISE.test(line)) return;
    seen.add(key);
    const s = line.trim().slice(0, 300);
    out.push(s);
    n += s.length;
  };
  for (let i = 0; i < lines.length && n <= cap; i++) {
    const line = lines[i]!;
    if (/Summarizing \d+ Failure/.test(line)) lines.slice(i, i + 25).forEach(add);
    else if (SIGNAL.test(line)) add(line);
  }
  if (!out.some((l) => TEST_OUTPUT.test(l))) {
    // No test output: the job died before or around its tests. Its last words before cleanup say why.
    let end = lines.findIndex((l) => END.test(l));
    if (end < 0) end = lines.length;
    for (const l of lines.slice(Math.max(0, end - 25), end))
      if (l.trim() && !/^\s*File "|^\s*raise /.test(l)) out.push(l.trim().slice(0, 300));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- candidates

export interface Candidate {
  repo: string;
  number: number;
  title: string;
  state: "open" | "closed";
  closed_at: string | null;
  url: string;
  body: string;
  /** Last activity (GitHub's updatedAt); null when the search did not say. */
  updated_at: string | null;
  /** How it was found: job name, tab name, test name, label pool. */
  via: string;
}

/** A searchable piece of a test name: its longest bracket-free run of three or more words. */
export function fragment(name: string): string {
  const s = name
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/^[\w.-]+ Suite\.?|E2eNode Suite|Kubernetes e2e suite/g, " ");
  const runs = s
    .split(/[[\]().:/"]+/)
    .map((r) => r.trim())
    .filter((r) => r.split(/\s+/).length >= 3);
  if (!runs.length) return "";
  return (
    runs
      .reduce((a, b) => (b.length > a.length ? b : a))
      .replace(/\s+/g, " ")
      .trim()
      // Whole words only: a quoted search for a cut-off word matches nothing. A first word over 60 characters is cut.
      .replace(/^(.{0,60})(?:\s.*)?$/, "$1")
      .slice(0, 60)
      .trim()
  );
}

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);

/** Label-pool issues that share at least three words with the job and its failing tests. */
export function poolMatches(f: JobFacts, pool: Candidate[], min = 3): Candidate[] {
  const w = words([f.job, ...f.failing_tests.slice(0, 2).map((t) => t.name)].join(" "));
  return pool.filter((c) => {
    const v = words(`${c.title} ${c.body.slice(0, 800)}`);
    let k = 0;
    for (const x of w) if (v.has(x)) k++;
    return k >= min;
  });
}

/** Run URLs and build ids in an issue are stripped before Jev reads it, so a matching id cannot decide. */
export const stripRuns = (b: string) =>
  b
    .replace(/https?:\/\/prow\.k8s\.io\/view\/\S+/g, "<prow run>")
    .replace(/https?:\/\/storage\.googleapis\.com\/\S+/g, "<gcs>")
    .replace(/\d{15,}/g, "<id>");

// ---------------------------------------------------------------------------------------------------- result

export interface Track {
  repo: string;
  number: number;
  title: string;
  state: "open" | "closed";
  url: string;
  via: string;
  p: number;
  /** The issue already reports this job: for a likely tracking issue, Jev reading its whole thread (ours included,
   *  and in test mode its mirror's); for the rest, the job or tab name in its body. */
  names_job: boolean;
  /** Last activity; absent in older results. */
  updated_at?: string | null;
}

export interface TgResult {
  kind: "tg";
  facts: JobFacts;
  evidence: RunEvidence[];
  failure_kind: JevChoice | null;
  /** Candidates with Jev's P(tracks), highest first. */
  tracks: Track[];
  /** Issues the failure's own words found that cause it or group it (relatedRuns); absent in older results. */
  related?: TgRelated[];
  readings?: Reading[];
  usage: JevUsage;
}

/** An issue beyond the tracking one: a bug that causes this failure, or an open umbrella it belongs to. */
export interface TgRelated {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  kind: "root_cause" | "umbrella";
  /** Jev's P of the relation, and of the verification (fixing it would stop these failures; it covers them). */
  p: number;
  verify: number;
}

/** Umbrella candidates: SIG Node's open flake and failing-test issues. Their titles are broad ("Probe tests are
 *  flaking often on some jobs"), so neither a test's words nor its meaning find them; Jev reads the whole open pool,
 *  outside the searches' cap. */
export function umbrellaPool(repo: string): string[] {
  return ["kind/flake", "kind/failing-test"].map(
    (l) => `repo:${repo} is:issue is:open label:sig/node label:${l}`,
  );
}

/** A relation counts from this P, and is shown when its verification is at least VERIFY_AT: "fixing it would stop
 *  these failures" for a root cause, "it covers this failure" for an umbrella. The good root causes tried verified
 *  at 0.69-0.81, the doubtful ones at 0.50-0.56. */
export const RELATED_AT = 0.65;
export const VERIFY_AT = { root_cause: 0.6, umbrella: 0.5 } as const;
/** A closed root cause is shown this long after it closed: its fix may be why the failure stops, or not yet. */
export const ROOT_CAUSE_CLOSED_DAYS = 60;

/** Whether a candidate is worth reading for a relation: an open issue, or a root cause closed recently. A closed
 *  umbrella groups failures that are over. */
export function relatedEligible(state: "open" | "closed", closedAt: string | null, now: number): boolean {
  return state === "open" || (!!closedAt && now - Date.parse(closedAt) <= ROOT_CAUSE_CLOSED_DAYS * DAY);
}

/** The searches for issues related to a failure: its distinctive strings verbatim (error text, Go identifiers,
 *  .go files, from the junit messages and log lines), and semantic and hybrid search on the failing test and its
 *  first error. */
export function relatedQueries(
  repo: string,
  e: Pick<RunEvidence, "junit_failures" | "log_signals">[],
  /** The job's failing tests, harness rows left out (JobFacts.failing_tests), most failures first. */
  tests: string[],
  job: string,
  distinctive: (text: string, max: number) => string[],
): ({ q: string; type: "ISSUE_SEMANTIC" | "ISSUE_HYBRID" } | string)[] {
  const base = `repo:${repo} is:issue`;
  const clean = (x: string) => x.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
  // The harness's own rows (Node Tests, Overall, kubetest.*) fail around every test: they say nothing.
  const real = (j: { test: string }) => !HARNESS.test(j.test);
  const text = e
    .flatMap((r) => [...r.junit_failures.filter(real).map((j) => j.message), ...(r.log_signals ?? [])])
    .join("\n");
  const firstErr =
    e.flatMap((r) => r.junit_failures.filter(real)).find((j) => j.message)?.message ??
    e[0]?.log_signals?.find((l) => /FAILED|error/i.test(l)) ??
    "";
  const name = (t: string) => clean(t.replace(/^[\w.-]+ Suite\.?\s*/, "").replace(/\[[^\]]*\]/g, " "));
  const probe = clean(`${tests[0] ? name(tests[0]) : job} ${firstErr.slice(0, 120)}`);
  return [
    ...distinctive(text, 4).map((x) => `${base} "${clean(x)}"`),
    // Each failing test by its name alone: an umbrella names tests, not their errors.
    ...tests
      .slice(0, 2)
      .map((t) => ({ q: `${base} ${name(t)}`.slice(0, 250), type: "ISSUE_SEMANTIC" as const })),
    { q: `${base} ${probe}`.slice(0, 250), type: "ISSUE_SEMANTIC" },
    { q: `${base} ${probe}`.slice(0, 250), type: "ISSUE_HYBRID" },
  ];
}

export type TgVerdict = "tracked" | "regression" | "maybe" | "untracked";

export function verdict(r: TgResult): { verdict: TgVerdict; issue: Track | null } {
  const top = r.tracks[0] ?? null;
  if (!top || top.p < MAYBE_AT) return { verdict: "untracked", issue: null };
  if (top.p < TRACKED_AT) return { verdict: "maybe", issue: top };
  // Several open issues track it. One that already reports the job wins (highest score first): commenting on another
  // would report it twice. Otherwise the one with the most recent activity, the one people follow.
  const tracking = r.tracks.filter((t) => t.state === "open" && t.p >= TRACKED_AT);
  const open =
    tracking.find((t) => t.names_job) ??
    [...tracking].sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))[0];
  if (open) return { verdict: "tracked", issue: open };
  return { verdict: "regression", issue: top };
}

export const TG_ACTIONS = ["keep", "comment", "file"] as const;
export type TgAction = (typeof TG_ACTIONS)[number];

export const TG_LABEL: Record<TgAction, string> = {
  keep: "Nothing to do",
  comment: "Comment on the tracking issue",
  file: "File a new issue",
};

export const TG_TINT: Record<TgAction, "KEEP" | "REMOVE" | "BORDERLINE" | "MOVE"> = {
  keep: "KEEP",
  comment: "MOVE",
  file: "REMOVE",
};

export function frequent(f: JobFacts): boolean {
  return f.failed_runs >= FREQUENT_RUNS || (f.runs > 0 && f.failed_runs / f.runs >= FREQUENT_SHARE);
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

/** The suggested action, why, and whether the header's Accept applies it without the reviewer picking it. */
export function decideTg(r: TgResult): { action: TgAction; why: string; auto: boolean } {
  const v = verdict(r);
  const f = r.facts;
  const ref = (t: Track) => `${t.repo === "kubernetes/kubernetes" ? "" : t.repo}#${t.number}`;
  switch (v.verdict) {
    case "tracked":
      return v.issue!.names_job
        ? { action: "keep", why: `tracked by ${ref(v.issue!)} (${pct(v.issue!.p)})`, auto: true }
        : {
            action: "comment",
            why: `tracked by ${ref(v.issue!)} (${pct(v.issue!.p)}), which does not name ${f.job} yet`,
            auto: true,
          };
    case "regression":
      return {
        action: "file",
        why: `matches ${ref(v.issue!)} (${pct(v.issue!.p)}), closed: a regression, or a new failure that looks alike`,
        auto: false,
      };
    case "maybe":
      if (v.issue!.names_job)
        return {
          action: "keep",
          why: `maybe tracked by ${ref(v.issue!)} (${pct(v.issue!.p)}), which already names ${f.job}`,
          auto: false,
        };
      return {
        action: "comment",
        why: `maybe tracked by ${ref(v.issue!)} (${pct(v.issue!.p)}): read it before commenting`,
        auto: false,
      };
    case "untracked":
      if (f.status === "FAILING")
        return { action: "file", why: "failing, and no issue tracks it", auto: true };
      return frequent(f)
        ? {
            action: "file",
            why: `flaky in ${f.failed_runs} of ${f.runs} runs and no issue tracks it`,
            auto: false,
          }
        : {
            action: "keep",
            why: `flaky in ${f.failed_runs} of ${f.runs} runs: not yet worth an issue`,
            auto: true,
          };
  }
}

export function tgActions(r: TgResult): TgAction[] {
  return r.tracks.length ? ["keep", "comment", "file"] : ["keep", "file"];
}

// ---------------------------------------------------------------------------------------------------- drafts

export const TESTGRID_URL = "https://testgrid.k8s.io";
const tabUrl = (f: JobFacts) => `${TESTGRID_URL}/${f.dashboard}#${encodeURIComponent(f.tab)}`;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/** Where TestGrid writes go in test mode: new issues are opened here, and a comment meant for another repo's issue
 *  goes on a "[mirror] <repo>#<n>" issue here. Nothing is written anywhere else. Empty outside test builds. */
export const TG_TEST_REPO = __TEST_BUILD__ ? "harche/sig-node-board-test" : "";
/** With test mode off, the only repos TestGrid writes go to: where its issues are filed and tracked. */
export const TG_LIVE_REPOS = ["kubernetes/kubernetes", "kubernetes/test-infra"];
/** A title search that fits GitHub's 256-character query limit, with the ` sort:` searchIssues adds: the title's
 *  words without quotes (search has no escape for them), cut at a word to fit. The exact title is matched after. */
export function titleQuery(repo: string, title: string): string {
  const head = `repo:${repo} is:issue is:open in:title `;
  const room = 256 - head.length - " sort:updated-desc".length - 2;
  let words = title.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
  if (words.length > room) words = words.slice(0, room).replace(/\s+\S*$/, "");
  return `${head}"${words}"`;
}

/** Prow commands for a new issue's labels: GitHub drops labels set at creation unless the author can push to the
 *  repo, and on kubernetes/kubernetes labels go through Prow. `sig/node` -> `/sig node`. */
export function prowLabels(labels: string[]): string {
  return labels.map((l) => `/${l.replace("/", " ")}`).join("\n");
}

export const mirrorTitle = (repo: string, number: number) => `[mirror] ${repo}#${number}`;

/** Marks every body this extension drafts, so the write path can tell its own from anything else. */
export const TG_MARK = "<!-- sig-node-board-assistant: testgrid -->";

export type TgStep =
  /** `names`: the job and its tab. Apply skips the comment when one of this extension's own comments there already
   *  names one of them (an earlier Apply); whether anyone else reported the job is Jev's call when judging. */
  | { kind: "comment"; repo: string; number: number; body: string; names: string[] }
  | { kind: "issue"; repo: string; title: string; body: string; labels: string[] };

function evidenceLines(r: TgResult): string[] {
  return r.evidence.slice(0, 3).map((e) => {
    const first =
      e.junit_failures[0]?.test ||
      (e.log_signals ?? []).find((l) => /\[FAILED\]|\[TIMEDOUT\]|Test Suite Failed/.test(l)) ||
      (e.log_signals ?? []).at(-1) ||
      "no test output";
    return `- [${day(e.started)}](${e.url}): ${first.slice(0, 200)}`;
  });
}

export function commentBody(r: TgResult): string {
  const f = r.facts;
  return [
    TG_MARK,
    `This also ${f.status === "FAILING" ? "fails" : "flakes"} on \`${f.job}\` ([TestGrid](${tabUrl(f)})): ${f.failed_runs} of the last ${f.runs} runs, ${f.streak} in a row now.`,
    "",
    ...evidenceLines(r),
  ].join("\n");
}

function title(r: TgResult): string {
  const f = r.facts;
  const what =
    f.harness_only || !f.failing_tests.length
      ? f.job
      : `${f.failing_tests[0]!.name.replace(/^[\w.-]+ Suite\.?\s*/, "")}`;
  return `${f.status === "FAILING" ? "[Failing Test]" : "[Flaking Test]"} ${what}`.slice(0, 200);
}

export function issueBody(r: TgResult): string {
  const f = r.facts;
  const verb = f.status === "FAILING" ? "failing" : "flaking";
  const kind = r.failure_kind?.choice;
  const tests =
    f.harness_only || !f.failing_tests.length
      ? "No test fails on its own: the job fails around its tests (see below)."
      : f.failing_tests
          .slice(0, 8)
          .map((t) => `- ${t.name} (${t.failed} failed runs)`)
          .join("\n");
  const since = [
    f.first_failure_days_ago !== null
      ? `First failure in TestGrid's window: ${f.first_failure_days_ago} days ago.`
      : "",
    `${f.failed_runs} of the last ${f.runs} runs failed; ${f.streak} in a row now.`,
    f.last_pass_days_ago !== null ? `Last pass: ${f.last_pass_days_ago} days ago.` : "No pass in the window.",
  ]
    .filter(Boolean)
    .join(" ");
  const signals = r.evidence
    .flatMap((e) => (e.log_signals ?? []).filter((l) => !/^\[FAIL\]|Ran \d+ of/.test(l)).slice(0, 6))
    .slice(0, 12);
  return [
    TG_MARK,
    `### Which jobs are ${verb}?`,
    "",
    `\`${f.job}\``,
    "",
    `### Which tests are ${verb}?`,
    "",
    tests,
    "",
    `### Since when has it been ${verb}?`,
    "",
    since,
    "",
    "### Testgrid link",
    "",
    tabUrl(f),
    "",
    "### Reason for failure (if possible)",
    "",
    kind === "suite_timeout"
      ? "The suite or job runs out of time; the tests it interrupts vary, so they are not the failure."
      : kind === "infra"
        ? "The environment or the job's setup breaks, not a test."
        : "A test fails on its own assertion or wait.",
    "",
    "```",
    ...signals,
    "```",
    "",
    "### Anything else we need to know?",
    "",
    "Recent failed runs:",
    ...evidenceLines(r),
    "",
    "### Relevant SIG(s)",
    "",
    "/sig node",
  ].join("\n");
}

export function tgSteps(r: TgResult, action: TgAction, target?: Track | null): TgStep[] {
  if (action === "keep") return [];
  if (action === "comment") {
    const t = target ?? verdict(r).issue ?? r.tracks[0];
    const names = [...new Set([r.facts.job, r.facts.tab].filter(Boolean))];
    return t ? [{ kind: "comment", repo: t.repo, number: t.number, body: commentBody(r), names }] : [];
  }
  return [
    {
      kind: "issue",
      repo: "kubernetes/kubernetes",
      title: title(r),
      body: issueBody(r),
      labels: [r.facts.status === "FAILING" ? "kind/failing-test" : "kind/flake", "sig/node"],
    },
  ];
}

export function isTgDraft(body: string): boolean {
  return body.startsWith(`${TG_MARK}\n`);
}

/** `text` names `name` as a whole job or tab name: `ci-kubernetes-node-e2e` is not named by
 *  `ci-kubernetes-node-e2e-containerd`. */
export function namesWhole(text: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w.-])${esc}(?![\\w-]|\\.\\w)`).test(text);
}

// ---------------------------------------------------------------------------------------------------- Jev answers

export type TgAnswers = { failure_kind: JevChoice };
export type TrackAnswer = { tracks: JevNoul };
