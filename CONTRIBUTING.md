# Contributing

Thanks for helping keep the SIG Node boards tidy. Issues and pull requests are welcome: bug reports, a verdict you
think is wrong (with a link to the item), and new workflows.

## Setup

```bash
npm install
npm run watch
```

Load `dist/` as an unpacked extension in `chrome://extensions`, and reload it there after each rebuild. The
extension's settings page takes a GitHub token and a Jev key (see the [README](README.md#configure)).

## Before opening a pull request

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

CI runs the same. Keep commits focused, and let the first line of a commit message say what changed and why.

## Ground rules

- **Writes go through one door.** `item.apply` is the only write request. The worker runs it only where test mode
  allows, only for a Status move of that item, and only for comments in the shapes the extension drafts
  (`src/core/comments.ts`). A new kind of write extends that allow-list and its tests. It does not add a second path.
- **Test writes on a test copy, never on a real board.** Only a test build (`npm run build:test` or
  `npm run watch:test`) has test mode, the private test copies of the boards (`src/core/boards.ts`, `writable: true`)
  and the test repo (`TG_TEST_REPO`); a normal build leaves them out. In a test build test mode starts on and keeps
  writes on the test copies. To test a workflow's writes, make your own copy of the board (the project's "Make a
  copy"), point its auto-add rule at a repository of your own, and register it in `TEST_BOARDS` the same way.
- **Read-only features may be tried on real items.** The PR page's Failing CI and the issue page's checks only read,
  so try them on real kubernetes/kubernetes pull requests and issues.
- **Code computes, Jev decides, policy is code.** Facts that are cheap to get right (labels, dates, review state)
  are computed. Jev answers calibrated questions about what needs reading. A policy function turns the answers into
  an action with fixed thresholds. Tune a threshold on real history, and record the trial in
  [docs/design.md](docs/design.md).
- **Prompts and policy are pinned.** `tests/parity.test.ts` checks them against `tests/fixtures/parity.json`, a
  frozen snapshot of the original CLI's outputs. An intended behaviour change updates the affected fixture entries
  in the same commit and says why.
- **No secrets in the repo.** Tokens and keys live in the browser's extension storage only.

## Adding a board or a workflow

1. Add the board to `REAL_BOARDS` in `src/core/boards.ts`, with the column each workflow decorates, and a test copy
   with `writable: true` to `TEST_BOARDS`.
2. Put the workflow's prompts in `src/core/prompts/`, and its facts and policy in `src/core/`.
3. Register the column's workflow in `src/content/workflows.ts`, and add its message type to
   `src/shared/messages.ts` with a case in the background worker.
4. Add unit tests for the workflow's facts and policy next to the existing ones.
5. Describe it in [docs/workflows.md](docs/workflows.md), and its trial in [docs/design.md](docs/design.md).
