import { send, type Settings } from "../shared/messages";

const FIELDS: (keyof Settings)[] = ["githubToken", "typesafeApiKey", "typesafeModel"];
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
}

async function save(): Promise<void> {
  const patch: Partial<Settings> = {};
  for (const f of FIELDS) patch[f] = $<HTMLInputElement>(f).value.trim();
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
  btn.disabled = true;
  say("Testing…");
  check("githubCheck", null, "");
  check("typesafeCheck", null, "");
  try {
    await save();
    const r = await send({ type: "settings.test" });
    check("githubCheck", r.github.ok, r.github.ok ? `Works: ${r.github.detail}.` : r.github.detail);
    check("typesafeCheck", r.typesafe.ok, r.typesafe.ok ? `Works: ${r.typesafe.detail}.` : r.typesafe.detail);
    say(
      r.github.ok && r.typesafe.ok
        ? "Saved. Both connections work."
        : "Saved. One connection failed, see above.",
      r.github.ok && r.typesafe.ok ? "ok" : "bad",
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

void load();
