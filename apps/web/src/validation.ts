/**
 * Client-side field validation shared by the Submit form, the schedule
 * create/edit forms and the policy editor.
 *
 * These rules mirror what the server already enforces so a bad value is
 * caught at the field before a request is sent. They are deliberately not
 * stricter than the server:
 *
 * - Stellar account: `G` prefix, 56 characters, base32 alphabet (A-Z, 2-7).
 *   The CRC16 checksum is verified server-side (#289), not here.
 * - Asset code: 1-12 characters, as checked by `parseIntent` in apps/api.
 * - Cron: 5 fields with the same per-field rules as
 *   `validateScheduleExpression` in packages/database/src/schedule-validation.ts.
 */

const STELLAR_ACCOUNT_RE = /^G[A-Z2-7]{55}$/;

/** True when `value` looks like a Stellar public account key (G..., 56 chars, base32). */
export function isValidStellarAddress(value: string): boolean {
  return STELLAR_ACCOUNT_RE.test(value);
}

/** Field-level message for an address input, or null when the value is valid. */
export function stellarAddressError(value: string, fieldLabel: string): string | null {
  if (isValidStellarAddress(value)) return null;
  return `${fieldLabel} must be a Stellar account: starts with G, 56 characters, letters A-Z and digits 2-7.`;
}

/** Field-level message for an asset code, or null when the value is valid (1-12 characters). */
export function assetCodeError(value: string, fieldLabel = 'Asset code'): string | null {
  if (value.length === 0) return `${fieldLabel} is required.`;
  if (value.length > 12) return `${fieldLabel} must be 1-12 characters.`;
  return null;
}

/**
 * Same per-field rule as `isValidCronField` in
 * packages/database/src/schedule-validation.ts, kept in sync so the client
 * accepts exactly what the server accepts.
 */
function isValidCronField(field: string, min: number, max: number): boolean {
  if (field === '*' || field === '') return field === '*';
  if (field.includes(',')) return field.split(',').every((f) => isValidCronField(f, min, max));
  if (field.includes('/')) {
    const parts = field.split('/');
    const base = parts[0] ?? '';
    const stepStr = parts[1] ?? '0';
    return isValidCronField(base, min, max) && parseInt(stepStr) > 0;
  }
  if (field.includes('-')) {
    const parts = field.split('-');
    const start = parseInt(parts[0] ?? '0');
    const end = parseInt(parts[1] ?? '0');
    return start >= min && end <= max && start <= end;
  }
  const num = parseInt(field);
  return num >= min && num <= max;
}

const CRON_FIELDS: { name: string; min: number; max: number }[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 6 },
];

/**
 * Field-level message for a 5-field cron expression, or null when the shape
 * is valid. Messages follow the server's wording ("invalid minute", ...).
 */
export function cronExpressionError(expression: string): string | null {
  const trimmed = expression.trim();
  if (trimmed.length === 0) return 'Schedule expression is required.';
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return 'Schedule expression must have 5 fields (minute hour day-of-month month day-of-week).';
  for (let i = 0; i < CRON_FIELDS.length; i++) {
    const { name, min, max } = CRON_FIELDS[i]!;
    if (!isValidCronField(parts[i] ?? '', min, max)) {
      return `Invalid ${name}: "${parts[i]}" (allowed ${min}-${max}).`;
    }
  }
  return null;
}
