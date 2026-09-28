# Notes for Claude

## Test mode

Test mode exists only in a **test build**. When the user says "test mode", "test build" or "test against the test
boards", they mean this:

- **Build it:** `npm run build:test` (or `npm run watch:test`), then load `dist/` unpacked in Chrome. A plain
  `npm run build`, `npm run watch` or `npm run zip` is a normal build: no test mode, no test boards, no test repo.
  Releases are always normal builds.
- **How it works:** `scripts/build.mjs --test` (or `SNBA_TEST=1`) sets the global `__TEST_BUILD__`
  (`src/shared/build.d.ts`) to `true`. It gates `TEST_BOARDS` in `src/core/boards.ts`, `TG_TEST_REPO` in
  `src/core/tgreview.ts`, the Test mode switch on the settings page, and `Settings.testMode`. In a normal build esbuild
  drops all of it (check with `grep harche dist/*.js`: no hits), and `loadSettings` forces `testMode` off, so a value
  saved by a test build never steers a normal build's writes. Vitest runs as a test build (`vitest.config.ts`).
- **The switch:** in a test build, test mode starts on (settings page, `Settings.testMode`). On, Apply and Accept write
  only to the test copies below, and TestGrid writes only to `harche/sig-node-board-test`. Off, they write to the real
  boards and kubernetes/kubernetes. Keep it on in every browser profile used for testing, and never turn it off unless
  the user asks.
- **Why it's gated:** the test boards and repo are private to `harche`. Nobody else can use them, so normal builds
  leave them out. They stay in git, so they can't drift from the code.
- **User-facing docs don't mention test mode** (README, docs/, CHANGELOG). Only this file and CONTRIBUTING.md do.

## Testing against a board

Every real SIG Node board has a private test copy under `harche`. **Test a board's workflows only on its test
copy, in a test build with test mode on, never on the real board.** Real boards may be read to compare, never written
to.

| Real board (read only)                       | Test copy (test and write here)                                                  | Registered as |
| -------------------------------------------- | -------------------------------------------------------------------------------- | ------------- |
| kubernetes/151, "SIG Node CI/Test Board"     | https://github.com/users/harche/projects/5, "SIG Node CI/Test Board (test)"      | `harche/5`    |
| kubernetes/185, "SIG Node Bugs"              | https://github.com/users/harche/projects/6, "SIG Node Bugs (test)"               | `harche/6`    |
| kubernetes/95, "Dynamic Resource Allocation" | https://github.com/users/harche/projects/7, "Dynamic Resource Allocation (test)" | `harche/7`    |

All test boards take their items from the private repo `harche/sig-node-board-test`. Everything there is fake
and safe to change. The CI/Test and Bugs filters don't overlap, so a new issue lands on only one of those two.
The DRA filter is 95's own (`label:"wg/device-management"`), so, as on the real boards, a DRA bug with `kind/bug`
and `sig/node` lands on both `harche/6` and `harche/7`: drop one of those labels to keep a test item on one board.
There is no Prow in the test repo, so set labels directly rather than with `/sig`, `/kind` or `/triage` commands.

A test board is registered in `TEST_BOARDS` (`src/core/boards.ts`) with `writable: true`. In test mode only writable
boards take Apply/Accept writes, so any new real board needs its own test copy before its workflows are tested.

### CI/Test test board (`harche/5`, copy of kubernetes/151)

- **Items:** issues #1–8 and PRs #9–11, plus any added since.
- **It matches 151** in:
  - Status columns: names, order, descriptions.
  - Views: the "CI/Test" board grouped by Status, and the "View 5" table.
  - Status workflows: added/reopened → Triage, closed/merged → Done, changes requested → PRs Waiting on Author,
    approved → PRs - Needs Approver.
- **Difference:** the account's plan allows one auto-add workflow. 151's three k/k auto-add rules are one
  combined filter here, `is:issue,pr is:open label:sig/node label:area/test,kind/failing-test,kind/flake`. 151's
  test-infra rule has no counterpart.

### Bugs test board (`harche/6`, copy of kubernetes/185)

- **How it was made:** with 185's "Make a copy". So these match 185:
  - Status columns: Triage, Needs Information, Triaged, High Priority, Done, with their descriptions.
  - The "Bugs" board view.
  - The workflows: added/reopened → Triage, closed → Done.
- **Difference:** 185 has two auto-add rules, k/k and k/website. The copy has one, using 185's k/k filter:
  `is:issue is:open label:kind/bug label:sig/node -label:kind/flake -label:kind/failing-test -label:area/test -label:area/test-infra`.
- **Labels:** the ones 185 uses were added to the test repo: `triage/needs-information`,
  `triage/not-reproducible`, `priority/critical-urgent`, `kind/regression`, `wg/device-management`, `sig/network`.
