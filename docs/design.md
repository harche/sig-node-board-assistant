# Design

What the extension does in each place is in [workflows.md](workflows.md). This document is about why: the
architecture, the split between code and Jev, and the trials behind each policy.

## The shape

```
 board page             issue / PR page          TestGrid dashboard       settings page
 └ content script       └ content script         └ content script         └ extension page
   Tackle, badges,        board section,           Tackle, badges,          keys, provider,
   hover card, pane       Failing CI, CI           hover card               where writes go
   section                history, duplicates
        │                      │                        │                        │
        └──────── typed messages: reads, and one checked write request ──────────┘
                                         │
 background worker   keys, cache, every network call (GitHub, Jev, TestGrid, GCS), the write allow-list
        │
 src/core            pure functions: signals, state, prompts, policies; no browser APIs
```

There is little UI of our own: the column's Tackle / Accept / Cancel buttons, a badge per card, a hover card and a
status pill, all drawn with GitHub's own button classes and Primer colours. The evidence is one more section in the
sidebar GitHub already shows: the project pane for issues, the PR page for pull requests (GitHub has no PR pane; a PR
card opens a new tab). `src/content/adapters.ts` builds that section from the host page's own markup: in the React
pane it clones GitHub's "Fields" section header and field row and swaps the text, on the classic PR page it uses
`discussion-sidebar-item` and `discussion-sidebar-heading`. Colours and fonts are Primer CSS variables, so the block
follows the page's theme without a stylesheet of its own. On TestGrid the same parts take TestGrid's look: its
buttons, panel colours and status colours.

