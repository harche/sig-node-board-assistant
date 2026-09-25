# Contributing

Thanks for helping keep the SIG Node boards tidy.

## Ground rules

- **Writes go through one door.** `item.apply` is the only write request, and the worker runs it only on
  boards marked `writable` in `src/core/boards.ts` (today the private test board) and only for moves of that
  item and comments the extension drafts. A new kind of write extends that allow-list and its tests; it does
  not add a second path.
- **Prompts and policy live here.** `tests/parity.test.ts` checks them against `tests/fixtures/parity.json`, a
  frozen snapshot of the original CLI's outputs. An intended behaviour change updates the affected fixture
  entries in the same commit and says why.
- **No secrets in the repo.** Tokens live in the browser's extension storage only.

## Setup

```bash
npm install
npm run watch
```

Load `dist/` as an unpacked extension in `chrome://extensions` and reload it after each rebuild.

## Before opening a pull request

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

CI runs the same. Keep commits focused; the first line of a commit message says what changed and why.

## Adding a board or a workflow

1. Add the board to `KNOWN_BOARDS` in `src/core/boards.ts` with the column each workflow decorates.
2. Put the workflow's prompts in `src/core/prompts/` and its policy next to `policy.ts`.
3. Add a message type for it in `src/shared/messages.ts` and a case in the background worker.
4. Add unit tests for the workflow's signals and policy next to the existing ones.
