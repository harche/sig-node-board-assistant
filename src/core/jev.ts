/** TypeSafe Jev client. Jev answers calibrated yes/no (noul), multiple-choice and score questions about a JSON
 *  state; it never generates text and never acts. Answers are cached forever by hash(state + questions). */
import type { Cache } from "./cache";
import type { JevUsage } from "./types";

export interface JevConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /** TypeSafe reports tokens, not dollars; list price of jev-latest input tokens keeps the ledger an estimate. */
  usdPerMtok?: number;
}

export interface JevResponse<A> {
  answers: A;
  usage: JevUsage;
}

export const JEV_DEFAULTS = { baseUrl: "https://api.typesafe.ai", model: "jev-latest", usdPerMtok: 0.042 };

export class JevError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "JevError";
  }
}

export class JevClient {
  private baseUrl: string;
  private model: string;
  private usdPerMtok: number;
  readonly ledger = { calls: 0, cached: 0, input_tokens: 0, cost: 0 };

  constructor(
    private config: JevConfig,
    private cache: Cache,
    private fetchFn: typeof fetch = fetch,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    if (!config.apiKey) throw new JevError("no TypeSafe key: set it in the extension options");
    this.baseUrl = (config.baseUrl || JEV_DEFAULTS.baseUrl).replace(/\/$/, "");
    this.model = config.model || JEV_DEFAULTS.model;
    this.usdPerMtok = config.usdPerMtok ?? JEV_DEFAULTS.usdPerMtok;
  }

  async ask<A>(state: unknown, questions: Record<string, unknown>): Promise<JevResponse<A>> {
    // "/" is sent as the equivalent JSON escape "\/": Cloudflare in front of the API answers 403 to any body
    // containing a path like /etc/hosts, which kubelet issues quote all the time. The server decodes it back.
    const body = JSON.stringify({ model: this.model, state, questions }).replace(/\//g, "\\/");
    const r = await this.fetchFn(`${this.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
    });
    const text = await r.text();
    let j: { answers?: A; usage?: { input_tokens: number; output_tokens?: number }; error?: unknown };
    try {
      j = JSON.parse(text);
    } catch {
      // e.g. a Cloudflare challenge page: keep the start of the body so the user can see what answered
      throw new JevError(`TypeSafe HTTP ${r.status}: ${text.slice(0, 200)}`, r.status);
    }
    if (!j.answers || !j.usage)
      throw new JevError(`TypeSafe HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}`, r.status);
    const usage: JevUsage = {
      input_tokens: j.usage.input_tokens,
      output_tokens: j.usage.output_tokens,
      cost: (j.usage.input_tokens * this.usdPerMtok) / 1e6,
    };
    return { answers: j.answers, usage };
  }

  /** ask() with a permanent cache keyed by hash(state + questions) and exponential-backoff retries. `refresh`
   *  skips the cached answer (the new one still replaces it). Backoff is 0.5s, 1s, 2s between attempts, never
   *  after the last one: the extension's service worker is killed after ~30s without activity. */
  async askCached<A>(
    state: unknown,
    questions: Record<string, unknown>,
    retries = 4,
    refresh = false,
  ): Promise<JevResponse<A>> {
    const key = `jev:${await sha256Hex(stableStringify(state) + stableStringify(questions))}`;
    this.ledger.calls++;
    const hit = refresh ? undefined : await this.cache.get<JevResponse<A>>(key, Number.POSITIVE_INFINITY);
    if (hit) {
      this.ledger.cached++;
      this.ledger.input_tokens += hit.usage.input_tokens;
      return { answers: hit.answers, usage: { ...hit.usage, cached: true, cost: 0 } };
    }
    let last: unknown;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const out = await this.ask<A>(state, questions);
        await this.cache.set(key, out);
        this.ledger.input_tokens += out.usage.input_tokens;
        this.ledger.cost += out.usage.cost;
        return out;
      } catch (e) {
        last = e;
        if (e instanceof JevError && e.status && e.status >= 400 && e.status < 500 && e.status !== 429)
          throw e;
        if (attempt < retries - 1) await this.sleep(500 * 2 ** attempt);
      }
    }
    throw new JevError(
      `Jev failed after ${retries} attempts: ${last instanceof Error ? last.message : String(last)}`,
    );
  }
}

/** Short per-call cost tag, e.g. '$0.00022 · 5,124 tok' (adds 'cached' when served from the cache). */
export function formatUsage(u: JevUsage): string {
  return `$${u.cost.toFixed(5)} · ${u.input_tokens.toLocaleString()} tok${u.cached ? " · cached" : ""}`;
}

/** JSON with object keys sorted at every level, so equal states hash equally regardless of construction order. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 24);
}
