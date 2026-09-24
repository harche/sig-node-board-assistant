# Changelog

## 0.1.0 (unreleased)

First read-only release.

- Badge on every card in the Triage column of kubernetes/151: keep, remove, borderline.
- Evidence section inside GitHub's own sidebar: the project pane for issues, the PR page for pull requests.
  Verdict band, Jev's answers, the code-computed signals and the accept / archive alternatives with their
  `gh` commands.
- `npm run judge` runs the same core from the terminal against the live board, for development.
- Settings page for the GitHub token and TypeSafe key, with connection tests and a cache reset.
- Parity test suite against the Python CLI (signals, state, prompts, policy, commands).
- Policy: a confident "another SIG owns it" answer turns a KEEP into BORDERLINE (the CLI had dropped this).
- State: every human `/sig` or `/area` routing comment is sent to Jev as `human_routing`, not only those in
  the last-10 comment window.
