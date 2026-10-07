// Packs dist/ into sig-node-board-assistant-<version>.zip for the Chrome Web Store or a GitHub release.
// Refuses a test build: its private test boards and test repo must never ship.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
if (manifest.version !== version) {
  throw new Error(`manifest version ${manifest.version} does not match package.json ${version}`);
}
// What only a test build has: the test repo, the test boards and the test-token hint. The extension's own repo
// (harche/sig-node-board-assistant, where feedback goes) is in every build.
const TEST_MARKERS = ["sig-node-board-test", "users/harche", "resource owner harche"];
const leaked = readdirSync("dist").filter((f) => {
  if (!/\.(js|json|html)$/.test(f)) return false;
  const text = readFileSync(`dist/${f}`, "utf8");
  return TEST_MARKERS.some((m) => text.includes(m));
});
if (leaked.length > 0) throw new Error(`dist/ is a test build (${leaked.join(", ")}): run a normal build`);
const out = `sig-node-board-assistant-${version}.zip`;
execFileSync("zip", ["-qr", `../${out}`, "."], { cwd: "dist", stdio: "inherit" });
console.info(`wrote ${out}`);