- **Items:** fake bug issues #29–36, one per Triage decision, based on real 185 issues: a clear bug (#29), a support
  question (#30), a feature (#31), co-owned storage code (#32), too thin to act on (#33), already `triage/accepted`
  (#34), DRA (#35), already `triage/needs-information` (#36), for Needs Information an answered request (#37), and
  for Triaged a bug the thread says is fixed (#38). The labels Prow would set are set directly on these issues.
  Reminders and closing need an ask 20+ days old, which cannot be backdated: unit tests cover those. Add more the
  same way as other columns are built. A reply posted within a minute of the label counts as part of the ask.

### DRA test board (`harche/7`, copy of kubernetes/95)

- **How it was made:** with 95's "Make a copy". So these match 95:
  - Status columns: 🆕 New, 📋 Backlog, 🔖 Ready, 🏗 In progress, 👀 In review, ✅ Done (no descriptions on 95).
  - Fields Priority, Size, Area and Release Goal, and the views All, By Milestone, By Status, Reliability,
    Enhancements and Core GA.
  - The workflows: item added → 🆕 New. "Item closed" and "Pull request merged" are **off** on 95 (they have no
    value set), so closed and merged items stay in their column until someone moves them.
- **Difference:** 95 has five auto-add rules: k/k, enhancements, test-infra and website with
  `is:issue,pr is:open label:"wg/device-management"`, and kubernetes-sigs/dra-example-driver with
  `is:issue,pr is:open`. The copy has one, 95's filter on the test repo.
- **Labels:** the ones 95's items use were added to the test repo, among them `sig/scheduling`, `sig/testing`,
  `sig/api-machinery`, `kind/api-change`, `kind/kep`, `needs-priority`, `lifecycle/stale`, `lifecycle/rotten`,
  `lead-opted-in`, `tracked/yes`, `stage/alpha|beta|stable`, `wg/workload-aware-scheduling`.
- **Items (New):** issues #39 (a sub-task: Ready), #41 (assigned bug with open fix PR #43: In progress), #42 (a gate
  removal in a later release: Backlog), #40 (closed, added by hand since auto-add only takes open items); PRs #43
  (open: In review), #44 (draft: In progress), #45 (merged: Done). All carry `wg/device-management` and none has
  `sig/node`, so they stay off `harche/6`. To test New again, move them back to 🆕 New.
- **Items (Backlog):** #42 (stays), #46 (KEP, milestone `v1.38` + `lead-opted-in`: In progress), #47 (KEP opted into
  `v1.36`: stays), #48 (closed: Done), #49 (open PR: In review). The test repo has milestones `v1.38` and `v1.36` and a
  `lead-opted-in` label. To test Backlog again, move them back to 📋 Backlog.
- **Items (Ready):** #39 (nobody started: stays), #50 (assigned, says they are on it, fix PR #51: In progress, your
  call), #52 (KEP opted into `v1.38`: In progress), #53 (closed: Done). To test Ready again, move them back to
  🔖 Ready.
- **Items (In progress):** #41, #44 (draft PR), #46 and #52 (KEPs in `v1.38`), #50 stay; #43 (open PR: In review),
  #45 (merged PR: Done), #47 (KEP opted into `v1.36`: Backlog), #54 (closed: Done). A fake KEP is marked by a
  `stage/*` label. To test In progress again, move the leavers back to 🏗 In progress.
- **Items (In review):** #43 and #49 (open PRs) stay. To test the leavers, move #44 (draft: In progress), #45
  (merged: Done), #54 (closed issue: Done) and an open issue such as #39 (In progress) into 👀 In review.

### TestGrid review

TestGrid (testgrid.k8s.io), GCS and GitHub search are only read; test on the real dashboards. Every write goes to
`harche/sig-node-board-test` (`TG_TEST_REPO` in `src/core/tgreview.ts`): new issues there, and comments for a
kubernetes/kubernetes issue on a `[mirror] kubernetes/kubernetes#N` issue there (#55 mirrors #142268; #56 is a filed
flaking-test issue). Never point writes at kubernetes/kubernetes without the user asking.

### Failing CI on the PR page, CI history and duplicates on the issue page

Read-only (they show a Prow command, never post it), so test them on real kubernetes/kubernetes items: PRs with
failing jobs (e.g. #142200), flake issues (e.g. #141786 open, #141469 closed and failing again). If they ever post,
the post goes through test mode like every other write.

### Access

- **Token:** a fine-grained GitHub token has one resource owner. The test boards need their own token with
  resource owner `harche` (read access to `sig-node-board-test` and to Projects), or a classic token.
- **`gh`:** logged in as `harche` on this machine, with `repo` and `project` scopes. Use it to reset or add test
  items.

## Working agreements

- Don't run the test suite or test against live boards unless the user asks.
