# SIG Node Board Assistant

A Chrome extension that puts a calibrated opinion on the cards of the
[SIG Node CI/Test board](https://github.com/orgs/kubernetes/projects/151), right on the board you already
use, for two columns:

- **Triage**: does the item belong on the board (keep, remove, borderline), and at which priority.
- **Issues - To do**: is the issue already resolved, a duplicate, being worked on, or someone else's; read
  from the thread, the PRs that link to it and its tests' TestGrid history.
- **Issues - In progress**: is each assignee still on it; nudge the quiet ones, unassign after an unanswered
  check-in, or send the card back to To do.

Click **Tackle** on the column (or on one card) and each card gets a badge and a tint. Hover a card for the
evidence and the suggested action, which you can change before applying it; open the item the way you always
do and the same evidence is there as one more section in GitHub's own sidebar.

**Writes are limited to the test board for now.** Applying an action (a Prow comment and a Status move) only
works on boards marked `writable` in `src/core/boards.ts`, today only the private test copy of 151. On
kubernetes/151 the extension reads and suggests; it never comments, labels or moves a card there. The worker
checks every write against an allow-list: Status moves of the one item, and only the comments the extension
drafts (`/triage accepted` with a priority, the To-do close / duplicate / check-in comments, and the
In-progress nudge, `/unassign` and check-in comments).

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

## Boards

| board                         | project        | what the extension does today                                      |
| ----------------------------- | -------------- | ------------------------------------------------------------------ |
| SIG Node CI/Test Board        | kubernetes/151 | judges Triage, Issues - To do and Issues - In progress (read-only) |
| SIG Node CI/Test Board (test) | harche/5       | the same, with writes, for testing                                 |
| SIG Node Bugs                 | kubernetes/185 | recognised, idle (workflow to come)                                |
| Dynamic Resource Allocation   | kubernetes/95  | recognised, idle (workflow to come)                                |

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
2. The PR lanes: lane hygiene and reviewer finding, as the CLI has them.
3. The Bugs board (kubernetes/185) triage workflow.
4. Chrome Web Store listing.

## License

Apache 2.0, the same as Kubernetes.
