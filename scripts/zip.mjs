// Packs dist/ into sig-node-board-assistant-<version>.zip for the Chrome Web Store or a GitHub release.
// Refuses a test build: its private test boards and test repo must never ship.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
if (manifest.version !== version) {
  throw new Error(`manifest version ${manifest.version} does not match package.json ${version}`);
}
const leaked = readdirSync("dist").filter(
  (f) => /\.(js|json|html)$/.test(f) && readFileSync(`dist/${f}`, "utf8").includes("harche"),
);
if (leaked.length > 0) throw new Error(`dist/ is a test build (${leaked.join(", ")}): run a normal build`);
const out = `sig-node-board-assistant-${version}.zip`;
execFileSync("zip", ["-qr", `../${out}`, "."], { cwd: "dist", stdio: "inherit" });
console.info(`wrote ${out}`);
