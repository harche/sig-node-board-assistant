/** chrome.storage.local as a key-value store for the cache, and the settings record. Tokens live in
 *  storage.local (never storage.sync), so they stay on this machine. */
import type { KeyValueStore } from "../core/cache";
import { DEFAULT_SETTINGS, type Settings } from "../shared/messages";

const CACHE_PREFIX = "cache:";
const SETTINGS_KEY = "settings";

export class ChromeLocalStore implements KeyValueStore {
  async get(key: string) {
    const r = await chrome.storage.local.get(CACHE_PREFIX + key);
    return r[CACHE_PREFIX + key];
  }
  async set(key: string, value: unknown) {
    try {
      await chrome.storage.local.set({ [CACHE_PREFIX + key]: value });
    } catch (e) {
      // Quota exceeded: drop the whole cache rather than fail the request; everything in it is re-fetchable.
      console.warn("cache write failed, clearing cache:", e);
      await this.clearAll();
      await chrome.storage.local.set({ [CACHE_PREFIX + key]: value });
    }
  }
  async remove(key: string) {
    await chrome.storage.local.remove(CACHE_PREFIX + key);
  }
  async keys() {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all)
      .filter((k) => k.startsWith(CACHE_PREFIX))
      .map((k) => k.slice(CACHE_PREFIX.length));
  }
  async clearAll() {
    const keys = await this.keys();
    await chrome.storage.local.remove(keys.map((k) => CACHE_PREFIX + k));
    return keys.length;
  }
}

export async function loadSettings(): Promise<Settings> {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...((r[SETTINGS_KEY] as Partial<Settings> | undefined) ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}
