/** Jev client on the TypeSafe SDK, against TypeSafe's own API or OpenRouter's System One endpoint (the same model
 *  and request, billed to an OpenRouter key). Jev answers calibrated yes/no (noul), multiple-choice and score
 *  questions about a JSON state; it never generates text and never acts. The SDK owns transport and timeouts;
 *  this class owns retries (kept short for the service worker), the permanent answer cache (keyed by
 *  hash(state + questions)) and the cost ledger. */
import { APIConnectionError, APIError, TypeSafeClient, type Questions } from "@typesafe-ai/sdk";
import type { Cache } from "./cache";
import type { JevUsage } from "./types";

/** Where Jev is served: TypeSafe itself, or OpenRouter (`/api/v1/systemone`, same request and answers). */
export type JevProvider = "typesafe" | "openrouter";

export const JEV_PROVIDERS: Record<JevProvider, { name: string; baseUrl: string; model: string }> = {
  typesafe: { name: "TypeSafe", baseUrl: "https://api.typesafe.ai", model: "jev-latest" },
  openrouter: { name: "OpenRouter", baseUrl: "https://openrouter.ai/api", model: "~typesafe/jev-latest" },
};

export interface JevConfig {
  apiKey: string;
  /** Default typesafe. */
  provider?: JevProvider;
  baseUrl?: string;
  model?: string;
  /** TypeSafe reports tokens, not dollars: list price of jev-latest input tokens keeps the ledger an estimate.
   *  OpenRouter reports the cost itself, which is used instead. */
  usdPerMtok?: number;
  /** First backoff delay in ms, doubled per retry (default 500; tests set 0). */
  backoffMs?: number;
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
    /** Worth another attempt: 408, 429, 5xx, a connection failure or a malformed 200. */
    public retryable = false,
    /** For a 429: how long the server asked to wait (its Retry-After), when it said. */
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = "JevError";
  }
}

export class JevClient {
  private client: TypeSafeClient;
  /** The provider's name, for errors. */
  private name: string;
  private usdPerMtok: number;
  private backoffMs: number;
  readonly ledger = { calls: 0, cached: 0, input_tokens: 0, cost: 0 };

  constructor(
    config: JevConfig,
    private cache: Cache,
    fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {
    const provider = JEV_PROVIDERS[config.provider ?? "typesafe"];
    this.name = provider.name;
    if (!config.apiKey) throw new JevError(`no ${provider.name} key: set it in the extension options`);
    this.usdPerMtok = config.usdPerMtok ?? JEV_DEFAULTS.usdPerMtok;
    this.backoffMs = config.backoffMs ?? 500;
    this.client = new TypeSafeClient({
      apiKey: config.apiKey,
      baseURL: config.baseUrl || provider.baseUrl,
      defaultModel: config.model || provider.model,
      // The key is the user's own, kept in extension storage and used only from the service worker.
      dangerouslyAllowBrowser: true,
      timeout: TIMEOUT_MS,
      // Retries live in askCached: the SDK would honour Retry-After for up to 60s, and Chrome stops the service
      // worker after ~30s idle.
      retry: { maxRetries: 0 },
      logLevel: "off",
      // "/" is sent as the equivalent JSON escape "\/": Cloudflare in front of TypeSafe's API answers 403 to any
      // body containing a path like /etc/hosts, which kubelet issues quote all the time. The server decodes it back.
      fetch:
        (config.provider ?? "typesafe") === "typesafe"
          ? (url, init) =>
              fetchFn(
                url,
                typeof init?.body === "string" ? { ...init, body: init.body.replace(/\//g, "\\/") } : init,
              )
          : fetchFn,
    });
  }

  /** One systemOne call, one HTTP attempt. */
  async ask<A>(state: unknown, questions: Record<string, unknown>): Promise<JevResponse<A>> {
    let j: { answers?: A; usage?: { input_tokens: number; output_tokens?: number; cost?: number } };
    try {
      j = (await this.client.systemOne({
        state: state as never,
        questions: questions as Questions,
      })) as unknown as typeof j;
    } catch (e) {
      if (e instanceof APIError) {
        // e.g. a Cloudflare challenge page: keep the start of the body so the user can see what answered
        const body = typeof e.body === "string" ? e.body : JSON.stringify(e.body ?? "");
        const s = e.status;
        throw new JevError(
          `${this.name} HTTP ${s}: ${body.slice(0, 200)}`,
          s,
          s === 408 || s === 429 || s >= 500,
          retryAfter(e.headers?.get?.("retry-after") ?? null),
        );
      }
      // APIConnectionError covers timeouts too; anything else is the SDK rejecting the request before sending it
      throw new JevError(
        `${this.name}: ${e instanceof Error ? e.message : String(e)}`,
        undefined,
        e instanceof APIConnectionError,
      );
    }
    if (!j?.answers || !j.usage)
      throw new JevError(
        `${this.name}: malformed response ${JSON.stringify(j).slice(0, 300)}`,
        undefined,
        true,
      );
    const usage: JevUsage = {
      input_tokens: j.usage.input_tokens,
      output_tokens: j.usage.output_tokens,
      cost: typeof j.usage.cost === "number" ? j.usage.cost : (j.usage.input_tokens * this.usdPerMtok) / 1e6,
    };
    return { answers: j.answers, usage };
  }

  /** ask() with a permanent cache keyed by hash(state + questions) and exponential-backoff retries on retryable
   *  failures. `refresh` skips the cached answer (the new one still replaces it). Backoff is 0.5s, 1s, 2s between
   *  attempts, never after the last one. A rate limit (429) is waited out longer: the server's Retry-After, else 2s,
   *  4s … up to 30s with jitter, for up to RATE_LIMIT_ATTEMPTS: callers fan out freely (a page asks tens of
   *  questions at once), and the service worker stays alive while a request is in flight (background keepalive). */
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
    for (let attempt = 1; ; attempt++) {
      try {
        const out = await this.ask<A>(state, questions);
        await this.cache.set(key, out);
        this.ledger.input_tokens += out.usage.input_tokens;
        this.ledger.cost += out.usage.cost;
        return out;
      } catch (e) {
        if (!(e instanceof JevError) || !e.retryable) throw e;
        const limited = e.status === 429;
        if (attempt >= (limited ? Math.max(retries, RATE_LIMIT_ATTEMPTS) : retries))
          throw new JevError(`Jev failed after ${attempt} attempts: ${e.message}`, e.status);
        const wait = limited
          ? (e.retryAfterMs ?? Math.min(30_000, this.backoffMs * 4 * 2 ** (attempt - 1))) +
            Math.random() * this.backoffMs
          : this.backoffMs * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
}

/** Attempts for a rate-limited call. */
export const RATE_LIMIT_ATTEMPTS = 8;

/** A Retry-After header in ms (seconds, or an HTTP date), capped at a minute; undefined when absent or unreadable. */
export function retryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const secs = Number(h);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(h) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 60_000) : undefined;
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
