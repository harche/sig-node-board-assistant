# Chrome Web Store listing

The text and images for the store listing, kept here so each release can paste them from one place. Upload the zip from
`npm run zip`.

## Store listing

- **Category:** Developer Tools
- **Language:** English
- **Summary** (from the manifest, 132 characters at most): Jev-judged suggestions for the SIG Node GitHub project boards
  and TestGrid dashboards, with the evidence behind each.
- **Screenshots** (1280×800): `board.png`, `testgrid.png`, `pr-failing-ci.png`, `issue-checks.png`
- **Small promo tile** (440×280): `promo-small.png`
- **Homepage:** https://github.com/harche/sig-node-board-assistant
- **Support:** https://github.com/harche/sig-node-board-assistant/issues

### Description

```text
A tool for Kubernetes SIG Node maintainers. It helps triage the SIG Node project boards, CI failures and flaky tests, right on the GitHub and TestGrid pages you already use.

PROJECT BOARDS
Click Tackle on a column of the SIG Node CI/Test, SIG Node Bugs or Dynamic Resource Allocation board. Each card gets a suggested action: keep or remove, close as fixed or as a duplicate, nudge a quiet assignee, /cc reviewers picked from who actually reviews that code, or move the card to the column its state calls for. Hover a card for the evidence. Change the action if you disagree, then Apply it, or Accept the whole column.

TESTGRID
On a SIG Node dashboard, Tackle reads every failing and flaky job. It works out what fails, whether an issue already tracks it, and whether to comment on that issue or file a new one from the kubernetes/kubernetes template.

PULL REQUESTS AND ISSUES
On a pull request with a failed Prow job, Check failures says for each job whether the PR broke it, and shows the /retest or /test command for the rest. On a SIG Node or DRA issue, Check says whether the failure it reports is still happening, and finds duplicates and related issues.

HOW IT DECIDES
Code gathers the facts: labels, review state, assignees, CI history. Jev, a decision model, answers calibrated questions about them, such as "is this resolved?". Fixed thresholds turn the answers into one action, and every suggestion shows how it was reached.

SAFE BY DEFAULT
Nothing is written until you click, and you see the exact comment or move first. The PR and issue checks never write: they only show a command for you to post.

WHAT YOU NEED
A GitHub personal access token, and a key for Jev from TypeSafe (typesafe.ai) or OpenRouter (openrouter.ai). Judging a card costs about $0.0002.

PRIVACY
There is no backend. Your token and key stay in your browser's local extension storage. The extension talks only to GitHub, your chosen Jev provider, and TestGrid's public data.

Open source (Apache-2.0): https://github.com/harche/sig-node-board-assistant
```

## Privacy practices

- **Single purpose:** Help Kubernetes SIG Node maintainers triage their GitHub project boards, CI failures and flaky
  tests, by suggesting an action for each item, with its evidence, on the GitHub and TestGrid pages they use.
- **`storage`:** Keeps the user's GitHub token, Jev key and settings, and a cache of fetched GitHub data and Jev
  answers so revisited pages load without new requests. Local storage only, never synced.
- **Host permissions:**
  - `api.github.com`: reads the issues, pull requests, boards and CI results being triaged, and, only when the user
    clicks Apply or Accept, posts the comment or Status move shown to them.
  - `api.typesafe.ai`, `openrouter.ai`: the two providers of Jev, the decision model. The user picks one; the
    extension sends it the item's text and gets back the probabilities behind each suggestion.
  - `testgrid.k8s.io`, `storage.googleapis.com`: read the public Kubernetes CI results (TestGrid summaries, junit
    files and build logs) that the TestGrid review and CI history are built from.
  - Content scripts on `github.com` project boards, issue and pull request pages, and `testgrid.k8s.io`: add the
    suggestions, the Tackle and Check failures buttons and the sidebar sections to those pages. On an issue or PR page,
    nothing is sent to Jev until the user clicks Check.
- **Remote code:** No. All code is in the package.
- **Data usage:** collects **Authentication information** (the GitHub token and Jev key, stored locally) and
  **Website content** (issue and pull request text, sent to the chosen Jev provider). Certify all three statements:
  not sold or transferred except for the single purpose, not used for unrelated purposes, not used for credit.
- **Privacy policy:** https://github.com/harche/sig-node-board-assistant/blob/main/docs/privacy.md
