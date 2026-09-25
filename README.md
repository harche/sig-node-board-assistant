# SIG Node Board Assistant

A Chrome extension that puts a calibrated opinion on the cards of the
[SIG Node CI/Test board](https://github.com/orgs/kubernetes/projects/151) and the
[SIG Node Bugs board](https://github.com/orgs/kubernetes/projects/185), right on the board you already use.

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
  them after 20 days, close 14 days after an unanswered reminder).

Click **Tackle** on the column (or on one card) and each card gets a badge and a tint. Hover a card for the
evidence and the suggested action, which you can change before applying it; open the item the way you always
do and the same evidence is there as one more section in GitHub's own sidebar.

**Writes are limited to the test board for now.** Applying an action (a Prow comment and a Status move) only
works on boards marked `writable` in `src/core/boards.ts`, today only the private test copies of 151 and 185. On
kubernetes/151 and kubernetes/185 the extension reads and suggests; it never comments, labels or moves a card there. The worker
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

- a GitHub **fine-grained personal access token** with resource owner `kubernetes`, organization permission
  _Projects: read_, and access to public repositories. On kubernetes/151 the extension only reads, so a
  read-only token is all it needs.
- a **TypeSafe API key** from [typesafe.ai](https://typesafe.ai). Judging one card costs about $0.0002; answers
  are cached, so revisiting the board is free.

Both are stored in the browser's local extension storage, never synced, and sent only to `api.github.com`
and `api.typesafe.ai`. TestGrid (`testgrid.k8s.io`) is public and read without credentials.

Open the board and click **Tackle** on Triage or Issues - To do (or on one card's badge). Cards get a badge as
they are judged; hover one for the evidence and the actions, or open it (issue pane or PR tab) and the
"SIG Node board assistant" section appears in the sidebar.

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
  remind them (@-mention); an unanswered reminder older than 14 days → close with a comment inviting them to reopen
  with the details.
- `triage/accepted` already set → move only; the information label gone → back to Triage; closed → Done.

## Broken Prow commands (every column)

A comment line Prow ignored (`/assing @x`, `/triage accept`, `triage/accept`, `/priority imporant-soon`) means the
assignment or label never happened. Code flags lines that are not a known command with valid arguments; Jev says which
command was meant, or that the line was never a command (prose, a path, an example); code writes the fix with the
original arguments. The fix is shown on the hover card and posted ahead of the card's own action by Apply and Accept,
unless the item is being closed or archived, or the label already came some other way. Fixes only cover routing,
labels and `/assign` and `/cc`: never `/lgtm`, `/approve`, `/close` or `/unassign`, which are a person's decision.

## Boards

| board                         | project        | what the extension does today                   |
| ----------------------------- | -------------- | ----------------------------------------------- |
| SIG Node CI/Test Board        | kubernetes/151 | judges all seven active columns (read-only)     |
| SIG Node CI/Test Board (test) | harche/5       | the same, with writes, for testing              |
| SIG Node Bugs                 | kubernetes/185 | judges Triage and Needs Information (read-only) |
| SIG Node Bugs (test)          | harche/6       | the same, with writes, for testing              |
| Dynamic Resource Allocation   | kubernetes/95  | recognised, idle (workflow to come)             |

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
src/item/        issue and PR pages: the same evidence block in the page sidebar
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
