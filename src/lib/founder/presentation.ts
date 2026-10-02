/**
 * How a Founder BARRY reply's supporting items are shown (pure). The answer is primary:
 *   open    — the items ARE the point (a proposal prepared, a handled / left-for-you list)
 *   details — the answer already tells it; the records / links stay one tap away
 *   hidden  — a confirmation turn: the Confirm button is the one thing to act on
 */
export type ItemsMode = "open" | "details" | "hidden";

export function itemsMode(status: string, count: number): ItemsMode {
  if (count === 0 || status === "needs_confirmation") return "hidden";
  if (status === "proposed" || status === "handled") return "open";
  return "details";
}
