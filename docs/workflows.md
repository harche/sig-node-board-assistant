# Workflows

What the extension suggests in each place it works, and when. For why each rule is shaped the way it is, and the
trials behind the thresholds, see [design.md](design.md).

Every suggestion follows the same split: **code computes the facts** (labels, dates, review state, run history),
**Jev answers the judgement calls** (calibrated probabilities, never generated text), and **a written policy** turns
those into one action with a one-sentence reason. Nothing is written until you click Apply on a card or Accept on
a column.

- [SIG Node CI/Test board](#sig-node-citest-board-kubernetes151)
  - [Triage](#triage) · [Issues - To do](#issues---to-do) · [Issues - In progress](#issues---in-progress) ·
    [PRs - Needs Reviewer](#prs---needs-reviewer) · [PRs - Needs Approver](#prs---needs-approver) ·
    [PRs Waiting on Author](#prs-waiting-on-author)
- [SIG Node Bugs board](#sig-node-bugs-board-kubernetes185)
  - [Triage](#triage-1) · [Needs Information](#needs-information) ·
    [Triaged and High Priority](#triaged-and-high-priority)
- [Dynamic Resource Allocation board](#dynamic-resource-allocation-board-kubernetes95)
  - [New](#new) · [Backlog](#backlog) · [Ready](#ready) · [In progress](#in-progress) · [In review](#in-review)
- [Every column](#every-column): broken Prow commands, the lifecycle bot
- [TestGrid review](#testgrid-review)
- [Failing CI on a pull request](#failing-ci-on-a-pull-request)
- [CI history and duplicates on an issue](#ci-history-and-duplicates-on-an-issue)
- [What Apply and Accept may write](#what-apply-and-accept-may-write)

## SIG Node CI/Test board (kubernetes/151)

### Triage

Does the item belong on the board, and at which priority?

- Jev reads the thread and the changed files: is it in scope, what kind of work it is (a failing or flaking test,
  CI infrastructure, a product change), which SIG owns it, and how urgent it is.
- The policy keeps at P(in scope) ≥ 0.65 and removes at ≤ 0.35. In between, P(CI work) × P(SIG Node owns it) breaks
  the tie against the same thresholds.
- Two guards hand the decision back to you:
  - a removal where a person wrote `/sig node` becomes borderline;
  - a keep where Jev is at least 0.6 sure another SIG owns the code becomes borderline.
- **Accept** comments `/triage accepted` with Jev's priority (editable on the card) and moves the card to its lane.
  **Archive** moves it to Archive-it.

### Issues - To do

Accepted issues nobody is working on yet. Earlier rows win:

| Action              | When                                                                     | What Apply does                                                    |
| ------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Archive             | the issue has no `sig/node` label                                        | move to Archive-it                                                 |
| Close as duplicate  | Jev says it tracks the same failure as another To-do or In-progress card | comment naming the issue that stays + `/close`, move to Archive-it |
| Close as fixed      | P(resolved) ≥ 0.65 and the fresh-fix guard agrees                        | comment naming the fix and the clean runs + `/close`, move to Done |
| Move to In progress | the issue has an assignee                                                | move to In progress                                                |
| Ask the thread      | P(resolved) between 0.35 and 0.65                                        | comment asking what is left                                        |
| Keep in To do       | otherwise                                                                | nothing, or add the missing `/triage accepted` and `/priority`     |

- **Resolved** is read from the thread, the PRs that link to the issue, and its tests' TestGrid history.
- **The fresh-fix guard** holds a close until the tracked tests have been quiet for 3+ days, and for three times
  their usual gap between failures. So a fix merged today is not closed on the strength of 7 green runs.
- **Duplicates** are grouped, and one issue per group always stays: an In-progress or assigned one first.

### Issues - In progress

For each assignee, code gathers plain facts: when they were assigned, their comments, their own PRs' merges and
commits, and recent review events. Jev answers the judgement calls:

- is each comment since the assignee last acted a check-in with them?
- is the assignee still on it?
- is the work moving through other people?

Activity of the assignee's own within 30 days counts as active without asking Jev.

| Action              | When                                                    | What Apply does                                                             |
| ------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------- |
| Archive             | no `sig/node` label                                     | move to Archive-it                                                          |
| Move back to To do  | nobody is assigned                                      | move to To do                                                               |
| Unassign            | a check-in to the assignee went unanswered for 14+ days | `/unassign @x` with a note; back to To do unless an active assignee remains |
| Nudge the assignee  | quiet for 30+ days and nobody has checked in            | "@x are you still working on this?"                                         |
| Ask the thread      | nobody active, and the work moves through others        | "what is left here, and who is driving it?"                                 |
| Keep in In progress | everyone active, or a check-in is younger than 14 days  | nothing                                                                     |

On kubernetes/151 this reproduced the nudges and waits the board owner applied on 2026-09-20, working from the
board as it stood a day earlier. It also matched a hand-checked reading of all 26 assignees on 2026-09-25.

### PRs - Needs Reviewer

On 151 this column means "triage accepted", not "no reviewer yet", so most cards need a move rather than a ping.

1. **Plain rules first:**
   - merged or closed → Done;
   - a draft, `needs-rebase` or stale → Waiting on Author;
   - `lgtm` → Needs Approver.
2. **Jev reads the PR's events** (comments, reviews, pushes, review requests, and Prow's `tide` status) to answer:
   whose move is it, who is really reviewing, who declined, and whether a reviewer's `/hold` condition looks met.
3. **A reviewer or an earlier ask gets 14 days** before a re-ping, and a ping restarts the clock.
4. **When nobody is reviewing and nobody was asked**, the extension finds reviewers. The `/cc` names up to three
   people, each with one checkable reason, so they can decide whether they have the bandwidth.

How the candidates were picked, measured on 662 PRs merged on 151 since 2025-10 (a hit means the person actually
reviewed):

| Candidates from                                                   | Actual reviewer in the top 3 |
| ----------------------------------------------------------------- | ---------------------------- |
| OWNERS membership alone                                           | about half                   |
| who reviewed recent PRs on the same files, directories, or author | better                       |
| Jev picking from that history, with counts and recent titles      | 71% (77% on 39 recent PRs)   |

### PRs - Needs Approver

The same facts and Jev call as Needs Reviewer, with its own rules:

- no `lgtm` → back to Needs Reviewer;
- `lgtm` and `approved` but not merged → Prow's `tide` status says what blocks it (failing checks → Waiting on
  Author);
- anyone already asked (a `/cc`, an `/assign`, a review request, or a comment Jev reads as asking them) gets 14 days
  before a re-ping.

When nobody was asked, the only eligible approvers are those who can approve the OWNERS files Prow's approval
notifier still lists, at that level or above. They are ranked by who approved PRs on the same files, directories and
author lately. On 343 PRs merged on 151, that put the actual approver in the top 3 for 73%, against 56% for the
OWNERS list alone.

The `/cc` covers every unapproved OWNERS file first. Approvers with no recent approvals are named only when nobody
active can approve a file. Jev picking among them did no better than this ranking, so the ranking stays in code.

### PRs Waiting on Author

Nothing moves a card out of this column when the author acts, so it goes stale like the others.

- Merged or closed → Done.
- Triage says it is not SIG Node CI work → Archive.
- `lgtm` and nothing blocking → Needs Approver.
- Jev reads the author as having answered or pushed since the last review request → Needs Reviewer.

Otherwise it is the author's move. Quiet time counts from the later of the author's own last activity and the last
review:

- quiet 30+ days with nobody checking in → nudge the author;
- a check-in Jev finds under 14 days → wait;
- an unanswered check-in → the card stays, and the lifecycle bot takes it from there.

## SIG Node Bugs board (kubernetes/185)

The board's own automations only put new and reopened issues in Triage and closed ones in Done. Nothing moves a card
when its labels change, so every action pairs its Prow comment with the move the column descriptions ask for:

- `triage/accepted` → Triaged, or High Priority at `critical-urgent` and `important-soon`;
- `triage/needs-information` → Needs Information;
- leaving the board → Done (there is no archive column).

### Triage

Is the report a SIG Node bug a maintainer can start on? The flow is the community
[issue triage guide](https://github.com/kubernetes/community/blob/master/contributors/guide/issue-triage.md)'s.
Jev reads:

- what kind of report it is: a bug, a support question, or a feature;
- who owns the code;
- whether there is enough to start on, and if not, what to ask the reporter for;
- whether it is about DRA (then `/wg device-management` is added and the card stays);
- its priority.

| Suggestion                       | What Apply does                                         | Applied by Accept? |
| -------------------------------- | ------------------------------------------------------- | ------------------ |
| Accept at a priority             | `/triage accepted`, `/priority`; move to its column     | yes                |
| Support question (Jev is sure)   | redirect to support channels, `/kind support`, `/close` | yes                |
| Too thin to act on (Jev is sure) | ask for the missing facts, `/triage needs-information`  | yes                |
| Feature filed as a bug           | relabel                                                 | your call          |
| Another SIG's code               | hand it over to that SIG                                | your call          |

The less sure calls show in yellow with a question mark: pick the action, then Apply or Accept. A card whose triage
label a person already set is only moved.

### Needs Information

A card waits here for the reporter, and nothing moves it when they answer.

- **Code reads the dates:** when `triage/needs-information` (or `not-reproducible`) last went on, and when the
  reporter last wrote.
- **Jev reads the request** (the comment that applied the label, or the question just before a bare
  `/triage needs-information`) and every reply since. It asks two things:
  - has what was asked been supplied, by the reporter or by anyone who hits the problem, or made unnecessary by a
    maintainer reproducing it?
  - which later comments remind the reporter?

The suggestion follows:

| State                                                     | Suggestion                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------- |
| answered, and now enough to start                         | `/remove-triage needs-information`, `/triage accepted`, `/priority`, move |
| answered but still thin                                   | your call                                                                 |
| unanswered for under 20 days (the triage guide's wait)    | keep                                                                      |
| unanswered past 20 days, and nobody reminded the reporter | remind them once, with an @-mention                                       |
| unanswered after a reminder                               | keep; the lifecycle bot stales, rots and closes it in time                |
| `triage/accepted` already set / label gone / closed       | move only / back to Triage / Done                                         |

### Triaged and High Priority

The accepted backlog. Only a person moves a card out, so the backlog goes stale. On kubernetes/185, 32 of 171 Triaged
cards had no priority, and 64 were still open although a merged PR referenced them.

- **Labels** (code):
  - closed → Done;
  - no `triage/accepted` → Needs Information (with `triage/needs-information`) or Triage;
  - a missing priority is added (Jev's pick, editable);
  - `critical-urgent` and `important-soon` belong in High Priority, the rest in Triaged, and the card moves there.
- **Fixed?** Jev reads the thread and the linked PRs. At P ≥ 0.8 the suggestion closes it with a comment naming the
  fix; 0.5–0.8 is your call.
- **Duplicate?** Each card is compared with the three cards whose titles share the most words. A duplicate closes in
  favour of the other card, and an assigned card is never the one closed.
- **Quiet assignee:** only people who assigned themselves (`/assign`) are nudged, then unassigned after an
  unanswered check-in, as in Issues - In progress. An owner a triager assigned is left alone.
- **High Priority with nobody assigned** is flagged for you.

## Dynamic Resource Allocation board (kubernetes/95)

Every issue and PR labelled `wg/device-management` lands in New, and a maintainer moves it on. The board has no
written rules, so these rules follow its record: 485 moves out of New, most of them by the WG's leads. A move only
changes the Status. The leads add no comments or labels, and neither does the extension.

The board's "Item closed" workflow is off, so a closed item stays in its column until someone moves it. Every column
below sends closed items to Done.

| Column      | PRs (code)                                                         | Issues                                                                                                   |
| ----------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| New         | merged or closed → Done; draft → In progress; else In review       | Jev picks In progress, Ready or Backlog. Accept moves only In progress at ≥ 0.95; the rest are your call |
| Backlog     | as in New                                                          | a KEP in the release being developed → In progress; other issues stay (Jev's read is your call)          |
| Ready       | as in New                                                          | a KEP in the release → In progress; Jev reads it as under way (P ≥ 0.9) → In progress, your call         |
| In progress | merged or closed → Done; ready for review → In review; drafts stay | a KEP no longer in the release → Backlog; others stay until they close. No Jev question                  |
| In review   | merged or closed → Done; draft → In progress; open PRs stay        | open issues → In progress. No Jev question                                                               |

Notes:

- **"In the release"** follows sig-release's `release_phases.md`: the KEP issue is in the milestone `v1.N` of the
  release being developed and has `lead-opted-in`.
- **Being assigned** is not what moves a card from Ready: assigned cards often wait there for months.
- **Open PRs in In review** stay. The ones people moved out early had no mark the others lacked.

### New

Jev reads the thread, the linked PRs, the assignees and the release cycle, and picks In progress, Ready or Backlog.

### Backlog

Later work. Closed items are the common leavers: 22 were waiting on 95 when it was first read.

### Ready

Work nobody has started. Cards move on when work starts, often in batches weeks after the fix PR opened.

### In progress

Work under way, placed by state alone.

### In review

Open PRs waiting to merge, placed by state alone.

## Every column

### Broken Prow commands

A comment line Prow ignored (`/assing @x`, `/triage accept`, `triage/accept`, `/priority imporant-soon`) means the
assignment or label never happened.

- Code flags lines that are not a known command with valid arguments.
- Jev says which command was meant, or that the line was never a command (prose, a path, an example).
- Code writes the fix with the original arguments. The fix shows on the hover card, and Apply and Accept post it
  ahead of the card's own action.
- No fix is posted when the item is being closed or archived, or when the label already came some other way.

Fixes only cover routing, labels, `/assign` and `/cc`. They never cover `/lgtm`, `/approve`, `/close` or
`/unassign`, which are a person's decision.

### What the lifecycle bot does, the extension leaves alone

The Kubernetes lifecycle bot marks quiet issues and PRs stale (90 days), then rotten (30 more), then closes them (30
more). It also asks for a re-triage of accepted issues untouched for a year. No column closes or re-triages an item
only for being quiet: after one reminder or nudge, the card waits for the bot.

## TestGrid review

On a SIG Node dashboard's summary page, **Tackle** judges every FAILING and FLAKY periodic job and badges each row.
`pull-*` presubmits are left out.

- **Code reads the facts:**
  - TestGrid's run history;
  - from each of the newest three failed runs, the failed junit test cases;
  - the build log's signal lines: Ginkgo's failure markers and summary, timeouts and kills, or the job's last lines
    when no test ran.
- **Jev judges** what kind of failure it is (a test failure, a suite or job timeout, or infra) and whether each
  candidate issue tracks it.
- **Candidates** come from one batched GraphQL search per job:
  - the job, tab and test names in kubernetes/kubernetes;
  - the job in kubernetes/test-infra;
  - SIG Node's failing-test and flake issues.

| Badge       | When                                                      | What Apply does                              |
| ----------- | --------------------------------------------------------- | -------------------------------------------- |
| `#N`        | tracked (P ≥ 0.65) by an issue that already names the job | nothing                                      |
| comment     | tracked by an issue that does not name the job yet        | comment adding the job                       |
| comment?    | a closed match, or 0.35–0.65                              | your call                                    |
| file issue  | untracked and FAILING                                     | new issue from the k/k failing-test template |
| file issue? | untracked and FLAKY, failing 5+ runs or 20%+ of them      | your call                                    |
| watch       | untracked and FLAKY, below that                           | nothing                                      |

The card also names issues that may cause the failure, or group it ("may cause this: #N", "part of #N"). These are
found by the failure's own words: its error text and Go identifiers verbatim, plus semantic and hybrid search on the
test and its error. SIG Node's open flake and failing-test issues are searched too. Jev reads each candidate for its
relation, and a second question must confirm it before it is shown: would fixing it stop these failures, or does it
cover this one? This part is display only.

## Failing CI on a pull request

On any pull request with a failed Prow job, a **Failing CI** section in the sidebar counts the failures and offers
**Check failures**. Clicked, it says for each job whether the PR's change broke it or it fails without the PR, and
why.

- **Code reads the facts:**
  - the failed run's junit failures (a verify script's reason from its stderr, a Go test's name from its output) and
    the build log's signal lines;
  - the job's earlier runs on this PR, and whether they tested the current commit;
  - from the job's presubmit tab on TestGrid, how often the same tests failed on other PRs' runs.
- **Jev reads the diff one changed file at a time:** could this file's change cause this failure?
  - The files most likely to, with their hunks, go into the cause question, and a PR-caused failure links the
    likeliest file.
  - A huge diff is still read whole, each file cut at 8,000 characters.
  - Generated, vendored and binary files, and any file Jev did not answer for, are listed to it as not judged, never
    as unlikely.
- **Jev judges the cause:** this PR, a flake, or infra, and whether a candidate flake issue tracks it (the same
  search as the TestGrid review). A job Prow never ran ("Pod scheduling timeout", no log) is infra without asking.
- **The rerun command:** `/retest` when none of the failures is the PR's, otherwise one `/test <job>` per job that is
  not. It is shown with a Copy button and never posted.

## CI history and duplicates on an issue

On SIG Node and DRA issues (`sig/node` or `wg/device-management`), a **Check** button runs two checks. Each gets its
own sidebar section when it has something to say; otherwise one line says nothing was found.

### CI history

For an issue that names CI jobs or tests, the extension reads:

- their run history on TestGrid, as the To do column reads it;
- the newest failed run's junit failures and log lines;
- Jev's read of whether the problem is resolved (To do's question);
- whether that newest failure is still the one the issue reports.

| Verdict                        | Meaning                                                    |
| ------------------------------ | ---------------------------------------------------------- |
| Still failing                  | the issue's failure is still happening                     |
| Fails differently now          | the tests fail, but not the way the issue describes        |
| Looks fixed                    | clean long enough; suggests closing                        |
| Looks fixed, too soon to close | the fresh-fix guard holds it                               |
| Failing again (closed issue)   | suggests `/reopen`, unless an open duplicate tracks it now |

### Duplicates and related

The check looks at current and past issues: about 40 candidates from six searches. The searches are keyword,
GitHub's semantic search, its hybrid search, exact error strings, Go identifiers from the body, and the issues the
thread links. Jev reads each candidate against the issue, with both threads.

- **A duplicate** (or the same root cause) is shown when Jev is sure and says one could be closed in favour of the
  other. The section says what links them: the same error, test, code path, request or trigger.
- **A related issue** is shown only for a concrete relation: an umbrella or sub-item, a follow-up, or a regression.

## What Apply and Accept may write

The background worker checks every write against an allow-list, whatever the page asks for:

- Status moves of the one item on the card;
- comments on that item, and only in the shapes the extension drafts (`src/core/comments.ts`):
  - the label commands: `/triage accepted` and `/priority`;
  - To do's close-as-fixed and close-as-duplicate comments;
  - the nudges and `/unassign` for one assignee, and the nudge to a PR's author;
  - Needs Reviewer's and Needs Approver's `/cc` (up to three people, one reason each) and re-pings;
  - "what is left here?" questions to the thread;
  - the Bugs board's triage comments and its Needs Information reminder;
  - Prow-command fixes.

Only the nudges and the unassign may @-mention anyone, one person each. TestGrid's new issues and comments go through
the same worker, and go only to kubernetes/kubernetes and kubernetes/test-infra.
