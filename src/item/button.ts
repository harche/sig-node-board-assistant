/** The button that starts, and restarts, the PR and issue pages' checks. */
import { pageButton } from "../content/adapters";

export function runButton(label: string, title: string, onClick: () => void): HTMLElement {
  const b = pageButton(label);
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}
