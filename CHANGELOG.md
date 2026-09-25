# Changelog

## 0.1.0 (unreleased)

First release. Reads and suggests on kubernetes/151; writes only on the test board.

- Issues - To do: per-card suggestion to keep, move to In progress, close as fixed, ask the thread, close as
  duplicate or archive, from the thread, linked PRs and TestGrid run history, with a fresh-fix guard and a
  grouped duplicate pass. The reviewer can change the action (and a missing priority) on the hover card.
- Issues - In progress: per assignee, active / wait / nudge / unassign / ask the thread, from plain facts and
  Jev's reading of the thread and linked PRs; cards without an assignee go back to To do.
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
