/** Every answer Jev gave for a card, labelled for people: the hover card and the pane show them all as bars. A noul
 *  is one probability; a choice or a score is a probability per option. Built by each column's judge, which knows
 *  what each question id means (`engaged_2` is "alice is reviewing"). */
import type { JevChoice, JevNoul, JevScore } from "./types";

export type Reading =
  { label: string; p: number; warn?: boolean } | { label: string; probabilities: Record<string, number> };

export function noulReading(label: string, a: JevNoul | undefined | null, warn = false): Reading[] {
  return a && typeof a.noul === "number" ? [{ label, p: a.noul, ...(warn ? { warn } : {}) }] : [];
}

/** A choice, or a score whose levels (`"0"`, `"1"`, …) are named by `levels` in order. */
export function choiceReading(
  label: string,
  a: JevChoice | JevScore | undefined | null,
  levels?: readonly string[],
): Reading[] {
  if (!a?.probabilities) return [];
  const probabilities = levels
    ? Object.fromEntries(levels.map((name, i) => [name, a.probabilities[String(i)] ?? 0]))
    : a.probabilities;
  return [{ label, probabilities }];
}
