# Changelog

## 0.1.0 (unreleased)

First release. Reads and suggests on kubernetes/151, 185 and 95 and on TestGrid; writes only in test mode (the
test boards and `harche/sig-node-board-test`).

- Issues - To do: per-card suggestion to keep, move to In progress, close as fixed, ask the thread, close as
  duplicate or archive, from the thread, linked PRs and TestGrid run history, with a fresh-fix guard and a
  grouped duplicate pass. The reviewer can change the action (and a missing priority) on the hover card.
- Issues - In progress: per assignee, active / wait / nudge / unassign / ask the thread, from plain facts and
  Jev's reading of the thread and linked PRs; cards without an assignee go back to To do.
- PRs - Needs Reviewer: plain rules, then Jev on whose move it is, who reviews, who declined, whether a hold is
  met; re-pings after 14 quiet days; new reviewers found from review history and picked by Jev, asked with `/cc`.
- PRs - Needs Approver: back to Needs Reviewer without lgtm, Waiting on Author when approved but failing; asked
  approvers get 14 days; otherwise `/cc` approvers for the OWNERS files Prow still lists, ranked by recent approvals.
- PRs Waiting on Author: Done, Archive (Triage's scope verdict), Needs Approver on lgtm, Needs Reviewer when the
  author answered; nudge an author quiet 30+ days, wait on a check-in, then leave it to the lifecycle bot.
- SIG Node Bugs (kubernetes/185) Triage: accept at a priority into Triaged or High Priority, ask for information,
  close support requests, relabel features, hand over to another SIG, add `/wg device-management` to DRA reports;
  cards with a triage label already set are only moved. Test copy at harche/6.
- SIG Node Bugs Needs Information: accept a card whose request was answered, remind a reporter quiet 20+ days once and
  then leave the issue to the lifecycle bot, move cards whose labels already decided.
- SIG Node Bugs Triaged and High Priority: close fixed bugs and duplicates, nudge and unassign quiet self-assigned
  assignees, add a missing priority and move a card to its priority's column, flag High Priority cards with nobody
  assigned. The lifecycle bot's work (stale, rotten, closing quiet issues) is left to it in every column.
- Dynamic Resource Allocation (kubernetes/95) New: PRs to In review, In progress (drafts) or Done by their state,
  closed issues to Done, open issues to In progress, Ready or Backlog by Jev's pick, following the board's record of
  485 moves; only a Status move. Test copy at harche/7.
- Dynamic Resource Allocation Backlog: closed items to Done, PRs by their state, KEPs opted into the release in
  development (milestone and `lead-opted-in`) to In progress; other issues stay unless you pick a move.
- Dynamic Resource Allocation Ready: closed items to Done, PRs by their state, KEPs in the release to In progress,
  and issues Jev reads as under way suggested for In progress as your call.
- Dynamic Resource Allocation In progress: closed items to Done, PRs ready for review to In review, KEPs no longer in
  the release to Backlog; everything else stays. No Jev question: state decides.
- Dynamic Resource Allocation In review: merged or closed PRs to Done, drafts and issues to In progress; open PRs
  stay. No Jev question.
- Failing CI on a pull request's page: for each failed Prow job, whether the PR broke it, a flake or infra, from the
  run's junit and log, the job's runs on this PR and the same tests' record on other PRs (TestGrid's presubmit tabs),
  with any flake issue that tracks it and the `/retest` or `/test` command to copy. Read-only.
- CI history and duplicates on a SIG Node or DRA issue's page: whether the failure it reports still happens (run
  history, the newest failure and whether it is still the issue's, Jev's resolved read, the fresh-fix guard; a closed
  issue failing again), and duplicates and concretely related issues, current and past: six searches (keyword,
  semantic, hybrid, exact error strings, the thread's links), each candidate read by Jev with both threads, a
  duplicate shown only when one could be closed in favour of the other. Read-only.
- TestGrid review on testgrid.k8s.io: per failing or flaky periodic job, what fails (from junit and build-log signal
  lines), whether an issue tracks it, and a comment or a new issue drafted from the k/k templates; writes go to the
  test repo while it is tried out. The card also names issues that may cause the failure or are its umbrella,
  found by the failure's own words and confirmed by a second question.
- Hover cards and panes show every answer Jev gave as bars in one aligned grid (a probability per row, a row per
  option for a choice or a priority); the cards share their parts (`src/content/hcparts.ts`).
- Asks include comments Jev reads as asking someone to review or approve.
- Broken Prow commands in any column: flagged by code, read by Jev, fixed on Apply / Accept.
- The header's Accept applies every suggestion, comments included, in every column.
- Board columns are workflows (`src/content/workflows.ts`): Triage and Issues - To do share the column
  button, badges, tints, hover card, Accept, Cancel and Skip.
- Apply / Accept on boards marked writable (the test board), checked against an allow-list in the worker.
- Triage: Jev picks the priority, editable on the hover card; removals get no priority and no Accept.

- Badge on every card in the Triage column of kubernetes/151: keep, remove, borderline.
- Evidence section inside GitHub's own sidebar: the project pane for issues, the PR page for pull requests.
  Verdict band, Jev's answers, the code-computed signals and the accept / archive alternatives with their
  `gh` commands.
- `npm run judge` runs the same core from the terminal against the live board, for development.
- Settings page for the GitHub token and TypeSafe key, with connection tests and a cache reset.
- Parity test suite against a frozen snapshot of the Python CLI's outputs (signals, state, prompts, policy,
  commands). No Python needed to build, test or run.
- GitHub calls go through Octokit.js (pagination via Link headers, REST API version `2026-03-10`); Jev calls go
  through the TypeSafe SDK (`@typesafe-ai/sdk`). Neither caps how many calls are in flight: a rate limit is waited
  out with backoff (Retry-After or GitHub's reset when given, else 2s doubling to 60s with jitter; up to 8 tries),
  and the service worker is kept alive meanwhile. Other failures retry briefly: GitHub a 5xx it answered to a read,
  Jev a 5xx, timeout or connection failure; never a GitHub network failure.
- Policy: a confident "another SIG owns it" answer turns a KEEP into BORDERLINE (the CLI had dropped this).
- State: every human `/sig` or `/area` routing comment is sent to Jev as `human_routing`, not only those in
  the last-10 comment window.
- Settings page: a Test mode toggle, on by default. On, writes go only to the test boards and
  `harche/sig-node-board-test`; off, Apply and Accept also write to the real boards, and TestGrid comments and
  issues go to kubernetes/kubernetes and kubernetes/test-infra, labelled through Prow (`/sig node`, `/kind flake`) and never filed twice for the same title. The worker checks it on every write, and the page
  lists where writes go in each mode. The page also describes every board and TestGrid, and which token reads the
  real boards and which writes the test boards.
- TestGrid mirror issues name the real issue in backticks, so a public test repo would not show on its timeline.
