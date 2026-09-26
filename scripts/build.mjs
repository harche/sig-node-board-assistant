// Bundles the extension entry points with esbuild and copies the static files into dist/.
// `node scripts/build.mjs --watch` rebuilds on change (reload the unpacked extension in chrome://extensions).
import * as esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const outdir = "dist";

// Content scripts are classic scripts (no `export` allowed), so they and the options page are bundled as
// IIFEs; the service worker is declared `type: module` and stays ESM.
const common = {
  bundle: true,
  target: ["chrome116"],
  outdir,
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
  define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
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

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
  console.info("watching for changes…");
} else {
  for (const b of builds) await esbuild.build(b);
}
