# Design

## The shape

```
GitHub Projects board page                 issue / PR page
 └─ content script (board)                  └─ content script (item)
     badge per Triage card                      is this item in a judged column?
     evidence section in GitHub's item pane     evidence section in the page sidebar
      │  typed messages (read requests only)     │
 └─ background worker       tokens, cache, GitHub REST (GET only), Jev
      └─ src/core           pure functions: signals, state, prompts, policy, lookup
```

There is no UI of our own beyond the badge and a status pill. The evidence is one more section in the
sidebar GitHub already shows: the project pane for issues, the PR page for pull requests (GitHub has no PR
pane; a PR card opens a new tab). `src/content/adapters.ts` builds that section from the host page's own
markup: in the React pane it clones GitHub's "Fields" section header and field row and swaps the text, on the
classic PR page it uses `discussion-sidebar-item` and `discussion-sidebar-heading`. Colours and fonts are
Primer CSS variables, so the block follows the page's theme without a stylesheet of its own.

The content script owns nothing but DOM. It knows the board from the URL, finds cards by
`data-board-card-id` (the project item's REST id) inside `data-board-column="Triage"`, and asks the
background worker for the column's items and each item's verdict. GitHub's board is a React app with hashed
class names; those two data attributes are the only DOM contract, kept in `src/content/dom.ts`.

The background worker holds the tokens and makes every network call. The content script never sees a
token. `chrome.storage.local` is the cache (10 minutes for a column, 30 for an item, forever for a Jev
answer, the same TTLs as the CLI).

## Jev decides, code computes

Jev is a decision model: it answers calibrated yes/no (noul), multiple-choice and score questions about a
JSON state. It does not generate text and it is not asked to. The split, inherited from the CLI:

- **Code computes facts** that are cheap to get right: who commented `/sig node`, whether
  `triage/accepted` is already set, the review decision, the share of changed files under test paths.
  These are shown to the reviewer and some of them override Jev (a human `/sig node` turns a REMOVE into
  BORDERLINE).
- **Jev judges** what needs reading: is the primary deliverable CI work, which SIG owns it. The prompts in
  `src/core/prompts/triage.ts` are the CLI's `prompts/triage/*.yaml`, and a test checks they still match.
- **The policy is code** (`src/core/policy.ts`): P(in scope) at or above 0.65 keeps, at or below 0.35
  removes, otherwise P(CI work) × P(node owns it) breaks the tie against the same thresholds. Two guards
  then hand the decision to a human: a REMOVE where someone wrote `/sig node` becomes BORDERLINE, and a
  KEEP where Jev is at least 0.6 confident another SIG owns the component becomes BORDERLINE. The section
  draws the band with a marker, so the reviewer sees the mechanism, not just the word.

## Read-only, on purpose

The CLI proposes, the human approves, then the CLI executes from an allow-list. This first version of the
extension stops at "proposes": it shows the accept and archive alternatives with the exact `gh` commands. The
GitHub client (Octokit) only issues GETs and the message protocol has no write request. When the approve step is
added it will be a separate, opt-in path with the same allow-list (Status moves and Prow comments), never
a default.

## Parity with the reference

`tests/fixtures/parity.json` was generated once from the Python CLI and is now frozen (the generator was removed
so the extension has no Python dependency). It holds, for every item in the CLI's cache: the normalised
item, the raw detail, the computed signals, the Jev state and its Python `json.dumps` length; plus the
questions for both item types, a 328-case grid over the decision policy, all 36 PR-lane combinations and
sample command lines. `tests/parity.test.ts` runs the TypeScript over the same inputs and expects the same
outputs, down to the "why" string. Two things had to be deliberate to make that hold:

- **Number formatting.** Python's `f"{x:.2f}"` rounds the exact binary value half-to-even; JavaScript's
  `toFixed` rounds half-up and V8 mis-rounds some values (`0.665 → "0.66"`). `policy.f2()` reproduces
  Python.
- **State size.** Truncation thresholds are measured in characters of Python's `json.dumps` output, which
  has different separators and escapes non-ASCII. `state.pyJsonLength()` reproduces that length.

The Jev cache key is `sha256(stableStringify(state) + stableStringify(questions))`, so a state built in a
different key order still hits. "Judge again" re-fetches the thread and bypasses that cache.

Where the port deliberately differs from the reference: the state carries every human routing comment as
`human_routing` (the reference only sent the last 10 comments, so an early `/sig node` was invisible to the
owner question), the description-trimming loop terminates when the description is exhausted, and the
ownership guard above is restored. The Python CLI is the historical reference; this repository is where the
policy lives now.

## What the section shows and why

Top to bottom, in the order a reviewer needs it: the verdict word and the band (the answer and the
mechanism), the one-sentence why, Jev's answers and the facts the code checked as label/value rows, then the
two things a reviewer could do with the recommended one first and marked, each with its commands behind a
disclosure, and a read-only note. The one element that is ours rather than GitHub's is the band: it is the
policy's thresholds drawn to scale with the item's probability on it.
