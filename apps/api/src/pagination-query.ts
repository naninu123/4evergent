/**
 * Shared pagination query parser for consistent validation across all API list endpoints.
 *
 * Implements strict validation for `limit` and `offset` query parameters:
 * - Invalid syntax (non-numeric, fractional, empty) is rejected with HTTP 400
 * - Valid positive integers above the max are clamped (not rejected)
 * - Zero and negative limit values are rejected
 * - Negative offset values are rejected
 */

export interface PaginationParams {
  limit: number;
  offset: number;
}

export interface PaginationParseResult {
  success: true;
  params: PaginationParams;
}

export interface PaginationParseError {
  success: false;
  error: string;
}

export type PaginationResult = PaginationParseResult | PaginationParseError;

/**
 * Parse and validate pagination query parameters from URLSearchParams.
 *
 * @param searchParams - The URLSearchParams from the request URL
 * @param options.max - Maximum allowed limit for this endpoint (100 or 200)
 * @param options.defaultLimit - Default limit when not specified (default: 50)
 * @param options.defaultOffset - Default offset when not specified (default: 0)
 * @returns Success with validated params, or error with message
 */
export function parsePaginationQuery(
  searchParams: URLSearchParams,
  options: { max: number; defaultLimit?: number; defaultOffset?: number } = { max: 100 }
): PaginationResult {
  const defaultLimit = options.defaultLimit ?? 50;
  const defaultOffset = options.defaultOffset ?? 0;

  // Parse limit
  let limit = defaultLimit;
  if (searchParams.has("limit")) {
    const rawLimit = searchParams.get("limit");
    // Reject empty string
    if (rawLimit === null || rawLimit.trim() === "") {
      return {
        success: false,
        error: "limit must be a valid integer",
      };
    }

    const parsed = Number(rawLimit);
    // Reject non-numeric, fractional, NaN, Infinity
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      return {
        success: false,
        error: "limit must be a valid integer",
      };
    }

    // Reject zero and negative values
    if (parsed <= 0) {
      return {
        success: false,
        error: "limit must be a valid integer",
      };
    }

    // Clamp to max (don't reject)
    limit = Math.min(parsed, options.max);
  }

  // Parse offset
  let offset = defaultOffset;
  if (searchParams.has("offset")) {
    const rawOffset = searchParams.get("offset");
    // Reject empty string
    if (rawOffset === null || rawOffset.trim() === "") {
      return {
        success: false,
        error: "offset must be a valid integer",
      };
    }

    const parsed = Number(rawOffset);
    // Reject non-numeric, fractional, NaN, Infinity
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      return {
        success: false,
        error: "offset must be a valid integer",
      };
    }

    // Reject negative values
    if (parsed < 0) {
      return {
        success: false,
        error: "offset must be a valid integer",
      };
    }

    // Accept zero and positive integers (clamping happens at store level)
    offset = parsed;
  }

  return {
    success: true,
    params: { limit, offset },
  };
}
