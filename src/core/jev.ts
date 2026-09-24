/** TypeSafe Jev client on the TypeSafe SDK. Jev answers calibrated yes/no (noul), multiple-choice and score
 *  questions about a JSON state; it never generates text and never acts. The SDK owns transport, timeouts and
 *  retries; this class adds the permanent answer cache (keyed by hash(state + questions)) and the cost ledger. */
import { APIError, TypeSafeClient, type Questions, type RetryPolicy } from "@typesafe-ai/sdk";
import type { Cache } from "./cache";
import type { JevUsage } from "./types";

export interface JevConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /** TypeSafe reports tokens, not dollars; list price of jev-latest input tokens keeps the ledger an estimate. */
  usdPerMtok?: number;
  /** SDK retry overrides (tests set backoffInitialMs to 0). */
  retry?: Partial<RetryPolicy>;
}

export interface JevResponse<A> {
  answers: A;
  usage: JevUsage;
}

export const JEV_DEFAULTS = { baseUrl: "https://api.typesafe.ai", model: "jev-latest", usdPerMtok: 0.042 };

/** Per attempt. The old hand-rolled client had none; kubelet-sized states take a few seconds. */
const TIMEOUT_MS = 20_000;

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
  private client: TypeSafeClient;
  private usdPerMtok: number;
  readonly ledger = { calls: 0, cached: 0, input_tokens: 0, cost: 0 };

  constructor(
    config: JevConfig,
    private cache: Cache,
    fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {
    if (!config.apiKey) throw new JevError("no TypeSafe key: set it in the extension options");
    this.usdPerMtok = config.usdPerMtok ?? JEV_DEFAULTS.usdPerMtok;
    this.client = new TypeSafeClient({
      apiKey: config.apiKey,
      baseURL: config.baseUrl || JEV_DEFAULTS.baseUrl,
      defaultModel: config.model || JEV_DEFAULTS.model,
      // The key is the user's own, kept in extension storage and used only from the service worker.
      dangerouslyAllowBrowser: true,
      timeout: TIMEOUT_MS,
      retry: { backoffInitialMs: 500, ...config.retry },
      logLevel: "off",
      // "/" is sent as the equivalent JSON escape "\/": Cloudflare in front of the API answers 403 to any body
      // containing a path like /etc/hosts, which kubelet issues quote all the time. The server decodes it back.
      fetch: (url, init) =>
        fetchFn(
          url,
          typeof init?.body === "string" ? { ...init, body: init.body.replace(/\//g, "\\/") } : init,
        ),
    });
  }

  /** One systemOne call. `retries` is the number of attempts; the default leaves retrying to askCached. */
  async ask<A>(state: unknown, questions: Record<string, unknown>, retries = 1): Promise<JevResponse<A>> {
    let j: { answers?: A; usage?: { input_tokens: number; output_tokens?: number } };
    try {
      j = (await this.client.systemOne(
        { state: state as never, questions: questions as Questions },
        { retry: { maxRetries: Math.max(0, retries - 1) } },
      )) as unknown as typeof j;
    } catch (e) {
      if (e instanceof APIError) {
        // e.g. a Cloudflare challenge page: keep the start of the body so the user can see what answered
        const body = typeof e.body === "string" ? e.body : JSON.stringify(e.body ?? "");
        throw new JevError(`TypeSafe HTTP ${e.status}: ${body.slice(0, 200)}`, e.status);
      }
      throw new JevError(`TypeSafe: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!j?.answers || !j.usage)
      throw new JevError(`TypeSafe: malformed response ${JSON.stringify(j).slice(0, 300)}`);
    const usage: JevUsage = {
      input_tokens: j.usage.input_tokens,
      output_tokens: j.usage.output_tokens,
      cost: (j.usage.input_tokens * this.usdPerMtok) / 1e6,
    };
    return { answers: j.answers, usage };
  }

  /** ask() with a permanent cache keyed by hash(state + questions); the SDK retries 408, 429, 5xx and connection
   *  errors with backoff from 0.5s (jittered, doubling, never after the last attempt). `refresh` skips the cached
   *  answer (the new one still replaces it). */
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
    let out: JevResponse<A>;
    try {
      out = await this.ask<A>(state, questions, retries);
    } catch (e) {
      if (
        e instanceof JevError &&
        e.status &&
        e.status >= 400 &&
        e.status < 500 &&
        e.status !== 429 &&
        e.status !== 408
      )
        throw e;
      throw new JevError(
        `Jev failed after ${retries} attempts: ${e instanceof Error ? e.message : String(e)}`,
        (e as JevError).status,
      );
    }
    await this.cache.set(key, out);
    this.ledger.input_tokens += out.usage.input_tokens;
    this.ledger.cost += out.usage.cost;
    return out;
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
