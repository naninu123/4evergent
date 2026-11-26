/**
 * Integer-stroops conversion for Stellar amounts (issue #374).
 *
 * Stellar amounts have exactly 7 decimal places; the exact unit is the stroop
 * (1 XLM = 10^7 stroops). Binary floating point cannot represent most decimal
 * amounts exactly, so accumulating `total + amount` or subtracting
 * `limit - used` in IEEE-754 floats drifts the ledger and falsely denies
 * exact-limit intents (0.1 + 0.2 = 0.30000000000000004 > 0.3).
 *
 * The fix is one representation change: parse once to integer stroops, store
 * and compare integers, format back to a 7-decimal string for display. These
 * helpers are the boundary conversions; every daily-spending amount on the
 * enforcement path goes through them.
 *
 * `toStroops`/`fromStroops` are string-based, never `parseFloat`/multiply, so
 * the integer is exact (no float multiply of `amount * 1e7`, which itself can
 * round). The canonical form they accept is the same one the strict parser
 * (#264, packages/policy/src/amount.ts) enforces: `\d+(?:\.\d{1,7})?`.
 */

/** Canonical Stellar decimal form: digits, optional "." plus 1–7 fractional digits. */
const CANONICAL_AMOUNT_RE = /^\d+(?:\.\d{1,7})?$/;

/**
 * Parse a canonical Stellar amount to its integer stroops value.
 *
 * Accepts a `string` or `number` (a number is judged by its canonical string
 * form, so `1e-7` — exponent as a string — is rejected just like `"1e-7"`).
 * Returns the exact integer stroop count, or `null` when the value is not a
 * canonical Stellar decimal or exceeds the range exactly representable as a
 * JS number (`Number.MAX_SAFE_INTEGER`; ~900M XLM, far beyond any realistic
 * daily limit). Callers on the enforcement path treat `null` as an invalid
 * amount, exactly as the strict parser does.
 */
export function toStroops(value: unknown): number | null {
  let str: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    str = String(value);
  } else if (typeof value === "string") {
    str = value;
  } else {
    return null;
  }
  if (!CANONICAL_AMOUNT_RE.test(str)) return null;

  const dot = str.indexOf(".");
  const intPart = dot === -1 ? str : str.slice(0, dot);
  // Pad/truncate the fractional part to exactly 7 digits. The regex already
  // caps fractional digits at 7, so this is a pure zero-pad.
  const fracPart = dot === -1 ? "0000000" : (str.slice(dot + 1) + "0000000").slice(0, 7);

  const stroops = Number(intPart + fracPart);
  return Number.isSafeInteger(stroops) ? stroops : null;
}

/**
 * Format integer stroops as a canonical Stellar decimal string.
 *
 * Trailing fractional zeros are trimmed (3000000 -> "0.3", not "0.3000000"),
 * matching the natural form the dashboard displays; the integer part is always
 * present ("0" never ""). The result is always an exact decimal — never a
 * float like `0.19999999999999998` — because it is built from the integer
 * digits, not from float arithmetic.
 */
export function fromStroops(stroops: number): string {
  // The enforcement path only ever stores integer stroops; round defensively
  // so a stray non-integer (e.g. a test double) still formats cleanly instead
  // of dropping a sub-stroop fraction silently.
  const rounded = Number.isInteger(stroops) ? stroops : Math.round(stroops);
  const negative = rounded < 0;
  const digits = String(Math.abs(rounded)).padStart(8, "0");
  const intPart = digits.slice(0, -7) || "0";
  const fracPart = digits.slice(-7).replace(/0+$/, "");
  const body = fracPart ? `${intPart}.${fracPart}` : intPart;
  return negative ? `-${body}` : body;
}
