/** Developer tool: run the extension's core (GitHub REST + Jev + policy) from the terminal, no browser.
 *
 *   npm run judge -- kubernetes/151                 # every card in the Triage column
 *   npm run judge -- kubernetes/kubernetes#142303   # one issue or PR, as if it were on the board
 *
 * Reads GITHUB_TOKEN (else `gh auth token`) and TYPESAFE_API_KEY. Prints the same result the drawer shows and
 * the proposed commands. It runs nothing: this is the read-only path, end to end. */
import { execFileSync } from "node:child_process";
import { knownBoard } from "../src/core/boards";
import { GitHubClient } from "../src/core/github";
import { JevClient } from "../src/core/jev";
import { judge, proposedActions } from "../src/core/triage";
import type { BoardItem, TriageResult } from "../src/core/types";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: npm run judge -- OWNER/NUMBER | OWNER/REPO#NUMBER [--json path]");
  process.exit(2);
}
const jsonOut = process.argv.includes("--json")
  ? process.argv[process.argv.indexOf("--json") + 1]
  : undefined;

const githubToken =
  process.env.GITHUB_TOKEN || execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
const typesafeKey = process.env.TYPESAFE_API_KEY ?? "";
const gh = new GitHubClient(githubToken);
const jev = new JevClient({ apiKey: typesafeKey });

async function itemsFor(
  spec: string,
): Promise<{ items: BoardItem[]; board: { owner: string; number: number } }> {
  const one = /^([^/]+\/[^#]+)#(\d+)$/.exec(spec);
  if (one) {
    const [, repo, n] = one;
    const num = Number(n);
    const iss = await gh.api<{
      node_id: string;
      title: string;
      html_url: string;
      state: string;
      pull_request?: unknown;
      labels: { name: string }[];
      assignees: { login: string }[];
      updated_at: string;
      closed_at: string | null;
      draft?: boolean;
    }>(`/repos/${repo}/issues/${num}`);
    const item: BoardItem = {
      id: "PVTI_not_on_board",
      restId: 0,
      status: "Triage",
      type: iss.pull_request ? "PullRequest" : "Issue",
      number: num,
      url: iss.html_url,
      repository: repo!,
      title: iss.title,
      state: iss.state,
      merged: false,
      draft: Boolean(iss.draft),
      labels: iss.labels.map((l) => l.name),
      assignees: iss.assignees.map((a) => a.login),
      updatedAt: iss.updated_at,
      closedAt: iss.closed_at,
    };
    return { items: [item], board: { owner: "kubernetes", number: 151 } };
  }
  const [owner, n] = spec.split("/");
  const board = { owner: owner!, number: Number(n) };
  const column = knownBoard(board)?.workflows.triage;
  if (!column) throw new Error(`${spec} has no triage workflow`);
  return { items: await gh.itemsIn(board, column), board };
}

const { items, board } = await itemsFor(arg);
const fields = await gh.fields(board);
console.log(`${fields.title}: ${items.length} item(s)\n`);
const results: TriageResult[] = [];
for (const item of items) {
  const detail = await gh.itemDetail(item.repository, item.type, item.number);
  const r = await judge(item, detail, jev);
  results.push(r);
  const { accept, reject, recommended } = proposedActions(item, r, fields);
  console.log(`${r.verdict.padEnd(10)} ${item.repository}#${item.number}  ${item.title}`);
  console.log(`  why       ${r.why}`);
  console.log(
    `  bucket    ${r.answers.bucket.choice} (${r.answers.bucket.confidence.toFixed(2)})   owner ${r.answers.owner.choice} (${r.answers.owner.confidence.toFixed(2)})`,
  );
  console.log(
    r.priority === null
      ? `  priority  - (removing)`
      : `  priority  ${r.priority} (${r.priority_why})   lane ${r.lane}`,
  );
  console.log(
    `  jev       ${r.state_chars.toLocaleString()} chars, ${r.usage.input_tokens} tokens, $${r.usage.cost.toFixed(5)}`,
  );
  for (const [name, a] of [
    ["accept", accept],
    ["reject", reject],
  ] as const) {
    if (!a) continue; // an item Jev says to remove is only ever archived
    console.log(`  ${name}${recommended === name ? " (recommended)" : ""}: ${a.label}`);
    for (const c of a.ghCommands) console.log(`      ${c}`);
  }
  console.log();
}
console.log(
  `Jev: ${jev.ledger.calls} calls, ${jev.ledger.input_tokens.toLocaleString()} input tokens, $${jev.ledger.cost.toFixed(4)}`,
);
if (jsonOut) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(jsonOut, JSON.stringify({ items, fields, results }, null, 1));
  console.log(`wrote ${jsonOut}`);
}
