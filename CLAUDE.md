# Notes for Claude

## Testing against a board

Every real SIG Node board has a private test copy under `harche`. **Test a board's workflows only on its test
copy, never on the real board.** Real boards may be read to compare, never written to.

| Real board (read only)                   | Test copy (test and write here)                                             | Registered as |
| ---------------------------------------- | --------------------------------------------------------------------------- | ------------- |
| kubernetes/151, "SIG Node CI/Test Board" | https://github.com/users/harche/projects/5, "SIG Node CI/Test Board (test)" | `harche/5`    |
| kubernetes/185, "SIG Node Bugs"          | https://github.com/users/harche/projects/6, "SIG Node Bugs (test)"          | `harche/6`    |

Both test boards take their items from the private repo `harche/sig-node-board-test`. Everything there is fake
and safe to change. Their auto-add filters don't overlap, so a new issue lands on only one of the two test
boards. There is no Prow in the test repo, so set labels directly rather than with `/sig`, `/kind` or `/triage`
commands. A test board is registered in `src/core/boards.ts` with `writable: true`. Only writable boards take
Apply/Accept writes, so any new real board needs its own test copy before its workflows are tested.

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
  (#34), DRA (#35), already `triage/needs-information` (#36). Add more the same way as other columns are built.

### Access

- **Token:** a fine-grained GitHub token has one resource owner. The test boards need their own token with
  resource owner `harche` (read access to `sig-node-board-test` and to Projects), or a classic token.
- **`gh`:** logged in as `harche` on this machine, with `repo` and `project` scopes. Use it to reset or add test
  items.

## Working agreements

- Don't run the test suite or test against live boards unless the user asks.
