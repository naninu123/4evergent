// Kept separate from api.ts and duck-typed on `code` so pages can use it
// without depending on the ApiError class (page tests mock '../api').
const CODE_MESSAGES: Record<string, string> = {
  AGENT_NOT_FOUND: 'This agent does not exist.',
  APPROVAL_NOT_FOUND: 'This approval does not exist.',
  EXECUTION_NOT_FOUND: 'This execution does not exist.',
  SCHEDULE_NOT_FOUND: 'This schedule does not exist.',
  ACTIVITY_NOT_FOUND: 'This activity record does not exist.',
  EXECUTION_QUEUE_DISABLED: 'The execution queue is not enabled on this server.',
  AGENT_NOT_ACTIVE: 'This agent is paused or disabled. Reactivate it before submitting new intents.',
  INVALID_EXECUTION_STATE: 'This execution can no longer be changed in its current state.',
  MAX_RETRIES_REACHED: 'This execution has used all of its retry attempts.',
  EXECUTION_CONFLICT: 'The execution changed while you were viewing it. It has been refreshed.',
};

const NETWORK_ERROR_MESSAGE =
  'Could not reach the API — check your connection and that the API is running.';

const NETWORK_ERROR_RE =
  /^(failed to fetch|networkerror\b.*|load failed|network request failed)$/i;

const BARE_API_STATUS_RE = /^API error (\d+)$/;

function isNetworkError(error: unknown, message?: string): boolean {
  if (error instanceof TypeError) return true;
  if ((error as { name?: string } | null)?.name === 'TypeError') return true;
  return Boolean(message && NETWORK_ERROR_RE.test(message));
}

function formatHttpStatusError(status: number): string {
  if (status >= 500) {
    return `The server encountered an error (HTTP ${status}). Please try again.`;
  }
  switch (status) {
    case 401:
      return 'Authentication is required (HTTP 401).';
    case 403:
      return 'You do not have permission to perform this action (HTTP 403).';
    case 404:
      return 'The requested resource was not found (HTTP 404).';
    case 429:
      return 'Too many requests (HTTP 429). Please wait a moment and try again.';
    default:
      return `The request failed (HTTP ${status}). Please try again.`;
  }
}

/** Context-appropriate message for an error, falling back to the server message. */
export function describeApiError(error: unknown, fallback: string): string {
  const e = error as { code?: string; message?: string; status?: number } | null;

  const mapped = e?.code ? CODE_MESSAGES[e.code] : undefined;
  if (mapped) {
    console.error('[api] Request failed:', error);
    return mapped;
  }

  const rawMessage = typeof e?.message === 'string' ? e.message.trim() : '';

  if (isNetworkError(error, rawMessage)) {
    console.error('[api] Network error:', error);
    return NETWORK_ERROR_MESSAGE;
  }

  const statusMatch = BARE_API_STATUS_RE.exec(rawMessage);
  if (statusMatch) {
    console.error('[api] HTTP error:', error);
    return formatHttpStatusError(Number(statusMatch[1]));
  }

  if (rawMessage) {
    return rawMessage;
  }

  if (error != null) {
    console.error('[api] Request failed:', error);
  }
  return fallback;
}
