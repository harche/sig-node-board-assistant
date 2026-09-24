# Notes for Claude

## Testing against a board

- **Test board:** https://github.com/users/harche/projects/5, "SIG Node CI/Test Board (test)", private. Its items
  live in the private repo `harche/sig-node-board-test`: issues #1–8 and PRs #9–11, all fake and safe to change.
  It is registered in `src/core/boards.ts` as `harche/5` with the triage workflow.
- **Never test against kubernetes/151**, and never write to it. It is the real board; read it only to compare.
- **It matches 151** in Status columns (names, order, descriptions), views ("CI/Test" board grouped by Status,
  "View 5" table) and the status workflows (added/reopened → Triage, closed/merged → Done, changes requested →
  PRs Waiting on Author, approved → PRs - Needs Approver). The one difference: the account's plan allows a single
  auto-add workflow, so 151's three k/k auto-add rules are one combined filter,
  `is:issue,pr is:open label:sig/node label:area/test,kind/failing-test,kind/flake`. 151's test-infra rule has no
  counterpart. There is no Prow here, so labels are set directly rather than by `/sig` and `/kind` commands.
- **Token:** a fine-grained GitHub token has one resource owner, so the test board needs its own token with
  resource owner `harche` (read access to `sig-node-board-test` and to Projects), or a classic token.
- `gh` on this machine is logged in as `harche` with `repo` and `project` scopes. Use it to reset or add test
  items.

## Working agreements

- Don't run the test suite or test against live boards unless the user asks.
