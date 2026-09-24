// Packs dist/ into sig-node-board-assistant-<version>.zip for the Chrome Web Store or a GitHub release.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const out = `sig-node-board-assistant-${version}.zip`;
execFileSync("zip", ["-qr", `../${out}`, "."], { cwd: "dist", stdio: "inherit" });
console.info(`wrote ${out}`);
