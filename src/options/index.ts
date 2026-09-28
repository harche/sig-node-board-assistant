import { KNOWN_BOARDS } from "../core/boards";
import { TG_LIVE_REPOS, TG_TEST_REPO } from "../core/tgreview";
import { send, type Settings } from "../shared/messages";

const FIELDS = [
  "githubToken",
  "typesafeApiKey",
  "typesafeModel",
  "openrouterApiKey",
  "openrouterModel",
] as const;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $<HTMLSpanElement>("status");

function say(text: string, cls = ""): void {
  status.textContent = text;
  status.className = `status ${cls}`;
}

function check(id: string, ok: boolean | null, text: string): void {
  const el = $<HTMLDivElement>(id);
  el.textContent = text;
  el.className = `check ${ok === null ? "" : ok ? "ok" : "bad"}`;
}

async function load(): Promise<void> {
  const { settings } = await send({ type: "settings.get" });
  for (const f of FIELDS) $<HTMLInputElement>(f).value = settings[f];
  provider.value = settings.jevProvider;
  showProvider();
  testMode.checked = settings.testMode;
  showWrites(settings.testMode);
  // Saving before the stored settings are in the form would write the form's blanks over them (the keys, and test
  // mode, which is on in the HTML so an early save can never turn it off).
  loaded = true;
  $<HTMLButtonElement>("save").disabled = false;
  $<HTMLButtonElement>("test").disabled = false;
}

let loaded = false;

async function save(): Promise<void> {
  if (!loaded) throw new Error("Settings are still loading.");
  const patch: Partial<Settings> = {};
  for (const f of FIELDS) patch[f] = $<HTMLInputElement>(f).value.trim();
  patch.jevProvider = provider.value === "openrouter" ? "openrouter" : "typesafe";
  if (__TEST_BUILD__) patch.testMode = testMode.checked;
  await send({ type: "settings.set", settings: patch });
}

$<HTMLFormElement>("form").addEventListener("submit", (e) => {
  e.preventDefault();
  void save()
    .then(() => say("Saved.", "ok"))
    .catch((err: Error) => say(err.message, "bad"));
});

$<HTMLButtonElement>("test").addEventListener("click", async () => {
  const btn = $<HTMLButtonElement>("test");
  if (!loaded) return;
  btn.disabled = true;
  say("Testing…");
  check("githubCheck", null, "");
  check("jevCheck", null, "");
  try {
    await save();
    const r = await send({ type: "settings.test" });
    check("githubCheck", r.github.ok, r.github.ok ? `Works: ${r.github.detail}.` : r.github.detail);
    check("jevCheck", r.jev.ok, r.jev.ok ? `Works: ${r.jev.detail}.` : r.jev.detail);
    say(
      r.github.ok && r.jev.ok ? "Saved. Both connections work." : "Saved. One connection failed, see above.",
      r.github.ok && r.jev.ok ? "ok" : "bad",
    );
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), "bad");
  } finally {
    btn.disabled = false;
  }
});

$<HTMLButtonElement>("clear").addEventListener("click", async () => {
  const { removed } = await send({ type: "cache.clear" });
  say(`Cache cleared, ${removed} entries removed.`, "ok");
});

/** Where writes go, from the code that enforces it: the boards that take writes, and where TestGrid's go. */
function showWrites(testMode: boolean): void {
  const link = (href: string, text: string) =>
    Object.assign(document.createElement("a"), {
      href,
      target: "_blank",
      rel: "noopener",
      textContent: text,
    });
  const board = (b: (typeof KNOWN_BOARDS)[number]) =>
    link(
      `https://github.com/${b.owner === "kubernetes" ? "orgs" : "users"}/${b.owner}/projects/${b.number}`,
      `${b.owner}/${b.number}`,
    );
  const item = (...parts: (Node | string)[]) => {
    const li = document.createElement("li");
    li.append(...parts);
    return li;
  };
  const joined = (bs: typeof KNOWN_BOARDS) => bs.flatMap((b, i) => (i ? [", ", board(b)] : [board(b)]));
  const tests = KNOWN_BOARDS.filter((x) => x.writable);
  const real = KNOWN_BOARDS.filter((x) => !x.writable);
  const hint = $<HTMLParagraphElement>("testModeHint");
  hint.hidden = !__TEST_BUILD__;
  hint.textContent = testMode
    ? "On: the real boards and kubernetes/kubernetes are only read."
    : "Off: Apply and Accept write to the real boards and to kubernetes/kubernetes, as your token's owner.";
  hint.className = `hint ${testMode ? "" : "bad"}`;
  $<HTMLUListElement>("writes").replaceChildren(
    item("Boards: ", ...joined(testMode ? tests : [...real, ...tests])),
    testMode
      ? item(
          "TestGrid: new issues, and comments for a kubernetes/kubernetes issue on its [mirror] issue, in ",
          link(`https://github.com/${TG_TEST_REPO}/issues`, TG_TEST_REPO),
        )
      : item(`TestGrid: new issues and comments in ${TG_LIVE_REPOS.join(" and ")}`),
    ...(testMode ? [item("Read only: ", ...joined(real), ", kubernetes/kubernetes")] : []),
  );
}

const testMode = $<HTMLInputElement>("testMode");
// Only a test build has test mode (shared/build.d.ts); a normal build lists where writes go, without the switch.
if (__TEST_BUILD__) {
  $<HTMLHeadingElement>("writesTitle").firstChild!.textContent = "Test mode ";
  $<HTMLLabelElement>("testModeToggle").hidden = false;
  $<HTMLLIElement>("testModePromise").hidden = false;
}
const provider = $<HTMLSelectElement>("jevProvider");

/** Only the chosen provider's key and model are shown. */
function showProvider(): void {
  for (const el of document.querySelectorAll<HTMLElement>("[data-provider]"))
    el.hidden = el.dataset.provider !== provider.value;
}
provider.addEventListener("change", showProvider);
testMode.addEventListener("change", () => showWrites(testMode.checked));

// Save stays disabled until the settings are in the form; if they cannot be read, say so rather than leave it dead.
void load().catch((e: unknown) =>
  say(
    `Couldn't read the saved settings (${e instanceof Error ? e.message : String(e)}): reload this page.`,
    "bad",
  ),
);
