# Changelog

## 0.1.0 (unreleased)

First read-only release.

- Badge on every card in the Triage column of kubernetes/151: keep, remove, borderline.
- Evidence section inside GitHub's own sidebar: the project pane for issues, the PR page for pull requests.
  Verdict band, Jev's answers, the code-computed signals and the accept / archive alternatives with their
  `gh` commands.
- `npm run judge` runs the same core from the terminal against the live board, for development.
- Settings page for the GitHub token and TypeSafe key, with connection tests and a cache reset.
- Parity test suite against a frozen snapshot of the Python CLI's outputs (signals, state, prompts, policy,
  commands). No Python needed to build, test or run.
- GitHub calls go through Octokit.js (pagination via Link headers, retries on transient errors, REST API
  version `2026-03-10`); Jev calls go through the TypeSafe SDK (`@typesafe-ai/sdk`).
- Policy: a confident "another SIG owns it" answer turns a KEEP into BORDERLINE (the CLI had dropped this).
- State: every human `/sig` or `/area` routing comment is sent to Jev as `human_routing`, not only those in
  the last-10 comment window.
