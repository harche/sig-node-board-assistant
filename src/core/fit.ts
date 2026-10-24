/** Keeping what Jev reads within its context. Jev is sent the whole evidence: every comment of a thread, every junit
 *  failure, every changed file judged. Only the count of comments or failures is unbounded (a GitHub body or comment
 *  is at most 65,536 characters), so a state is cut only when a list outgrows its room, and the cut says so. */

/** A state's size bound, in characters of JSON: about 125k tokens, well under the 262k-token context every Jev
 *  request has, with room for the question and the answer. */
export const MAX_STATE_CHARS = 500_000;

/** Characters `x` takes in a state: its JSON length. */
export const size = (x: unknown): number => JSON.stringify(x)?.length ?? 0;

/** A thread's comments, oldest first, cut from the middle until `measure(kept)` (the state's size with them) is at
 *  most `max`: the first comment and the newest stay, the oldest of the rest go first, and `marker(n)`, if given,
 *  stands where the `n` left out were. Unchanged when it fits; the first and the last are kept even when it never
 *  fits. The first is often the first reply to the report; the newest say where the issue is now. */
export function fitMiddle<T>(
  items: T[],
  measure: (kept: T[]) => number,
  max = MAX_STATE_CHARS,
  marker?: (dropped: number) => T,
): T[] {
  if (items.length <= 2 || measure(items) <= max) return items;
  const cut = (n: number) => [items[0]!, ...(marker ? [marker(n)] : []), ...items.slice(1 + n)];
  // The fewest dropped that fits: the size only shrinks as more are dropped, so a binary search finds it.
  let [lo, hi] = [1, items.length - 2];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (measure(cut(mid)) <= max) hi = mid;
    else lo = mid + 1;
  }
  return cut(lo);
}

/** The first items of a list (most telling first) while `measure(kept)` is at most `max`; `marker(n)` ends it when
 *  `n` are left out. Unchanged when it fits. */
export function fitHead<T>(
  items: T[],
  measure: (kept: T[]) => number,
  max: number,
  marker: (dropped: number) => T,
): T[] {
  if (!items.length || measure(items) <= max) return items;
  const cut = (k: number) => [...items.slice(0, k), marker(items.length - k)];
  let [lo, hi] = [0, items.length - 1];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(cut(mid)) <= max) lo = mid;
    else hi = mid - 1;
  }
  return cut(lo);
}

/** A text within `max` characters: its head and its tail, the middle replaced by a mark of how much was cut. */
export function fitText(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = Math.max(0, max - 40);
  const head = Math.ceil(keep / 3);
  return `${s.slice(0, head)}\n…[${s.length - keep} characters cut]…\n${s.slice(s.length - (keep - head))}`;
}

/** Characters of a whole request (state and questions) at most, the last guard before a call (JevClient.ask):
 *  about 150k tokens for English, still under 262k for dense text such as logs and ids (2.5 characters a token). */
export const MAX_REQUEST_CHARS = 600_000;

/** `x` (plain JSON) within `max` characters, whatever its shape: the last resort for what a state's builder did not
 *  fit, such as a busy linked PR's events, or questions taking room. While over, the biggest text or list in it gives
 *  way, at least an eighth at a time: a text keeps its start and end, a list its first and newest items with a line
 *  saying how many went. `x` itself when it fits. */
export function shrink<T>(x: T, max: number): T {
  if (size(x) <= max) return x;
  const out = JSON.parse(JSON.stringify(x)) as T;
  for (let round = 0; round < 1000 && size(out) > max; round++) {
    const big = biggest(out);
    if (!big) break;
    const { parent, key, value } = big;
    const cut = Math.max(size(out) - max + 64, Math.ceil(size(value) / 8));
    parent[key] =
      typeof value === "string"
        ? fitText(value, Math.max(0, value.length - cut))
        : fitMiddle(
            value,
            size,
            Math.max(0, size(value) - cut),
            (n) => `(${n} left out here: too long for Jev)`,
          );
  }
  return out;
}

type Slot = { parent: Record<string | number, unknown>; key: string | number; value: string | unknown[] };

/** The biggest text (over 400 characters) or list (over 3 items, so fitMiddle can still cut it) inside `x`. */
function biggest(x: unknown): Slot | null {
  let best: Slot | null = null;
  let most = 0;
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      const can = typeof v === "string" ? v.length > 400 : Array.isArray(v) && v.length > 3;
      if (can && size(v) > most) {
        most = size(v);
        best = { parent: node as Slot["parent"], key: Array.isArray(node) ? Number(k) : k, value: v };
      }
      walk(v);
    }
  };
  walk(x);
  return best;
}
