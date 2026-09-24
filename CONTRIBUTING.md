# Contributing

Thanks for helping keep the SIG Node boards tidy.

## Ground rules

- **Read-only stays read-only** until the approve step lands as an explicit, opt-in feature. A pull request
  that adds a write call to `src/core/github.ts` or a write request to `src/shared/messages.ts` will be
  asked to move it behind that feature.
- **Prompts and policy are shared with the CLI.** Change them in
  [sig-node-ci-assistant](https://github.com/harche/sig-node-ci-assistant) first, regenerate the fixture
  (`npm run fixtures`, with the CLI checked out next to this repo), then port. `tests/parity.test.ts` is the
  contract.
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
4. Extend the parity fixture script so the CLI's version of the workflow is the oracle.
