# Changelog

## 0.1.0 (unreleased)

First release. Reads and suggests on kubernetes/151; writes only on the test board.

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
  through the TypeSafe SDK (`@typesafe-ai/sdk`). Retries stay short so the service worker is never stopped
  mid-call: GitHub retries only a 5xx it actually answered, and never a rate limit or a network failure.
- Policy: a confident "another SIG owns it" answer turns a KEEP into BORDERLINE (the CLI had dropped this).
- State: every human `/sig` or `/area` routing comment is sent to Jev as `human_routing`, not only those in
  the last-10 comment window.
