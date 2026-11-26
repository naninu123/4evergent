/**
 * Shared client-side validators matching the API server's format and shape rules (#338).
 *
 * - Stellar public key: 'G' prefix, 56 characters, RFC 4648 base32 alphabet (A-Z, 2-7).
 * - Asset code: non-empty, 1-12 characters.
 * - Cron expression: 5 space-separated fields matching the server's validateScheduleExpression bounds
 *   (minute 0-59, hour 0-23, day-of-month 1-31, month 1-12, day-of-week 0-6).
 */

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

export function isValidStellarAddress(value: string): boolean {
  if (typeof value !== 'string') return false;
  return STELLAR_ADDRESS_RE.test(value.trim());
}

export function validateStellarAddressField(value: string, fieldLabel = 'Address'): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) {
    return `${fieldLabel} is required (56-character Stellar G... address)`;
  }
  if (!isValidStellarAddress(trimmed)) {
    return `${fieldLabel} must be a 56-character Stellar G... public key (base32 A-Z, 2-7)`;
  }
  return null;
}

export function isValidAssetCode(value: string): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 12;
}

export function validateAssetCodeField(value: string, fieldLabel = 'Asset code'): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) {
    return `${fieldLabel} is required (1-12 characters)`;
  }
  if (trimmed.length > 12) {
    return `${fieldLabel} must be 1-12 characters`;
  }
  return null;
}

function isValidCronField(field: string, min: number, max: number): boolean {
  if (field === '*' || field === '') return field === '*';
  if (field.includes(',')) return field.split(',').every((f) => isValidCronField(f, min, max));
  if (field.includes('/')) {
    const parts = field.split('/');
    if (parts.length !== 2) return false;
    const base = parts[0] ?? '';
    const stepStr = parts[1] ?? '0';
    if (!/^\d+$/.test(stepStr)) return false;
    return isValidCronField(base, min, max) && parseInt(stepStr, 10) > 0;
  }
  if (field.includes('-')) {
    const parts = field.split('-');
    if (parts.length !== 2) return false;
    const startStr = parts[0] ?? '';
    const endStr = parts[1] ?? '';
    if (!/^\d+$/.test(startStr) || !/^\d+$/.test(endStr)) return false;
    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    return start >= min && end <= max && start <= end;
  }
  if (!/^\d+$/.test(field)) return false;
  const num = parseInt(field, 10);
  return num >= min && num <= max;
}

export function validateCronExpressionShape(expression: string): { valid: boolean; error?: string } {
  const trimmed = (expression ?? '').trim();
  if (!trimmed) {
    return { valid: false, error: 'Schedule expression is required.' };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    return { valid: false, error: 'Invalid schedule expression: must have 5 fields (minute hour day-of-month month day-of-week)' };
  }
  const [minute = '', hour = '', dom = '', month = '', dow = ''] = parts;
  if (!isValidCronField(minute, 0, 59)) return { valid: false, error: 'Invalid schedule expression: invalid minute (0-59)' };
  if (!isValidCronField(hour, 0, 23)) return { valid: false, error: 'Invalid schedule expression: invalid hour (0-23)' };
  if (!isValidCronField(dom, 1, 31)) return { valid: false, error: 'Invalid schedule expression: invalid day-of-month (1-31)' };
  if (!isValidCronField(month, 1, 12)) return { valid: false, error: 'Invalid schedule expression: invalid month (1-12)' };
  if (!isValidCronField(dow, 0, 6)) return { valid: false, error: 'Invalid schedule expression: invalid day-of-week (0-6)' };
  return { valid: true };
}
