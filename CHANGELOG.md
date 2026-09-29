# Changelog

## 0.1.1 (unreleased)

- **Runs only where it works:** the board script loads only on kubernetes org boards, and the issue and pull request
  script only on kubernetes and kubernetes-sigs repositories, instead of on every GitHub board, issue and pull request.

## 0.1.0 (unreleased)

First release. It reads and suggests on kubernetes/151, 185 and 95, on TestGrid, and on kubernetes/kubernetes pull
requests and issues.

### SIG Node CI/Test board (kubernetes/151)

- **Triage:** keep, remove or borderline, from Jev's scope, kind-of-work, owner and urgency answers. Jev picks the
  priority, which is editable on the hover card. A confident "another SIG owns it" turns a keep into borderline.
- **Issues - To do:** keep, move to In progress, close as fixed, ask the thread, close as duplicate, or archive. It
  reads the thread, the linked PRs and the TestGrid run history. A fresh-fix guard holds a close, and duplicates are
  handled in grouped passes.
- **Issues - In progress:** for each assignee, active, wait, nudge, unassign or ask the thread. Cards with no assignee
  go back to To do.
- **PRs - Needs Reviewer:** plain rules, then Jev on whose move it is, who reviews, who declined, and whether a hold is
  met. It re-pings after 14 quiet days, and picks new reviewers from review history and Jev, asked with `/cc`.
- **PRs - Needs Approver:** back to Needs Reviewer without `lgtm`, and to Waiting on Author when approved but
  failing. Approvers already asked get 14 days. Otherwise it `/cc`s approvers for the OWNERS files Prow still lists,
  ranked by recent approvals.
- **PRs Waiting on Author:** Done, Archive, Needs Approver on `lgtm`, or Needs Reviewer when the author answered. An
  author quiet for 30+ days is nudged once.

### SIG Node Bugs board (kubernetes/185)

- **Triage:**
  - accept at a priority into Triaged or High Priority;
  - ask for information;
  - close support requests;
  - relabel features;
  - hand over to another SIG;
  - add `/wg device-management` to DRA reports.
- **Needs Information:** accept a card whose request was answered. Remind a reporter quiet for 20+ days once, then
  leave the issue to the lifecycle bot.
- **Triaged and High Priority:**
  - close fixed bugs and duplicates;
  - nudge and unassign quiet self-assigned assignees;
  - add a missing priority and move the card to that priority's column;
  - flag High Priority cards with nobody assigned.

### Dynamic Resource Allocation board (kubernetes/95)

- **New, Backlog, Ready, In progress and In review:** closed items go to Done and PRs follow their state. KEPs follow
  the release (milestone and `lead-opted-in`). Open issues get Jev's pick where the board's record supports one. The
  only change is a Status move, following the board's record of 485 moves.

### Every column

- Broken Prow commands are flagged by code, read by Jev, and fixed on Apply or Accept.
- The lifecycle bot's work (stale, rotten, closing quiet items) is left to it.
- The header's Accept applies every suggestion in the column, comments included.
- Hover cards and panes show every answer Jev gave as bars in one aligned grid.

### TestGrid

- A review on testgrid.k8s.io, for each failing or flaky periodic job:
  - what fails, from junit and the build log's signal lines;
  - whether an issue tracks it;
  - a comment or a new issue drafted from the kubernetes/kubernetes templates.
- The card also names issues that may cause the failure or are its umbrella, confirmed by a second question.

### Pull request and issue pages

- **Failing CI on a pull request:** for each failed Prow job, whether the PR broke it, or it is a flake or infra. It
  reads:
  - the run's junit and log;
  - the job's runs on this PR;
  - the same tests' record on other PRs;
  - Jev's file-by-file reading of the diff.

  A PR-caused failure links the likeliest changed file. The section shows the `/retest` or `/test` command to copy.
  Read-only.

- **CI history and duplicates on an issue:** whether the failure it reports still happens, with the fresh-fix guard
  and a closed issue failing again. It also finds duplicates and concretely related issues, current and past, from
  six searches, each candidate read by Jev with both threads. Read-only.
- The board's verdict appears as a section in the issue or PR sidebar.
- On these pages nothing asks Jev until you click Judge, Check failures or Check. The same button then reads Judge
  again / Check again.

### Settings, keys and writes

- **Two Jev providers:** TypeSafe and OpenRouter, each with its own key and model. OpenRouter reports each call's
  cost.
- **Where writes go**, listed on the settings page: Apply and Accept write to the known boards, and TestGrid's
  comments and issues go to kubernetes/kubernetes and kubernetes/test-infra.
- **An allow-list guards every write:** Status moves of the one item, and only the comment shapes the extension
  drafts.
- **Keys are kept from web pages:**
  - the extension's storage is closed to the scripts it runs on GitHub and TestGrid;
  - those scripts get settings with the keys blanked;
  - only the settings page can change settings;
  - Save waits until the stored settings are loaded.

### Under the hood

- GitHub calls go through Octokit.js (REST API version `2026-03-10`), and Jev calls through the TypeSafe SDK.
- A rate limit is waited out with backoff, and the service worker is kept alive meanwhile. Other failures retry
  briefly.
- A parity test suite checks the logic against a frozen snapshot of the original Python CLI's outputs. No Python is
  needed to build, test or run.
- `npm run judge` runs the same core from the terminal against a live board, read-only.
