import { describe, expect, test } from 'vitest';
import { assetCodeError, cronExpressionError, isValidStellarAddress, stellarAddressError } from '../validation';

const VALID = 'GB3KJPLFUYN5VL6R3GU3EGCGVCKFDSD7BEDX42HWG5BWFKB3KQGJJRMA';

describe('isValidStellarAddress', () => {
  test('accepts a 56-char base32 G-address', () => {
    expect(isValidStellarAddress(VALID)).toBe(true);
  });

  test.each([
    ['empty', ''],
    ['bare G', 'G'],
    ['too short', 'GABC'],
    ['too long', VALID + 'A'],
    ['wrong prefix (secret key)', 'S' + VALID.slice(1)],
    ['lowercase', VALID.toLowerCase()],
    ['non-base32 digit 1', 'G1' + VALID.slice(2)],
    ['non-base32 digit 8', 'G8' + VALID.slice(2)],
    ['surrounding whitespace', ` ${VALID}`],
  ])('rejects %s', (_label, value) => {
    expect(isValidStellarAddress(value)).toBe(false);
  });

  test('stellarAddressError names the field and the rule', () => {
    expect(stellarAddressError(VALID, 'Destination')).toBeNull();
    expect(stellarAddressError('Gxxx', 'Destination')).toMatch(/^Destination must be a Stellar account: starts with G, 56 characters/);
  });
});

describe('assetCodeError', () => {
  test('accepts 1-12 characters', () => {
    expect(assetCodeError('A')).toBeNull();
    expect(assetCodeError('USDC')).toBeNull();
    expect(assetCodeError('ABCDEFGHIJKL')).toBeNull();
  });

  test('rejects empty and longer than 12', () => {
    expect(assetCodeError('')).toBe('Asset code is required.');
    expect(assetCodeError('ABCDEFGHIJKLM')).toBe('Asset code must be 1-12 characters.');
  });
});

describe('cronExpressionError', () => {
  test.each(['0 * * * *', '0 */6 * * *', '0 0 * * 1', '*/15 9-17 1,15 * 1-5', '  0 0 1 * *  '])('accepts %s', (expr) => {
    expect(cronExpressionError(expr)).toBeNull();
  });

  test('rejects empty', () => {
    expect(cronExpressionError('   ')).toBe('Schedule expression is required.');
  });

  test('rejects wrong field count', () => {
    expect(cronExpressionError('invalid')).toMatch(/must have 5 fields/);
    expect(cronExpressionError('0 0 * * * *')).toMatch(/must have 5 fields/);
  });

  test.each([
    ['60 * * * *', /Invalid minute/],
    ['0 24 * * *', /Invalid hour/],
    ['0 0 0 * *', /Invalid day-of-month/],
    ['0 0 * 13 *', /Invalid month/],
    ['0 0 * * 7', /Invalid day-of-week/],
    ['abc * * * *', /Invalid minute/],
    ['*/0 * * * *', /Invalid minute/],
    ['0 5-2 * * *', /Invalid hour/],
  ])('rejects %s', (expr, msg) => {
    expect(cronExpressionError(expr)).toMatch(msg);
  });
});
