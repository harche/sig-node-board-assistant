# Design

## The shape

```
GitHub Projects board page                 issue / PR page
 └─ content script (board)                  └─ content script (item)
     Tackle, badge, tint, hover card            is this item in a judged column?
     per card of a workflow column              evidence section in the page sidebar
     evidence section in GitHub's item pane
      │  typed messages (reads; one checked write request, item.apply)
 └─ background worker       tokens, cache, GitHub REST, Jev, TestGrid; the write allow-list
      └─ src/core           pure functions: signals, state, prompts, policy, testgrid, triage, todo
```

There is little UI of our own: the column's Tackle / Accept / Cancel buttons, a badge per card, a hover card
and a status pill, all drawn with GitHub's own button classes and Primer colours. The evidence is one more section in the
sidebar GitHub already shows: the project pane for issues, the PR page for pull requests (GitHub has no PR
pane; a PR card opens a new tab). `src/content/adapters.ts` builds that section from the host page's own
markup: in the React pane it clones GitHub's "Fields" section header and field row and swaps the text, on the
classic PR page it uses `discussion-sidebar-item` and `discussion-sidebar-heading`. Colours and fonts are
Primer CSS variables, so the block follows the page's theme without a stylesheet of its own.

The content script owns nothing but DOM. It knows the board from the URL, finds cards by
`data-board-card-id` (the project item's REST id) inside `data-board-column="<column>"` for each column that
has a workflow (`src/content/workflows.ts`: Triage, Issues - To do), and asks the background worker for the
column's items and each item's verdict. GitHub's board is a React app with hashed
class names; those two data attributes are the only DOM contract, kept in `src/content/dom.ts`.

The background worker holds the tokens and makes every network call. The content script never sees a
token. `chrome.storage.local` is the cache (10 minutes for a column, 30 for an item, forever for a Jev
answer, the same TTLs as the CLI). TestGrid tables stay in the worker's memory for 30 minutes instead: they are
tens of KB each, and overflowing storage's 10 MB quota would clear the whole cache.

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

## Issues - To do

The To-do question is whether the problem an issue tracks is already resolved. The split holds:

- **Code computes** the thread (bots, Prow-only comments and email-reply spam dropped), the PRs that link to
  the issue with their merge dates, the assignees and labels, malformed Prow commands (`triage/accept`,
  `/priority imporant-soon`), and the CI run history. `src/core/testgrid.ts` reads TestGrid's JSON (a port of
  the CLI's `lib/testgrid.py`): the tabs come from the issue's TestGrid links, or from the Prow jobs it names,
  found by name among the SIG Node and release dashboards and confirmed by the tab's GCS query. Jobs named only
  in comments are used only when the title and description name none: a job someone mentions later is often
  a different one. Per job the state carries the named tests' rows (`tracked_tests`), the job's Overall row
  (`whole_job`, which also fails for tests the issue is not about) and the runs since the latest merged
  linked PR (`runs_after_fix`). TestGrid keeps about two weeks.
- **Jev answers** `resolved` (a noul) and `resolution` (fixed by a change, went green, obsolete, still open),
  in `src/core/prompts/todo.ts`, and, for a card missing its priority label, Triage's priority question.
- **The policy is code** (`src/core/todo.ts` `decideTodo`): archive without `sig/node`, then a duplicate, then
  P(resolved) ≥ 0.65 closes as fixed, then an assignee moves the card to In progress, then 0.35–0.65 asks the
  thread, else keep. The fresh-fix guard (`freshFixGuard`) holds a close until the tracked tests (or the
  title's job when no test was found) have been quiet for 3 days and for 3× their usual gap between failures.

The question was tuned offline on 66 kubernetes/151 issues: the 35 open ones in To do and In progress, and 31
closed in the two months before, each cut just before its closing comment with TestGrid seen as of then. Of
seven wordings the one kept scored no open issue ≥ 0.65 and 8 of 15 evidenced fixes ≥ 0.65 (5 more in the ask
band); longer criteria lists and a four-question decomposition scored worse. Injecting failures after the fix
into `ci_signal` pushed every resolved issue below 0.35, so Jev reads the run history rather than a
commenter's "seems green now".

Duplicates reuse the CLI's pairwise question after judging: each To-do card against the other To-do and
In-progress issues. On 2,145 pairs of 151 issues the four pairs humans closed as duplicates scored 0.69–0.90.
Pairs at or above 0.65 are grouped and each group keeps one issue (In progress, then assigned, then Jev's
strongest survivor), so pairwise picks that go round in a circle can never close them all.

## Issues - In progress

The CLI's stale pass decided with a regex for its own nudge wording, a window of comments, a "whose court is the
PR in" heuristic and a days-quiet sum, and each misfired somewhere: a "/assign" someone posted on a PR read as a
review, so a 171-day-quiet assignee counted as active. `src/core/inprogress.ts` keeps only plain facts in code
(assignment and comment dates, each assignee's latest own comment, commit or merge, and each linked PR's last
events marked by who made them) and asks Jev, in one call per card: for each comment since an assignee last acted,
is it a check-in to them (the comment's text goes in the question itself; pointing at it by index gave false
positives); is the assignee still on it (asked only past 30 days of quiet, since Jev is unreliable at date
comparisons); is the work moving through others. Code then does only date arithmetic: a check-in under 14 days
waits, 14 or more unassigns, none nudges, and asking the thread needs P ≥ 0.65 and no active assignee.

## PRs - Needs Reviewer

`src/core/reviewer.ts`: plain rules (state, draft, the `lgtm` / `needs-rebase` / `lifecycle` labels, who put a
`/hold`, including in a review), plain facts (every comment, review, push and human review request with its author
and date; people asked by `/cc`, `/assign` or a human request; the latest @-mention ping to each), and one Jev call:
whose move it is (author, reviewers, blocked), per participant whether they are reviewing and whether they
declined, and whether a reviewer's hold condition is met. Reviews that only left inline comments are kept as events:
dropping them hid a reviewer's request from Jev.

`src/core/candidates.ts` finds reviewers. The CLI ranked OWNERS approvers near the top; tested on 662 merged 151 PRs
that was one of the weakest signals (about half had an actual reviewer in its top 3), below who reviewed recent PRs
touching the same files. The extension gathers, per touched file and top directory, the last year's merged PRs and
their reviewers (one small GraphQL query per path; one large query timed out), plus the author's own recent PRs,
blends them with OWNERS as a small bonus, and lets Jev pick three of the best eight given each candidate's counts and
the titles they reviewed lately.

## PRs - Needs Approver

`src/core/approver.ts` reuses Needs Reviewer's facts and Jev call. Asks now include comments that @-mention someone
and that Jev reads as asking them to review or approve ("@x @y for approval"): only counting `/cc` and `/assign`
proposed a new ask on a PR the board owner had asked about a week earlier. Approvers: only an approver of an OWNERS
file covering the change can approve, so Prow's notifier comment ("Needs approval from an approver in each of these
files") gives the OWNERS files still open, `candidates.ts ownersChain` their approvers up to the root, and
`blendApprovers` ranks them by recent `/approve` comments on the same files, directories and author (from the same
history query as reviewers). On 150 PRs Jev picking among the ranked approvers matched the ranking's top 3 (75% vs
74%) with a worse first pick, so unlike reviewers the order is code. `coverApprovers` makes sure every open OWNERS
file has someone on the `/cc`.

## Broken Prow commands

`src/core/prowcmds.ts`, for every column. The To-do version was a regex plus the closest spelling; it could not tell
prose from a command. Now code flags a line only when it looks like a command Prow does not know (a bare lowercase
`/word` close to a real one, a fixed-value command with a value not on its list, or a `label/value` line), and Jev
chooses among the nearby real commands or "not a command". On 60 open 151 threads it flagged two lines: one fixed
(`triage/accept` → `/triage accepted`), one already satisfied (the label was set another way), none spurious.

## Writes

The CLI proposes, the human approves, then the CLI executes from an allow-list. The extension does the same:
the hover card shows the action with its exact comment and move, and nothing is written until the reviewer
clicks Apply (one card) or Accept (the column's suggestions). Writes go through one message, `item.apply`, and
the worker refuses it unless the board is marked `writable` (today only the private test copy of 151), every
move names that one project item, and every comment is on that item's issue and is one the extension drafts:
Triage's `/triage accepted` + `/priority`, To do's label fix, close-as-fixed, close-as-duplicate and
check-in comments, In progress's nudge, `/unassign @x` and check-in comments, or Needs Reviewer's `/cc` (up to three people, one
reason line each) and re-pings, or a Prow-command fix (routing, labels, `/assign`, `/cc` only) (`src/core/comments.ts`), and no
other Prow command. The header's Accept applies every suggestion in its column, comments included: clicking it
means the reviewer has read the cards and agrees.

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

## What the section shows and why (Triage)

Top to bottom, in the order a reviewer needs it: the verdict word and the band (the answer and the
mechanism), the one-sentence why, Jev's answers and the facts the code checked as label/value rows, then the
two things a reviewer could do with the recommended one first and marked, each with its commands behind a
disclosure. The one element that is ours rather than GitHub's is the band: it is the
policy's thresholds drawn to scale with the item's probability on it.
