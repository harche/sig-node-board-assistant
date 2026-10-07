// Bundles the extension entry points with esbuild and copies the static files into dist/ (release/ with --release).
// `node scripts/build.mjs --watch` rebuilds on change (reload the unpacked extension in chrome://extensions).
// `--test` (or SNBA_TEST=1) makes a test build: test mode, the private test boards and the test repo are compiled in
// (src/shared/build.d.ts). Without it they are left out of the bundle.
// `--release` makes a normal build into release/ instead of dist/, for `npm run zip`, so the dist/ loaded in Chrome
// (a test build, say) is left alone.
import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const test = process.argv.includes("--test") || process.env.SNBA_TEST === "1";
const release = process.argv.includes("--release");
if (release && (test || watch))
  throw new Error("--release is a normal build: drop --test, SNBA_TEST and --watch");
const outdir = release ? "release" : "dist";
// The commit the bundle was built from, for feedback issues (core/feedback.ts): "-dirty" when the tree had changes.
const git = (...a) => {
  try {
    return execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};
const commit =
  (git("rev-parse", "--short", "HEAD") || "unknown") + (git("status", "--porcelain") ? "-dirty" : "");

// Content scripts are classic scripts (no `export` allowed), so they and the options page are bundled as
// IIFEs; the service worker is declared `type: module` and stays ESM.
const common = {
  bundle: true,
  target: ["chrome116"],
  outdir,
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
  define: {
    "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production"),
    __TEST_BUILD__: JSON.stringify(test),
    __BUILD_COMMIT__: JSON.stringify(commit),
  },
};
const builds = [
  { ...common, entryPoints: { background: "src/background/index.ts" }, format: "esm" },
  {
    ...common,
    entryPoints: {
      content: "src/content/index.ts",
      item: "src/item/index.ts",
      testgrid: "src/testgrid/index.ts",
      options: "src/options/index.ts",
    },
    format: "iife",
  },
];

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp("public", outdir, { recursive: true });
await cp("src/content/content.css", `${outdir}/content.css`);
await cp("src/options/options.html", `${outdir}/options.html`);

// A test build also runs on the private test boards and test repo (CLAUDE.md), which normal builds leave out.
if (test) {
  const path = `${outdir}/manifest.json`;
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const [board, item] = manifest.content_scripts;
  board.matches.push("https://github.com/users/harche/projects/*");
  item.matches.push(
    "https://github.com/harche/sig-node-board-test/pull/*",
    "https://github.com/harche/sig-node-board-test/issues/*",
  );
  await writeFile(path, JSON.stringify(manifest, null, 2) + "\n");
}

if (test) console.info("test build: test mode and the test boards are included");
if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
  console.info("watching for changes…");
} else {
  for (const b of builds) await esbuild.build(b);
}