The board's content script owns nothing but DOM. It knows the board from the URL, finds cards by
`data-board-card-id` (the project item's REST id) inside `data-board-column="<column>"` for each column that has a
workflow (`src/content/workflows.ts`), and asks the background worker for the column's items and each item's verdict.
GitHub's board is a React app with hashed class names; those two data attributes are the only DOM contract, kept in
`src/content/dom.ts`.

On issue and PR pages nothing asks Jev until the reader clicks. Each section first offers its check with a button in
GitHub's own style (Judge, Check failures, Check), which reads Judge again / Check again once it has run and then
bypasses the cache. Reading the page is free (a PR's checks, an issue's labels); Jev is not, and most visits do not
need it.

The background worker holds the keys and makes every network call. `chrome.storage.local` is the cache (10 minutes
for a column, 30 for an item, forever for a Jev answer, the same TTLs as the CLI). TestGrid tables stay in the
worker's memory for 30 minutes instead: they are tens of KB each, and overflowing storage's 10 MB quota would clear
the whole cache.

## Keys and settings

Content scripts run inside github.com and testgrid.k8s.io, so they are treated as the least trusted part of the
extension:

- `chrome.storage.local` is set to `TRUSTED_CONTEXTS`: content scripts cannot read storage at all, so a bug in one
  cannot leak the token or the Jev key.
- The worker answers a content script's `settings.get` with the keys blanked; it only needs to know whether they are
  set.
- `settings.set`, `settings.test` and `cache.clear` are refused unless the sender is an extension page
  (`sender.url` under the extension's own origin), so only the settings page can change the keys.
- The settings page keeps Save disabled until the stored settings are in the form: saving the form's blanks would
  otherwise erase the keys.
- The keys go to `api.github.com` and the chosen Jev provider only, never into a URL.

## Jev providers

Jev is reached through the TypeSafe SDK's `systemOne` call, against either TypeSafe's API or OpenRouter's System One
endpoint (`https://openrouter.ai/api`, model `~typesafe/jev-latest`), which takes the same request and reports each
call's cost. The Jev answer cache is keyed by state and questions, not by provider, so switching keeps it.

## Jev decides, code computes

Jev is a decision model: it answers calibrated yes/no (noul), multiple-choice and score questions about a
JSON state. It does not generate text and it is not asked to. The split, inherited from the CLI:

- **Code computes facts** that are cheap to get right: who commented `/sig node`, whether
  `triage/accepted` is already set, the review decision, the share of changed files under test paths.
  These are shown to the reviewer and some of them override Jev (a human `/sig node` turns a REMOVE into
  BORDERLINE).
- **Jev judges** what needs reading: is the primary deliverable CI work, which SIG owns it. The prompts in
  `src/core/prompts/triage.ts` are the CLI's `prompts/triage/*.yaml`, and a test checks they still match.
- **The policy is code** (`src/core/policy.ts`): P(in scope) at or above 0.65 keeps, at or below 0.35
  removes, otherwise P(CI work) × P(node owns it) breaks the tie against the same thresholds. Two guards
  then hand the decision to a human: a REMOVE where someone wrote `/sig node` becomes BORDERLINE, and a
  KEEP where Jev is at least 0.6 confident another SIG owns the component becomes BORDERLINE. The section
  draws the band with a marker, so the reviewer sees the mechanism, not just the word.

## Issues - To do

The To-do question is whether the problem an issue tracks is already resolved. The split holds:

- **Code computes** the thread (bots, Prow-only comments and email-reply spam dropped), the PRs that link to
  the issue with their merge dates, the assignees and labels, malformed Prow commands (`triage/accept`,
  `/priority imporant-soon`), and the CI run history. `src/core/testgrid.ts` reads TestGrid's JSON (a port of
  the CLI's `lib/testgrid.py`): the tabs come from the issue's TestGrid links, or from the Prow jobs it names,
  found by name among the SIG Node and release dashboards and confirmed by the tab's GCS query. Jobs named only
  in comments are used only when the title and description name none: a job someone mentions later is often
  a different one. Per job the state carries the named tests' rows (`tracked_tests`), the job's Overall row
  (`whole_job`, which also fails for tests the issue is not about) and the runs since the latest merged
  linked PR (`runs_after_fix`). TestGrid keeps about two weeks.
- **Jev answers** `resolved` (a noul) and `resolution` (fixed by a change, went green, obsolete, still open),
  in `src/core/prompts/todo.ts`, and, for a card missing its priority label, Triage's priority question.
- **The policy is code** (`src/core/todo.ts` `decideTodo`): archive without `sig/node`, then a duplicate, then
  P(resolved) ≥ 0.65 closes as fixed, then an assignee moves the card to In progress, then 0.35–0.65 asks the
  thread, else keep. The fresh-fix guard (`freshFixGuard`) holds a close until the tracked tests (or the
  title's job when no test was found) have been quiet for 3 days and for 3× their usual gap between failures.

The question was tuned offline on 66 kubernetes/151 issues: the 35 open ones in To do and In progress, and 31
closed in the two months before, each cut just before its closing comment with TestGrid seen as of then. Of
seven wordings the one kept scored no open issue ≥ 0.65 and 8 of 15 evidenced fixes ≥ 0.65 (5 more in the ask
band); longer criteria lists and a four-question decomposition scored worse. Injecting failures after the fix
into `ci_signal` pushed every resolved issue below 0.35, so Jev reads the run history rather than a
commenter's "seems green now".

Duplicates reuse the CLI's pairwise question after judging: each To-do card against the other To-do and
In-progress issues. On 2,145 pairs of 151 issues the four pairs humans closed as duplicates scored 0.69–0.90.
Pairs at or above 0.65 are grouped and each group keeps one issue (In progress, then assigned, then Jev's
strongest survivor), so pairwise picks that go round in a circle can never close them all.

## Issues - In progress

The CLI's stale pass decided with a regex for its own nudge wording, a window of comments, a "whose court is the
PR in" heuristic and a days-quiet sum, and each misfired somewhere: a "/assign" someone posted on a PR read as a
review, so a 171-day-quiet assignee counted as active. `src/core/inprogress.ts` keeps only plain facts in code
(assignment and comment dates, each assignee's latest own comment, commit or merge, and each linked PR's last
events marked by who made them) and asks Jev, in one call per card: for each comment since an assignee last acted,
is it a check-in to them (the comment's text goes in the question itself; pointing at it by index gave false
positives); is the assignee still on it (asked only past 30 days of quiet, since Jev is unreliable at date
comparisons); is the work moving through others. Code then does only date arithmetic: a check-in under 14 days
waits, 14 or more unassigns, none nudges, and asking the thread needs P ≥ 0.65 and no active assignee.

## PRs - Needs Reviewer

`src/core/reviewer.ts`: plain rules (state, draft, the `lgtm` / `needs-rebase` / `lifecycle` labels, who put a
`/hold`, including in a review), plain facts (every comment, review, push and human review request with its author
and date; people asked by `/cc`, `/assign` or a human request; the latest @-mention ping to each), and one Jev call:
whose move it is (author, reviewers, blocked), per participant whether they are reviewing and whether they
declined, and whether a reviewer's hold condition is met. Reviews that only left inline comments are kept as events:
dropping them hid a reviewer's request from Jev.

`src/core/candidates.ts` finds reviewers. The CLI ranked OWNERS approvers near the top; tested on 662 merged 151 PRs
that was one of the weakest signals (about half had an actual reviewer in its top 3), below who reviewed recent PRs
touching the same files. The extension gathers, per touched file and top directory, the last year's merged PRs and
their reviewers (one small GraphQL query per path; one large query timed out), plus the author's own recent PRs,
blends them with OWNERS as a small bonus, and lets Jev pick three of the best eight given each candidate's counts and
the titles they reviewed lately.

## PRs - Needs Approver

`src/core/approver.ts` reuses Needs Reviewer's facts and Jev call. Asks now include comments that @-mention someone
and that Jev reads as asking them to review or approve ("@x @y for approval"): only counting `/cc` and `/assign`
proposed a new ask on a PR the board owner had asked about a week earlier. Approvers: only an approver of an OWNERS
file covering the change can approve, so Prow's notifier comment ("Needs approval from an approver in each of these
files") gives the OWNERS files still open, `candidates.ts ownersChain` their approvers up to the root, and
`blendApprovers` ranks them by recent `/approve` comments on the same files, directories and author (from the same
history query as reviewers). On 150 PRs Jev picking among the ranked approvers matched the ranking's top 3 (75% vs
74%) with a worse first pick, so unlike reviewers the order is code. `coverApprovers` makes sure every open OWNERS
file has someone on the `/cc`.

## PRs Waiting on Author

`src/core/author.ts`, on Needs Reviewer's facts and Jev call plus two things: Jev's reading of which comments since the
author's last activity are a check-in with them (as for In-progress assignees), and Triage's scope verdict (`judge()`).
On 151 the scope verdict called 11 of 22 Waiting on Author PRs not SIG Node CI work (KEPs and other SIGs' features that
had been moved past Triage); by the board owner's decision those are suggested for Archive-it. Quiet time counts from
the later of the author's own last activity and the last review, so a change request made today is not the author
going quiet. An unanswered check-in leaves the card alone: the lifecycle bot already stales, rots and closes PRs.

## SIG Node Bugs: Triage

`src/core/bugs.ts` and `src/core/prompts/bugs.ts`. Tuned on 284 kubernetes/kubernetes node issues from 2025–26, each
shown to Jev as it stood before the first human triage comment, against what that triager did (172 accepted, 43
needs-information, 24 another SIG, 21 support, 19 feature or other kind, 2 duplicates). Findings:

- Support requests separate well: P ≥ 0.7 was right 8 of 8, so Accept closes them.
- Needs information separates fairly (AUC 0.73): P(enough) ≤ 0.3 was right 5 of 7 and Accept asks; up to 0.5 it is
  suggested. More criteria (unsupported versions, working as intended, code-reading reports) did not help.
- Feature requests filed as bugs are mostly accepted anyway (16 of 29 Jev flagged), and "another SIG" splits on
  co-owned kubelet code (volumes, Windows): about half right at any threshold. Both are only suggested; the hand-over
  SIG comes from a separate question and can be changed on the card.
- DRA is not a reject: 12 of 19 DRA reports kept `sig/node` and were accepted, with `/wg device-management` added.
  That is what the extension does.
- Priority: triagers disagree with each other. A score question matched them as often as always answering
  important-longterm (39%) and caught more backlog bugs; the card has a priority select.
- Duplicates were 2 of 300 first decisions, so there is no duplicate pass yet.

A human `/sig node` keeps a hand-over from being suggested over them, as in the CI board's Triage.

## SIG Node Bugs: Needs Information

`src/core/needsinfo.ts`. On kubernetes/185 the column held 19 cards, 17 asked 57–575 days ago: 10 reporters never
answered, 7 answered and sat unread, one card was already `triage/accepted`. By the board owner's decision an answered
card is accepted from here (not sent back to Triage), and a quiet reporter is reminded once; after that the card is the
lifecycle bot's, which stales, rots and closes quiet issues (the owner's rule for every column: what the bot does, the
extension leaves alone).

Jev first missed answers: the label is often applied by a bare `/triage needs-information` after the real question, and
answers come from other users too. Giving Jev the request text and the replies separately, and counting "a maintainer
reproduced it" as answered, fixed that. On the 19 cards, against a reading of each thread: Accept would apply 14 (8
accepted, 6 reminders, all right), 5 stay the reviewer's call (partial or thin answers, two borderline), none wrongly
reminded. Dates are code: when the label went on (timeline), the reporter's last reply, the latest reminder.

