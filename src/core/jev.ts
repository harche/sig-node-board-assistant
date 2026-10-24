/** Jev client on the TypeSafe SDK, against TypeSafe's own API or OpenRouter's System One endpoint (the same model
 *  and request, billed to an OpenRouter key). Jev answers calibrated yes/no (noul), multiple-choice and score
 *  questions about a JSON state; it never generates text and never acts. The SDK owns transport and timeouts;
 *  this class owns retries (kept short for the service worker) and the cost ledger. Nothing is cached: every ask
 *  is answered fresh. */
import { APIConnectionError, APIError, TypeSafeClient, type Questions } from "@typesafe-ai/sdk";
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

/** One Jev call as made: what was sent and what came back. Kept for feedback (core/feedback.ts). */
export interface JevCall {
  state: unknown;
  questions: Record<string, unknown>;
  answers: unknown;
}

export const JEV_DEFAULTS = { baseUrl: "https://api.typesafe.ai", model: "jev-latest", usdPerMtok: 0.042 };

/** Per attempt. The old hand-rolled client had none; kubelet-sized states take a few seconds. */
const TIMEOUT_MS = 20_000;
/** Per long-context attempt: up to 262k tokens, which TypeSafe says answer slower. */
const LONG_CONTEXT_TIMEOUT_MS = 60_000;

export class JevError extends Error {
  constructor(
    message: string,
    public status?: number,
    /** Worth another attempt: 408, 429, 5xx, a connection failure or a malformed 200. */
    public retryable = false,
    /** For a 429: how long the server asked to wait (its Retry-After), when it said. */
    public retryAfterMs?: number,
    /** A 400 for a request longer than the model's context (`max_tokens_exceeded`). */
    public tooLong = false,
  ) {
    super(message);
    this.name = "JevError";
  }
}

export class JevClient {
  private client: TypeSafeClient;
  /** The provider's name, for errors. */
  private name: string;
  private provider: JevProvider;
  private usdPerMtok: number;
  private backoffMs: number;
  readonly ledger = { calls: 0, input_tokens: 0, cost: 0 };
  /** When set, every ask that answers is appended here. */
  trace?: JevCall[];

  constructor(config: JevConfig, fetchFn: typeof fetch = (...a) => fetch(...a)) {
    this.provider = config.provider ?? "typesafe";
    const provider = JEV_PROVIDERS[this.provider];
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
      // Retries live in ask: the SDK would honour Retry-After for up to 60s, and Chrome stops the service
      // worker after ~30s idle.
      retry: { maxRetries: 0 },
      logLevel: "off",
      // The SDK zstd-compresses bodies of 1 KiB or more where node:zlib exists (Node, so vitest; never Chrome).
      // Plain JSON everywhere keeps the "/" escape below working and tests seeing what the extension sends.
      compression: false,
      // "/" is sent as the equivalent JSON escape "\/": Cloudflare in front of TypeSafe's API answers 403 to any
      // body containing a path like /etc/hosts, which kubelet issues quote all the time. The server decodes it back.
      fetch:
        this.provider === "typesafe"
          ? (url, init) =>
              fetchFn(
                url,
                typeof init?.body === "string" ? { ...init, body: init.body.replace(/\//g, "\\/") } : init,
              )
          : fetchFn,
    });
  }

