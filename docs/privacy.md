# Privacy policy

SIG Node Board Assistant is a Chrome extension for the maintainers of Kubernetes SIG Node. It has no backend: its
author runs no server and collects no data. Everything it does happens in your browser, between you, GitHub, TestGrid
and the Jev provider you pick.

## What it stores

- **Your credentials:** a GitHub personal access token and a key for Jev (TypeSafe or OpenRouter), entered on the
  settings page.
- **Your settings**, and a **cache** of fetched GitHub data and Jev answers, so a revisited page loads without asking
  again.

All of it is kept in the browser's local extension storage (`chrome.storage.local`), on your computer only. It is never
synced and never sent to the author. The scripts the extension runs on web pages cannot read it: only the extension's
background worker and its settings page can. Removing the extension deletes it.

## What it sends, and where

| Destination                                        | What is sent                                                                                                                              | Why                                                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `api.github.com`                                   | your GitHub token, and requests for the issues, pull requests, boards and CI results you view                                             | to read them, and, only when you click Apply or Accept, to post the comment or move shown |
| `api.typesafe.ai` or `openrouter.ai` (your choice) | your Jev key, and text from the GitHub issues, pull requests and CI results being judged: titles, threads, labels, file names, test names | to get the probabilities behind each suggestion                                           |
| `testgrid.k8s.io`, `storage.googleapis.com`        | requests for public test results, with no credentials                                                                                     | to read CI history                                                                        |

Nothing else is sent anywhere. The extension has no analytics, no tracking and no ads, and it does not read pages
other than GitHub project boards, GitHub issue and pull request pages, and TestGrid.

The Jev provider handles what it receives under its own privacy policy:
[TypeSafe](https://typesafe.ai) or [OpenRouter](https://openrouter.ai/privacy).

## What it does not do

- It does not sell or transfer your data to anyone, or use it for anything other than the suggestions it shows you.
- It does not use your data for advertising, credit or lending decisions.
- It never writes to GitHub on its own. Every comment or move is shown to you first and is written only when you click.

## Contact

Open an issue at [harche/sig-node-board-assistant](https://github.com/harche/sig-node-board-assistant/issues).