## SIG Node Bugs: Triaged and High Priority

`src/core/backlog.ts` and `src/core/prompts/backlog.ts`, reusing To do's state builder (no TestGrid: product bugs),
duplicate grouping (`closeDuplicates`, now per column) and In progress's assignee reading.

- Fixed: the To-do question is about a failing test; this one about product behaviour. Evaluated on the board's
  history, each closed bug cut 10 minutes before it closed. 69 of 87 accepted bugs closed when their fix PR merged
  (nothing for the extension to do); of the 18 a person closed as fixed, P ≥ 0.8 caught 3 and P ≥ 0.5 caught 11. Of
  171 open Triaged cards, P ≥ 0.8 flagged 2 (both with the fix merged) and 0.5–0.8 flagged 13, most with the fix merged,
  a few with work left (a temporary fix, a rollout). Hence ≥ 0.8 on Accept, 0.5–0.8 the reviewer's call.
- Duplicates: every pair of a 176-card column is 15,000 questions, so each card is compared with the three whose titles
  share the most words (126 pairs on 185); two pairs scored ≥ 0.65, both plausibly the same bug.
- Assignees: of 78 quiet assignees on 49 cards, 57 had assigned themselves and 21 were owners a triager assigned, often
  maintainers holding a bug for the long run. By the board owner's decision only the self-assigned are nudged and
  unassigned (34 nudges, 5 unassigns on 185).
