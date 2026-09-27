# SIG Node Board Assistant

A Chrome extension that puts Jev's suggestion on every card of the
[SIG Node CI/Test](https://github.com/orgs/kubernetes/projects/151),
[SIG Node Bugs](https://github.com/orgs/kubernetes/projects/185) and
[Dynamic Resource Allocation](https://github.com/orgs/kubernetes/projects/95) boards, and on every failing or flaky
job of a [TestGrid](https://testgrid.k8s.io) dashboard, with the evidence behind it, right on the page you already
use. On a pull request's page it says, for each failing Prow job, whether the PR broke it; on an issue's page, whether
the failure it reports still happens, and which issues it duplicates or is concretely related to. Nothing is written until you Apply or Accept.

On the CI/Test board:

- **Triage**: does the item belong on the board (keep, remove, borderline), and at which priority.
- **Issues - To do**: is the issue already resolved, a duplicate, being worked on, or someone else's; read
  from the thread, the PRs that link to it and its tests' TestGrid history.
- **Issues - In progress**: is each assignee still on it; nudge the quiet ones, unassign after an unanswered
  check-in, or send the card back to To do.
- **PRs - Needs Reviewer**: is the PR really waiting on a reviewer (or on its author, an approver, a hold); re-ping
  a quiet reviewer, or `/cc` new ones picked from who actually reviews that code.
- **PRs - Needs Approver**: does the PR have lgtm and wait on an approver; re-ping an asked approver, or `/cc`
  approvers who can approve the OWNERS files Prow says still need it, picked from who approves that code lately.
- **PRs Waiting on Author**: did the author act (back to reviewers or approvers), has the author gone quiet (nudge
  them), or is the PR not SIG Node CI work at all (archive).

On the Bugs board:

- **Triage**: is the report a SIG Node bug a maintainer can start on (accept it at a priority), a support question
  (redirect and close), a feature filed as a bug, another SIG's code (hand it over), or too thin to act on (ask the
  reporter); and move it to the column its labels call for.
- **Needs Information**: was the request answered (accept it at a priority), or has the reporter gone quiet (remind
  them once after 20 days, then leave it to the lifecycle bot).
- **Triaged** and **High Priority**: is the bug already fixed (close it), a duplicate of another card (close it in
  favour of that one), held by someone who assigned themselves and went quiet (nudge, then unassign); does it have a
  priority, and is it in that priority's column.

Click **Tackle** on the column (or on one card) and each card gets a badge and a tint. Hover a card for the
evidence and the suggested action, which you can change before applying it; open the item the way you always
do and the same evidence is there as one more section in GitHub's own sidebar.

**Test mode is on by default.** With it on, applying an action (a Prow comment and a Status move) only works on
boards marked `writable` in `src/core/boards.ts`, the private test copies of 151, 185 and 95, and TestGrid's drafted
issues and comments go only to `harche/sig-node-board-test` (`TG_TEST_REPO`). On kubernetes/151, kubernetes/185,
kubernetes/95 and kubernetes/kubernetes the extension then reads and suggests; it never comments, labels, moves a
card or opens an issue there. Turning test mode off on the settings page lets Apply and Accept write to the real
boards too, and TestGrid's comments and issues go to the real issues in kubernetes/kubernetes and
kubernetes/test-infra. The settings page lists where writes go in each mode. The worker
checks every write against an allow-list: Status moves of the one item, and only the comments the extension
drafts (`/triage accepted` with a priority, the To-do close / duplicate / check-in comments, and the
In-progress nudge, `/unassign` and check-in comments, the Needs Reviewer `/cc` and re-pings, and the Bugs board's
accept, needs-information, support, feature and hand-over comments, and its Needs Information reminder and close).

| on the board                                         | in GitHub's item pane (issues)                                   | on the PR page (pull requests)                       |
| ---------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------- |
| ![badge on a Triage card](docs/screenshot-board.png) | ![section in the project pane sidebar](docs/screenshot-pane.png) | ![section in the PR sidebar](docs/screenshot-pr.png) |

GitHub's project pane only exists for issues; a PR card opens the PR in a new tab. So the section is
rendered into whichever sidebar you land in, built from that page's own section markup so it matches.

## How it works

- **Jev decides, code computes.** Each card's thread and changed files are fetched over the GitHub REST
  API. The code computes the hard facts (human `/sig` routing, Prow state labels, review state, test-file
  share, assignees, linked PRs, CI run history). [Jev](https://typesafe.ai), TypeSafe's decision model,
  answers calibrated questions about the item. On Triage: does it belong on the board, what kind of work is
  it, which SIG owns it, how urgent is it. On To do: is the problem it tracks already resolved, and how; is
  it the same failure as another card. Jev never generates text and never acts.
- **The policy is written down.** `src/core/policy.ts` (Triage) and `src/core/todo.ts` (To do) turn Jev's
  probabilities into a verdict with fixed thresholds and say why in one sentence. The hover card and the pane
  draw that band so the decision explains itself.
- **No backend.** Everything runs in the extension: GitHub through [Octokit.js](https://github.com/octokit/core.js)
  (REST API version `2026-03-10`), Jev through the [TypeSafe SDK](https://github.com/typesafe-ai/typesafe-sdk-js),
  TestGrid through its public JSON endpoints.
- **Started as a port of the CLI.** The logic was ported from
  [sig-node-ci-assistant](https://github.com/harche/sig-node-ci-assistant). `tests/fixtures/parity.json` is a
  frozen snapshot of that reference's outputs (signals, Jev state, prompts, verdicts, commands); the extension is
  now the source of truth and the snapshot guards against unintended drift.

## Install

Until it is on the Chrome Web Store:

```bash
git clone https://github.com/harche/sig-node-board-assistant
cd sig-node-board-assistant
npm install
npm run build
```

Then open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and pick the `dist/`
folder. Click the extension's icon to open its settings and add:

- a GitHub **personal access token**. A fine-grained token has one resource owner: `kubernetes` (organization
  permission _Projects: read_, public repositories) reads the real boards, where the extension only reads;
  `harche` (_Projects_, and _Issues_ and _Pull requests_ on `sig-node-board-test`, read and write) reads and
  writes the test boards. A classic token with the `repo` and `project` scopes works on both.
- a key for **Jev**, from either provider (pick it under Jev on the settings page):
  - **TypeSafe**, from [typesafe.ai](https://typesafe.ai). Judging one card costs about $0.0002.
  - **OpenRouter**, from [openrouter.ai](https://openrouter.ai/settings/keys): the same model
    (`~typesafe/jev-latest`) through OpenRouter's System One endpoint, billed to the OpenRouter account, which
    reports each call's cost.

  Answers are cached by question, so revisiting the board is free and switching providers keeps them.

The keys are stored in the browser's local extension storage, never synced, and sent only to `api.github.com`
and the chosen Jev provider (`api.typesafe.ai` or `openrouter.ai`). TestGrid (`testgrid.k8s.io`) is public and read without credentials.

Open the board and click **Tackle** on Triage or Issues - To do (or on one card's badge). Cards get a badge as
they are judged; hover one for the evidence and the actions, or open it (issue pane or PR tab) and the
"SIG Node board assistant" section appears in the sidebar. On an issue or PR's own page nothing asks Jev until you
click: each section (the board verdict, Failing CI, CI history and duplicates) first offers a **Judge** or **Check**
button in GitHub's own style, and the same button reads **Judge again** / **Check again** once it has run.

## Issues - To do

The column holds accepted issues nobody is working on yet. For each card the extension suggests one action:

| action              | when                                                                     | what Apply does                                                    |
| ------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Archive             | the issue has no `sig/node` label                                        | move to Archive-it                                                 |
| Close as duplicate  | Jev says it tracks the same failure as another To-do or In-progress card | comment naming the issue that stays + `/close`, move to Archive-it |
| Close as fixed      | P(resolved) ≥ 0.65 and the fresh-fix guard agrees                        | comment naming the fix and the clean runs + `/close`, move to Done |
| Move to In progress | the issue has an assignee                                                | move to In progress                                                |
| Ask the thread      | P(resolved) between 0.35 and 0.65                                        | comment asking what is left                                        |
| Keep in To do       | otherwise                                                                | nothing, or the missing `/triage accepted` and `/priority`         |

Earlier rows win. The **fresh-fix guard** holds a close while the tracked tests have not been quiet for 3+ days
and for three times their usual gap between failures, so a fix merged today is not closed on 7 green runs.
Duplicates are grouped and one issue per group always stays: an In-progress or assigned one first. The header's
Accept applies every card's suggestion (or your pick), as in every column.

## Issues - In progress

For each assignee the code gathers plain facts (when they were assigned, their comments, their own PRs' merges,
commits and recent review events) and Jev answers the judgement calls: is each comment since the assignee last
acted a check-in to them, is the assignee still on it, and is the work moving through other people. Own activity
within 30 days counts as active without asking. Then:

| action              | when                                                    | what Apply does                                                             |
| ------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------- |
| Archive             | no `sig/node` label                                     | move to Archive-it                                                          |
| Move back to To do  | nobody is assigned                                      | move to To do                                                               |
| Unassign            | a check-in to the assignee went unanswered for 14+ days | `/unassign @x` with a note; back to To do unless an active assignee remains |
| Nudge the assignee  | quiet for 30+ days and nobody has checked in            | "@x are you still working on this?"                                         |
| Ask the thread      | nobody active, and the work moves through others        | "what is left here, and who is driving it?"                                 |
| Keep in In progress | everyone active, or a check-in is younger than 14 days  | nothing                                                                     |

On kubernetes/151 this reproduced the nudges and waits the board owner applied on 2026-09-20 from the state a
day earlier, and matched a hand-checked reading of all 26 assignees on 2026-09-25.

## PRs - Needs Reviewer

On 151 the column means "triage accepted", not "no reviewer", so most cards need a move rather than a ping. Plain
rules first (merged or closed → Done; draft, `needs-rebase`, stale → Waiting on Author; `lgtm` → Needs Approver),
then Jev reads the PR's events (comments, reviews, pushes, review requests, Prow's `tide` status) for whose move it
is, who is really reviewing, who declined, and whether a reviewer's `/hold` condition looks met. A reviewer or an
earlier ask gets 14 days (a ping restarts it) before a re-ping.

When nobody is reviewing and nobody was asked, the extension looks for reviewers. Measured on 662 PRs merged on 151
since 2025-10 (hit = the person actually reviewed): OWNERS membership alone put a reviewer in its top 3 for about
half; who reviewed recent PRs touching the same files, directories, or by the same author did better; Jev picking
from that history, given each candidate's counts and the titles they reviewed lately, did best (71% in its top 3;
77% on 39 recent k/k PRs with repository-wide history). The comment `/cc`s up to three people with one checkable
reason each, so they can decide whether they have the bandwidth.

## PRs - Needs Approver

The same facts and Jev call as Needs Reviewer, with its own rules: no `lgtm` → back to Needs Reviewer; `lgtm` and
`approved` but not merged → Prow's `tide` status says what blocks it (failing checks → Waiting on Author). Anyone
already asked (a `/cc`, an `/assign`, a review request, or a comment Jev reads as asking them) gets 14 days before a
re-ping. When nobody was asked, only approvers who can approve the OWNERS files Prow's approval notifier still lists
(at that level or above) are eligible, ranked by who approved PRs touching the same files, directories and author
lately: on 343 PRs merged on 151 that put the actual approver in the top 3 for 73%, against 56% for the OWNERS list
alone. The `/cc` covers every unapproved OWNERS file first; approvers with no recent approvals are named only when
nobody active can approve a file. (Jev picking among them did no better, so the ranking is code.)

## PRs Waiting on Author

Nothing moves a card out of this column when the author acts, so it goes stale like the others. Merged or closed →
Done; Triage's verdict says it is not SIG Node CI work → Archive; `lgtm` and nothing blocking → Needs Approver; Jev reads
the author as having answered or pushed since the last review request → Needs Reviewer. Otherwise it is the author's
move, counted from the later of their own last activity and the last review: quiet 30+ days with nobody checking in →
nudge the author; a check-in Jev finds under 14 days → wait; an unanswered one → the card stays, and the Kubernetes
lifecycle bot takes it from there (stale, rotten, closed).

## SIG Node Bugs: Triage

The board's own automations only put new and reopened issues in Triage and closed ones in Done; nothing moves a card
when its labels change. So every action pairs its Prow comment with the move the column descriptions ask for:
`triage/accepted` → Triaged, or High Priority at `critical-urgent` / `important-soon`; `triage/needs-information` →
Needs Information; leaving the board → Done (there is no archive column). A card whose triage label a human already
set is only moved.

The flow is the community [issue triage guide](https://github.com/kubernetes/community/blob/master/contributors/guide/issue-triage.md)'s.
Jev reads what kind of report it is, who owns the code, whether there is enough to start, whether it is about DRA
(which adds `/wg device-management` and stays), its priority, and what to ask the reporter for. Accept applies the
suggestions Jev is sure of: accept, a sure support request (redirect, `/kind support`, `/close`) and a report with
hardly any information (ask for the missing facts, `/triage needs-information`). A feature filed as a bug, another
SIG's code and the less sure calls show as yellow with a question mark: you pick the action, then Apply or Accept.

## SIG Node Bugs: Needs Information

A card waits here for the reporter; nothing moves it when they answer. Code reads the dates: when
`triage/needs-information` (or `not-reproducible`) last went on, when the reporter last wrote. Jev reads the request
(the comment that applied the label, or the question just before a bare `/triage needs-information`) and every reply
since: has what was asked been supplied, by the reporter or anyone who hits the problem, or made unnecessary by a
maintainer reproducing it; and which later comments remind the reporter.

- Answered, and Jev's Triage questions now read enough to start → `/remove-triage needs-information`,
  `/triage accepted`, `/priority`, move to Triaged or High Priority. Answered but still thin → your call.
- Unanswered: under 20 days (the community triage guide's wait) → keep; past it and nobody reminded the reporter →
  remind them (@-mention); after a reminder the card stays, and the Kubernetes lifecycle bot marks the issue stale,
  rotten and closes it in time.
- `triage/accepted` already set → move only; the information label gone → back to Triage; closed → Done.

## SIG Node Bugs: Triaged and High Priority

The accepted backlog. Nothing moves a card out but a person, so it goes stale: on kubernetes/185, 32 of 171 Triaged
cards had no priority and 64 were referenced by a merged PR while still open.

- Labels (code): closed → Done; no `triage/accepted` → Needs Information (with `triage/needs-information`) or Triage;
  a missing priority is added (Jev's pick, editable); `critical-urgent` and `important-soon` belong in High Priority,
  the rest in Triaged, and the card moves there.
- Fixed? Jev reads the thread and the linked PRs: P ≥ 0.8 closes it with a comment naming the fix; 0.5–0.8 is your call.
- Duplicate? The column's pass asks Jev about each card and the three cards whose titles share the most words; a
  duplicate closes in favour of the other, never an assigned card.
- Quiet assignee: only people who assigned themselves (`/assign`) are nudged, then unassigned after an unanswered
  check-in, as in Issues - In progress. An owner a triager assigned is left alone.
- High Priority with nobody assigned: flagged for you.

## Dynamic Resource Allocation: New

Every issue and PR labelled `wg/device-management` lands in New on kubernetes/95, and a maintainer moves it on. The
board has no written rules, so these follow its record: 485 moves out of New, most by the WG's leads. A move only
changes the Status; they add no comments or labels in New, and neither does the extension.

- PRs (code): merged or closed → Done; draft → In progress; otherwise In review.
- Issues: closed → Done (code). Open ones: Jev reads the thread, the linked PRs, the assignees and the release cycle
  and picks In progress, Ready or Backlog. Accept moves an issue itself only when Jev says In progress at 0.95 or more;
  every other issue is your call, with Jev's pick suggested.

## Dynamic Resource Allocation: Backlog

Later work. The board's "Item closed" workflow is off, so closed items stay until someone moves them (22 on 95).

- Closed issues and PRs → Done; open PRs as in New (code).
- A KEP in the release being developed → In progress: its milestone is `v1.N` for that release and it has
  `lead-opted-in`, which is how sig-release's `release_phases.md` defines "in the release" (code).
- Other open issues stay. Jev reads each one as in New; when it reads In progress or Ready, that is your call.

## Dynamic Resource Allocation: Ready

Work nobody has started. Cards move on when work starts, often in batches weeks after the fix PR opened.

- Closed issues → Done; PRs as in New; a KEP in the release being developed → In progress (code).
- An issue Jev reads as under way (P ≥ 0.9: an open PR for it, someone saying they are on it) → In progress, your
  call. Being assigned alone is not the trigger: assigned cards often wait in Ready for months.
- Other open issues stay.

## Dynamic Resource Allocation: In progress

Work under way. Placed by state alone; Jev is not asked.

- Closed issues and merged or closed PRs → Done; open PRs ready for review → In review; draft PRs stay.
- A KEP no longer in the release being developed (not in its milestone, or not `lead-opted-in`) → Backlog. A KEP in
  the release stays.
- Other open issues stay until they close.

## Dynamic Resource Allocation: In review

Open PRs waiting for their merge. Placed by state alone; Jev is not asked.

- Merged or closed PRs → Done; draft PRs → In progress; issues → In progress (or Done when closed).
- Open PRs ready for review stay: the ones people moved out early had no mark the others lacked.

## TestGrid review (testgrid.k8s.io)

On a SIG Node dashboard's summary, Tackle judges every FAILING and FLAKY periodic job (`pull-*` presubmits are left
out) and badges each row: tracked `#N`, comment, file issue, or watch.

- Code reads the facts: TestGrid's run history, and from each of the newest three failed runs the failed junit test
  cases and the build log's signal lines (Ginkgo's failure markers and summary, timeouts and kills, or the job's last
  lines when no test ran).
- Jev judges what kind of failure it is (a test failure, a suite or job timeout, infra) and whether each candidate
  issue tracks it. Candidates come from one batched GraphQL search per job: the job, tab and test names in
  kubernetes/kubernetes, the job in kubernetes/test-infra, and SIG Node's failing-test and flake issues.
- Tracked (P ≥ 0.65) by an issue that already names the job: nothing to do. Tracked by one that does not: a comment
  adding the job. A closed match, or 0.35–0.65: your call. Untracked and FAILING: a new issue from the k/k
  failing-test template. Untracked and FLAKY: an issue is your call when it failed 5+ runs or 20%+ of them, else watch.
- Beyond the tracking issue, the card names issues that cause the failure or group it ("may cause this: #N", "part
  of #N"): found by the failure's own words (its error text and Go identifiers verbatim, semantic and hybrid search
  on the test and its error) and among SIG Node's open flake and failing-test issues, read by Jev for their
  relation, and shown only when a second question confirms it (fixing it would stop these failures; it covers this
  one). Display only.
- While the review is tried out, writes go to `harche/sig-node-board-test` only: new issues are opened there, and a
  comment meant for a kubernetes/kubernetes issue goes on its `[mirror]` issue there.

The hover card takes TestGrid's look (its buttons, panel colours and status colours).

## Failing CI on a pull request's page

On any pull request with a failed Prow job, a "Failing CI" section in the sidebar counts the failures and offers
**Check failures**; clicked, it says for each one whether the PR's change broke it or it fails without the PR, and
why.

- Code reads the facts: the failed run's junit failures (a verify script's reason from its stderr, a Go test's name
  from its output) and build log signal lines, the job's earlier runs on this PR and whether they tested the current
  commit, and from the job's presubmit tab on TestGrid how often the same tests failed on other PRs' runs.
- Jev reads the PR's diff one changed file at a time: could this file's change cause this failure? The files most
  likely to, with their hunks, go into the cause question, and a PR-caused failure names the likeliest file. A huge
  diff is read whole this way, each file cut at 8,000 characters. Generated and vendored files, binary ones and any
  Jev did not answer for are listed to it as not judged, never as unlikely.
- Jev judges the cause: this PR, a flake, or infra, and whether a candidate flake issue tracks it (the same search as
  the TestGrid review). A job Prow never ran ("Pod scheduling timeout", no log) is infra without asking Jev.
- The section suggests the Prow command that reruns what is not the PR's: `/retest` when nothing failing is the PR's,
  else one `/test <job>` per job. It only shows the command, with a Copy button: it writes nothing.

## CI history and duplicates on an issue's page

On SIG Node and DRA issues (`sig/node` or `wg/device-management`), a **Check** button runs two checks; each gets its
own sidebar section when it has something to say (else one line says nothing was found):

- **CI history**, for an issue that names CI jobs or tests: their run history on TestGrid (as the To do column reads
  it), the newest failed run's junit failures and log lines, Jev's read of whether the problem is resolved (To do's
  question), and whether that newest failure is still the one the issue reports. Verdicts: still failing, fails
  differently now, looks fixed (suggest closing), looks fixed but too soon to close (the fresh-fix guard), and for a
  closed issue failing again (suggest `/reopen`, unless an open duplicate tracks it now).
- **Duplicates and related**, current and past: about 40 candidates from six searches (keyword, GitHub's semantic
  and hybrid search, exact error strings and Go identifiers from the body, and the issues the thread links), each
  read by Jev against the issue with both threads. A duplicate (or the same root cause) is shown when Jev is sure
  and says one could be closed in favour of the other, with what links them (same error, test, code path, request
  or trigger). A related issue is shown only for a concrete relation: an umbrella or sub-item, a follow-up, or a
  regression.

Read-only: a suggested command is for the reader to post.

## What the lifecycle bot does, the extension leaves alone

The Kubernetes lifecycle bot marks quiet issues and PRs stale (90 days), rotten (30 more) and closes them (30 more),
and asks for a re-triage of accepted issues untouched for a year. No column closes or re-triages something only for
being quiet: after one reminder or nudge, the card waits for the bot.

## Broken Prow commands (every column)

A comment line Prow ignored (`/assing @x`, `/triage accept`, `triage/accept`, `/priority imporant-soon`) means the
assignment or label never happened. Code flags lines that are not a known command with valid arguments; Jev says which
command was meant, or that the line was never a command (prose, a path, an example); code writes the fix with the
original arguments. The fix is shown on the hover card and posted ahead of the card's own action by Apply and Accept,
unless the item is being closed or archived, or the label already came some other way. Fixes only cover routing,
labels and `/assign` and `/cc`: never `/lgtm`, `/approve`, `/close` or `/unassign`, which are a person's decision.

## Boards

| board                              | project        | what the extension does today               |
| ---------------------------------- | -------------- | ------------------------------------------- |
| SIG Node CI/Test Board             | kubernetes/151 | judges all seven active columns (read-only) |
| SIG Node CI/Test Board (test)      | harche/5       | the same, with writes, for testing          |
| SIG Node Bugs                      | kubernetes/185 | judges all four active columns (read-only)  |
| SIG Node Bugs (test)               | harche/6       | the same, with writes, for testing          |
| Dynamic Resource Allocation        | kubernetes/95  | judges all five active columns (read-only)  |
| Dynamic Resource Allocation (test) | harche/7       | the same, with writes, for testing          |

Board and column names are configuration in `src/core/boards.ts`; adding a board is a table entry plus a
workflow.

## Develop

```bash
npm run watch        # rebuild dist/ on change; reload the extension in chrome://extensions
npm test             # vitest: unit tests + parity against the frozen reference snapshot
npm run lint         # eslint + prettier
npm run typecheck
npm run zip          # dist/ -> sig-node-board-assistant-<version>.zip
```

Layout:

```
src/core/        pure logic, no browser APIs: GitHub, Jev and TestGrid clients, signals, state, policy,
                 prompts; triage.ts and todo.ts per column
src/background/  service worker: owns tokens and the cache, answers the content script's questions, checks writes
src/content/     board page: column buttons, badges, hover cards, pane injection; workflows.ts holds what differs
                 per column
src/item/        issue and PR pages: the same evidence block in the page sidebar, the PR page's Failing CI, and
                 the issue page's CI history and duplicates
src/options/     settings page
tests/           vitest; fixtures/parity.json is a frozen snapshot of the CLI's outputs
docs/design.md   why it is shaped this way
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/design.md](docs/design.md).

## Roadmap

1. Writes on kubernetes/151, after testing on the test board and an explicit opt-in in settings.
2. The Bugs board (kubernetes/185) triage workflow.
3. Chrome Web Store listing.

## License

Apache 2.0, the same as Kubernetes.