  /** One systemOne call, one HTTP attempt. `longContext` sends TypeSafe's opt-in header that raises both context
   *  limits (64k per request, 32k per question) to 262k tokens; TypeSafe calls such requests slower and less
   *  accurate, so ask sends it only after a request without it came back too long. */
  async attempt<A>(
    state: unknown,
    questions: Record<string, unknown>,
    longContext = false,
  ): Promise<JevResponse<A>> {
    let j: {
      answers?: A;
      usage?: { input_tokens: number | null; output_tokens?: number | null; cost?: number };
    };
    try {
      j = (await this.client.systemOne(
        { state: state as never, questions: questions as Questions },
        longContext
          ? { headers: { [LONG_CONTEXT_HEADER]: "true" }, timeout: LONG_CONTEXT_TIMEOUT_MS }
          : undefined,
      )) as unknown as typeof j;
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
          // the whole body, not the 200 characters kept for the message
          s === 400 && body.includes('"max_tokens_exceeded"'),
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
    // Since SDK 0.7 a count the API did not report is null: count it as 0 rather than poison the ledger with NaN
    const input_tokens = j.usage.input_tokens ?? 0;
    const usage: JevUsage = {
      input_tokens,
      output_tokens: j.usage.output_tokens ?? undefined,
      cost: typeof j.usage.cost === "number" ? j.usage.cost : (input_tokens * this.usdPerMtok) / 1e6,
    };
    return { answers: j.answers, usage };
  }

  /** attempt() with exponential-backoff retries on retryable failures. Backoff is 0.5s, 1s, 2s between attempts,
   *  never after the last one. A rate limit (429) is waited out longer: the server's Retry-After, else 2s, 4s … up to
   *  30s with jitter, for up to RATE_LIMIT_ATTEMPTS: callers fan out freely (a page asks tens of questions at once),
   *  and the service worker stays alive while a request is in flight (background keepalive). A request over
   *  TypeSafe's default context (64k per request, 32k per question) is sent again at once with long context on, and
   *  from then on gets LONG_CONTEXT_ATTEMPTS in all, 429s included: each one is a large, slow request. */
  async ask<A>(state: unknown, questions: Record<string, unknown>, retries = 4): Promise<JevResponse<A>> {
    this.ledger.calls++;
    let longContext = false;
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const out = await this.attempt<A>(state, questions, longContext);
        this.ledger.input_tokens += out.usage.input_tokens;
        this.ledger.cost += out.usage.cost;
        this.trace?.push({ state, questions, answers: out.answers });
        return out;
      } catch (e) {
        // Over TypeSafe's default context: send it again at once with long context on. OpenRouter needs no
        // header (it serves 262k as is), so there the same answer is final.
        if (e instanceof JevError && e.tooLong && this.provider === "typesafe" && !longContext) {
          longContext = true;
          attempt = 0; // the long-context request starts its own budget
          continue;
        }
        if (!(e instanceof JevError) || !e.retryable) throw e;
        const limited = e.status === 429;
        const budget = longContext
          ? LONG_CONTEXT_ATTEMPTS
          : limited
            ? Math.max(retries, RATE_LIMIT_ATTEMPTS)
            : retries;
        if (attempt >= budget)
          throw new JevError(
            `Jev failed after ${attempt} ${longContext ? "long-context " : ""}attempts: ${e.message}`,
            e.status,
          );
        const wait = limited
          ? (e.retryAfterMs ?? Math.min(30_000, this.backoffMs * 4 * 2 ** (attempt - 1))) +
            Math.random() * this.backoffMs
          : this.backoffMs * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
}

/** TypeSafe's opt-in for 262k-token context (docs.typesafe.ai/models#long-context), on Jev 1.13 and later. */
export const LONG_CONTEXT_HEADER = "TypeSafe-Danger-Zone-Long-Context";

/** Attempts for a rate-limited call. */
export const RATE_LIMIT_ATTEMPTS = 8;

/** Attempts for a long-context call, whatever the failure. */
export const LONG_CONTEXT_ATTEMPTS = 2;

/** A Retry-After header in ms (seconds, or an HTTP date), capped at a minute; undefined when absent or unreadable. */
export function retryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const secs = Number(h);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(h) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 60_000) : undefined;
}

/** Short per-call cost tag, e.g. '$0.00022 · 5,124 tok'. */
export function formatUsage(u: JevUsage): string {
  return `$${u.cost.toFixed(5)} · ${u.input_tokens.toLocaleString()} tok`;
}