- Old and quiet bugs are left to the lifecycle bot, which asks for a re-triage of accepted issues untouched for a
  year. Frozen issues get the same checks: past ones were closed by people as fixed, duplicate or not SIG Node's.

## Dynamic Resource Allocation: New

`src/core/dra.ts` and `src/core/prompts/dra.ts`. kubernetes/95 documents no process (the WG's README and blog
only link the board; the columns have no descriptions), so the rules come from its track record: the Status-change
events in each item's timeline (`ProjectV2ItemStatusChangedEvent`), 485 moves out of New, about 750 of the board's
moves by pohly and 120 by nojnhuh.

- PRs: merged or closed → Done matched 56 of 60 moves; draft → In progress, otherwise In review, matched 234 of 262.
  Adding `do-not-merge/work-in-progress`, `/hold` or a "WIP" title matched fewer (214 of 262).
- Open issues are where the record is inconsistent (an open fix PR went to Ready as often as to In progress). Each
  issue was rebuilt as it stood when it was moved (thread, labels, assignees, linked PRs, release cycle):

  | approach                                                    | matched |
  | ----------------------------------------------------------- | ------- |
  | Jev picks the column (one question)                         | 105/162 |
  | the same, with their most similar past decisions as context | 102/162 |
  | Jev in two steps: under way?, then Ready or Backlog         | 95/162  |
  | assigned or has a PR → In progress, else Ready              | 88/162  |
  | majority of the five most similar past issues               | 61/162  |

  Jev's picks at 0.95 or more: In progress 37/43, Backlog 10/14, Ready 8/12. So Accept applies only In progress at
  ≥ 0.95 (86%); the rest are the reviewer's call.

