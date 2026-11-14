const STRICT_DECIMAL_AMOUNT_RE = /^(?:0|[1-9]\d*)(?:\.\d{1,7})?$/;
const NEGATIVE_STRICT_DECIMAL_RE = /^-(?:0|[1-9]\d*)(?:\.\d{1,7})?$/;
const STROOPS_PER_UNIT = 10_000_000n;

/** Parse a strict unsigned decimal amount string (at most 7 fractional digits) into stroops. */
export function parseDecimalStroops(value: string): bigint | null {
  if (!STRICT_DECIMAL_AMOUNT_RE.test(value)) {
    return null;
  }
  const [whole = "0", frac = ""] = value.split(".");
  return BigInt(whole) * STROOPS_PER_UNIT + BigInt(frac.padEnd(7, "0"));
}

/** Parse a strict non-negative decimal policy amount (string or finite non-negative number). */
export function parseStrictPolicyAmount(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || Object.is(value, -0)) {
      return null;
    }
    return STRICT_DECIMAL_AMOUNT_RE.test(String(value)) ? value : null;
  }
  if (typeof value !== "string" || !STRICT_DECIMAL_AMOUNT_RE.test(value)) {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/** True when value is a syntactically valid negative or zero decimal string. */
export function isNonPositiveDecimalString(value: string): boolean {
  if (NEGATIVE_STRICT_DECIMAL_RE.test(value)) {
    return true;
  }
  const stroops = parseDecimalStroops(value);
  return stroops !== null && stroops === 0n;
}

/** Compare two strict decimal amount strings via stroops (-1, 0, or 1). */
export function compareStrictAmounts(a: string, b: string): number {
  const sa = parseDecimalStroops(a);
  const sb = parseDecimalStroops(b);
  if (sa === null || sb === null) return 0;
  return sa > sb ? 1 : sa < sb ? -1 : 0;
}
