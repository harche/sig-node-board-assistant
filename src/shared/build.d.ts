/** Whether this is a test build (`npm run build:test`, `npm run watch:test`): only a test build has test mode, the
 *  private test boards (boards.ts `writable`) and the test repo (tgreview.ts TG_TEST_REPO). esbuild replaces it with
 *  a literal (scripts/build.mjs), so a normal build leaves them out of the bundle; the tests run as a test build
 *  (vitest.config.ts). */
declare const __TEST_BUILD__: boolean;

/** The git commit the bundle was built from (short SHA, "-dirty" when the tree had changes), for feedback issues. */
declare const __BUILD_COMMIT__: string;