## Dynamic Resource Allocation: Backlog

Same module; the PR and closed-item rules are New's. 39 moves left Backlog: 10 to Done (9 of 10 closed items went
there), KEPs to In progress in bursts at the start of each cycle, and 9 other issues in two years (5 to Ready, 4 to
In progress). sig-release's `releases/release_phases.md` says a KEP is in the current release when its issue is in the
release milestone and has `lead-opted-in`; 10 of the 13 KEPs moved from Backlog to In progress had the label. The
release in development comes from the release table in `dra.ts`, so a milestone for a past release does not count.
When 95 was first read, 10 KEPs opted into v1.38 were still in Backlog. Other issues get New's Jev question for the
bars; a move is never applied by Accept.

## Dynamic Resource Allocation: Ready

Same module. 45 moves left Ready: 12 to Done (11 closed), 28 to In progress, 8 to Backlog (mostly KEPs at a
release's end). 25 of the 28 In progress moves had an assignee, but assignment is not the trigger: cards moved weeks
after it, and two assigned in July are still in Ready. Evaluated as stay vs In progress on 94 cases (26 moves, taken
when moved; 68 stays, each stint's midpoint and every open card now), with New's question:

| Jev P(in progress) | flagged | moved then | moved later | still in Ready | other |
| ------------------ | ------- | ---------- | ----------- | -------------- | ----- |
| ≥ 0.9              | 29      | 13         | 6           | 6              | 4     |
| ≥ 0.95             | 25      | 11         | 4           | 6              | 4     |

Of the 34 stays Jev scored under 0.5, 20 stayed and 2 went to In progress. So ≥ 0.9 is suggested as the reviewer's
call (19 of 29 ended In progress), below the 85% a card needs for Accept.

## Dynamic Resource Allocation: In progress

Same module, no Jev. Moves out: closed issues → Done 35/37, merged or closed PRs → Done 19/22, open PRs ready for
review → In review 21/22, and 37 open issues to Backlog or Ready, 29 of them KEPs in batches at a release's end
(1.35 code freeze on 2025-11-07, 1.36 on 2026-03-20, after 1.37 shipped on 2026-08-25).

- Jev's question (P in progress < 0.5 as "stopped") did not separate them: non-KEP issues flagged 23, of which 21
  stayed (only 5 of 78 non-KEP stints ended before the issue closed); KEPs flagged 16, 9 left.
- The release rule on 70 KEP cases: not in the release being developed → left then 19, stayed 15. Of the 30 whose
  story has played out, 27 left (19 then, 8 a few weeks later), 2 were re-targeted, 1 closed: 90%. Accept applies it
  (the board owner's call, over leaving it to the reviewer). KEPs in the release left only at code-freeze sweeps (10),
  which the board does not mark, so they stay.
- A KEP is an issue in kubernetes/enhancements or one with a `stage/*` label.

## Dynamic Resource Allocation: In review

Same module, no Jev. Moves out: merged or closed PRs → Done 156/157, open issues → In progress 4/4, drafts → In
progress 2/3. 17 open PRs ready for review were moved out early (9 to In progress, 8 to Backlog); WIP titles, holds and
needs-rebase did not mark them (of the 49 open PRs in In review when 95 was read, 7 said WIP and 11 needed a rebase),
so open PRs stay and those moves are the reviewer's.

## TestGrid review

`src/core/tgreview.ts` (facts, evidence, decisions, drafts), `src/core/tgjudge.ts` (fetching and Jev),
`src/core/prompts/testgrid.ts`, `src/testgrid/` (the content script). Evaluated against 2026 sig/node failing-test
and flake issues in kubernetes/kubernetes; GCS keeps Prow logs about 90 days, so 28 issues (June to September) had
their runs' logs.

- Evidence is where the CLI fell short. Its junit parser read each test case's `classname` ("E2eNode Suite") as its
  name, and a build log's tail is the kubetest wrapper's traceback on every failed run. With the tail and those names
  Jev read today's jobs badly; with real names and signal lines it read them well.
- Kind of failure (test failure, suite timeout, infra) against the issues' own account: 24/26. The misses: a kubelet
  startup panic from a product change, read as infra; a run that both timed out and was OOM-killed.
- Tracking, each issue's runs against the real issue and up to 5 lookalikes (run URLs stripped): at P ≥ 0.65 the real
  issue 25/28, others 11/119, most of them duplicates people themselves linked (the same test's flake filed twice).
- Today's 37 jobs: 12 read as tracked, 11 right on reading; the kind DRA skew jobs' cause (1.33 artifacts removed)
  was tracked in kubernetes/test-infra, so test-infra is searched too.
- TestGrid marks a failed cell with several values (FAIL 12, FLAKY 13, TIMED_OUT 9, BUILD_FAIL 11, …); all count.
- Search: REST search allows 30 requests a minute even with a token; GraphQL search, several queries aliased in one
  request, costs about a point of 5,000 an hour. One request per job: a dashboard of 16 jobs in about 7 seconds.
- Related issues (root causes and umbrellas), from trials on the same 28 issues: the tracking search already found
  26 of 28 tracking issues and the issue page's sources added none, but every root cause and nearly every umbrella
  Jev named came from searching the failure's own words (error text and Go identifiers verbatim, semantic and hybrid
  search on the test and its error). A relation question (tracks, root cause, umbrella, unrelated) named 21 root
  causes and 13 umbrellas, about half and two thirds of them meaningful. A second question keeps them honest: for a
  root cause "would fixing it stop these failures?" (at ≥ 0.6 it kept the allocation manager and hugepage eviction
  bugs behind their flakes and dropped the kubectl TLS retry behind a DRA timeout), for an umbrella "does it cover
  this one?", and only open umbrellas (12 of 13 were closed, some since 2018).
- Live on sig-node-containerd: umbrellas are SIG Node's open flake and failing-test issues with broad titles
  ("Probe tests are flaking often on some jobs") that neither words nor meaning find, so Jev reads that whole pool
  outside the searches' cap. Harness rows (Node Tests) and struct field names from status dumps (`LastProbeTime:`)
  are left out of the searches. 3 of 17 jobs got a related issue: the probe umbrella #116123, and
  PodAndContainerStatsFromCRI breaking metrics (#111276) behind the alpha Summary API failure.
- Not yet: clustering jobs that fail the same way into one issue.

## Failing CI on the PR page

`src/core/prci.ts` (failed checks, verdicts, the rerun command), `src/core/prcijudge.ts` (fetching and Jev),
`src/core/prompts/prci.ts`, `src/item/ci.ts` (the sidebar section). Read-only, so tried on real kubernetes/kubernetes
PRs.

- The strongest fact is the job's record on other PRs. TestGrid's presubmit tabs (presubmits-kubernetes-blocking and
  -nonblocking, sig-node-presubmits) hold every PR's runs of a job for about a week; with `exclude-non-failed-tests`
  a blocking tab is about 2 MB instead of 7. This PR's own runs, listed from GCS, are left out by build id.
- TestGrid names a Go test's row `<classname>.<name>` (the package) and an e2e test by its Ginkgo text, so junit
  failures keep their classname. A Go case's message is "Failed" and a verify script's "see stderr for details": the
  failure's text or the case's stderr is read instead, which the TestGrid review's evidence gains too.
- Prow reports a job it could not schedule as `error` with no artifacts: that is infra, decided by code.
- Jev reads the PR's title, changed paths and per-file suspects, the failed run, this PR's runs and the record
  elsewhere. On #142200: verify (a new alpha gate on by default) and the Windows unit job (the same) as the PR's at 0.99, a probe test that
  failed on 14 of 436 other runs as a flake at 0.98, a GCE instance that could not be created as infra.
- The diff, read one file at a time. A trial on 167 recent failures of kubernetes/kubernetes PRs, labelled from each
  PR's own runs (84 failed, then passed only after the author changed the code; 83 failed, then passed on a rerun of
  the same commit), compared three ways of asking the cause:

  |                                                             | PR's: right / wrong / unsure | not the PR's: right / wrong / unsure |
  | ----------------------------------------------------------- | ---------------------------- | ------------------------------------ |
  | changed paths only                                          | 38 / 16 / 30                 | 73 / 1 / 9                           |
  | plus the hunks linked to the failure (≤20 KB)               | 40 / 15 / 29                 | 73 / 1 / 9                           |
  | plus P(could cause it) per changed file, top 5 files' hunks | 51 / 13 / 20                 | 69 / 1 / 13                          |

  Hunks picked by keyword barely helped; a question per file did, most on cmd, verify and DRA integration jobs, where the
  failure names what the PR changed. Half the diffs were over 20 KB (the largest 665 KB): per file, nothing is left
  out, each file cut at 8,000 characters. Most remaining "wrong" PR cases look mislabelled: a test that also fails on
  other PRs, which passed after an unrelated push. The cost is a Jev call per changed file (median 7).

- `/retest` reruns every failed job, so it is suggested only when none of them is the PR's.
- Not yet: posting the command, GitHub Actions checks, and the periodic
  jobs' record of the same test.

## CI history and duplicates on the issue page

`src/core/issuecheck.ts`, `src/item/issue.ts`. Read-only, tried on real kubernetes/kubernetes issues. Every question
is one the extension already asks elsewhere: To do's `resolved` and `resolution` on To do's state, the TestGrid
review's `tracks` on the newest failed run.

- The verdict uses the named test that failed most; the whole job only when the title names it, as the fresh-fix
  guard does. #142439 names `pull-kubernetes-kind-dra-all` only as where a data race showed, and that job fails half
  its runs for other reasons.
- A closed issue whose test fails again suggests `/reopen`, unless the duplicate check finds an open issue tracking
  it: #141469 (closed) fails again, and #141786 tracks it (P 0.81).
- On #141786: still failing (3 and 10 of 179 runs, the newest failure the issue's at 0.95, the fix merged 4 days
  ago and 49 of 50 runs clean since, too soon to close).

### Duplicates and related (`src/core/related.ts`, `src/core/prompts/related.ts`)

Designed from offline trials on 153 SIG Node issues people marked as duplicates ("duplicate of #N", "dup of #N" or
GitHub's marked-as-duplicate, 2016-2026), each judged as of the day it was filed, with 449 hard negatives (the top
semantic-search results that were not the original). Comments were cut before the mark, and none naming the other
issue was shown.

- Finding the original is the hard part. Found among the first 20 results: keyword search on the title 12%,
  semantic search on the title 31%, on title and body 29%, hybrid 38%, distinctive strings (error text, Go
  identifiers, .go files) 36%, the thread's own links 14%; all together 71% (about 42 candidates per issue).
  Searching the duplicate's thread added 2.6 points for 15 more candidates (duplicates are usually marked early),
  so a thread is searched only when it is long. GraphQL has `ISSUE_SEMANTIC` and `ISSUE_HYBRID` search, batched
  with the keyword ones.
- Judging: today's single duplicate question put 39% of originals at P ≥ 0.65; a relation choice (duplicate,
  same root cause, regression, part of, follow-up, unrelated) reading both threads, counting duplicate or same root
  cause, put 68% there, with 9 of 449 negatives, several of them real duplicates nobody marked. What people call a
  duplicate is often the same root cause. Splitting the question into symptom, cause and conditions did no better.
- End to end, as of each duplicate's filing: the original shown for 46% (today's search and question: about 5%),
  with 0.8 other matches per issue, about two thirds of them real. A second question on each shown match, "could
  one be closed in favour of the other?" at ≥ 0.35, removed 35 of 120 extras, mostly same-area pairs needing
  separate fixes, for 3 originals: 44%, 0.55 extras per issue. What links them (same error, test, code path,
  request, trigger) does not filter, but it is the reason shown.
- Related (regression, part of, follow-up at ≥ 0.65): 0.14 per issue, mostly real (#141469 is part of the probe
  flake umbrella #116123; the seccomp umbrella and its issue).
- The ceiling is search: 29% of originals were never found; people linked those by investigation, not by anything
  either text said.
- Live, about 40 candidates, one relation question each and a verification for the few that pass; about 9 seconds
  the first time, cached afterwards.

## Broken Prow commands

`src/core/prowcmds.ts`, for every column. The To-do version was a regex plus the closest spelling; it could not tell
prose from a command. Now code flags a line only when it looks like a command Prow does not know (a bare lowercase
`/word` close to a real one, a fixed-value command with a value not on its list, or a `label/value` line), and Jev
chooses among the nearby real commands or "not a command". On 60 open 151 threads it flagged two lines: one fixed
(`triage/accept` → `/triage accepted`), one already satisfied (the label was set another way), none spurious.

## Writes

The CLI proposes, the human approves, then the CLI executes from an allow-list. The extension does the same: the hover
card shows the action with its exact comment and move, and nothing is written until the reviewer clicks Apply (one
card) or Accept (the column's suggestions). Writes go through one message, `item.apply`, and the worker refuses it
unless:

- the board is one of the known boards in `src/core/boards.ts`;
- every move names that one project item;
- every comment is on that item's issue and is a shape the extension drafts (`src/core/comments.ts`), with no other
  Prow command and no @-mention beyond the one person a nudge or unassign is for.

TestGrid's writes (new issues, comments) go only to kubernetes/kubernetes and kubernetes/test-infra. The header's
Accept applies every suggestion in its column, comments included: clicking it means the reviewer has read the cards
and agrees.

## Parity with the reference

`tests/fixtures/parity.json` was generated once from the Python CLI and is now frozen (the generator was removed
so the extension has no Python dependency). It holds, for every item in the CLI's cache: the normalised
item, the raw detail, the computed signals, the Jev state and its Python `json.dumps` length; plus the
questions for both item types, a 328-case grid over the decision policy, all 36 PR-lane combinations and
sample command lines. `tests/parity.test.ts` runs the TypeScript over the same inputs and expects the same
outputs, down to the "why" string. Two things had to be deliberate to make that hold:

- **Number formatting.** Python's `f"{x:.2f}"` rounds the exact binary value half-to-even; JavaScript's
  `toFixed` rounds half-up and V8 mis-rounds some values (`0.665 → "0.66"`). `policy.f2()` reproduces
  Python.
- **State size.** Truncation thresholds are measured in characters of Python's `json.dumps` output, which
  has different separators and escapes non-ASCII. `state.pyJsonLength()` reproduces that length.

The Jev cache key is `sha256(stableStringify(state) + stableStringify(questions))`, so a state built in a
different key order still hits. "Judge again" re-fetches the thread and bypasses that cache.

Where the port deliberately differs from the reference: the state carries every human routing comment as
`human_routing` (the reference only sent the last 10 comments, so an early `/sig node` was invisible to the
owner question), the description-trimming loop terminates when the description is exhausted, and the
ownership guard above is restored. The Python CLI is the historical reference; this repository is where the
policy lives now.

## What the section shows and why (Triage)

Top to bottom, in the order a reviewer needs it: the verdict word and the band (the answer and the
mechanism), the one-sentence why, Jev's answers and the facts the code checked as label/value rows, then the
two things a reviewer could do with the recommended one first and marked, each with its commands behind a
disclosure. The one element that is ours rather than GitHub's is the band: it is the
policy's thresholds drawn to scale with the item's probability on it.
