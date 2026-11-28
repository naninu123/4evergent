/**
 * Executions page — Retrying card count (#383)
 *
 * Verifies that the "Retrying" stat card shows the server-provided count from
 * GET /overview/attention (retryingExecutions) rather than counting loaded
 * rows.  This ensures the card matches Overview's count regardless of how
 * many executions are currently loaded on the page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Hoist mock factories so vi.mock() closures can reference them.
// ---------------------------------------------------------------------------
const {
  mockListAllExecutions,
  mockGetQueueStatus,
  mockGetOverviewAttention,
} = vi.hoisted(() => ({
  mockListAllExecutions: vi.fn(),
  mockGetQueueStatus: vi.fn(),
  mockGetOverviewAttention: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listAllExecutions: mockListAllExecutions,
      getQueueStatus: mockGetQueueStatus,
      getOverviewAttention: mockGetOverviewAttention,
    },
  };
});

// agentNames hook — not relevant to this test; return empty map.
vi.mock('../agentNames', () => ({
  useAgentNames: () => new Map(),
}));

import Executions from '../pages/Executions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExecution(overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    ownerId: 'owner-1',
    agentId: 'agent-1',
    approvalId: null,
    activityId: null,
    intent: { type: 'payment', asset: 'XLM', amount: '1', destination: 'G...' },
    status: 'confirmed',
    policyDecision: null,
    simulationResult: null,
    txHash: null,
    error: null,
    attempt: 0,
    nextRetryAt: null,
    startedAt: null,
    completedAt: null,
    errorClass: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <Executions />
    </MemoryRouter>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Executions page — Retrying card (#383)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the Retrying card value from getOverviewAttention, not from loaded rows', async () => {
    // The loaded page contains ONE failed+retrying row, but the server reports
    // 7 retrying executions total (more than the 50-row page would show).
    mockListAllExecutions.mockResolvedValue({
      executions: [
        makeExecution({ status: 'failed', nextRetryAt: new Date().toISOString(), errorClass: 'transient' }),
      ],
      hasMore: true,
    });
    mockGetQueueStatus.mockResolvedValue({
      running: true,
      byStatus: { queued: 2, executing: 1, failed: 7, dead_letter: 0 },
    });
    mockGetOverviewAttention.mockResolvedValue({
      pendingApprovals: 0,
      failedExecutions: 7,
      deadLetterExecutions: 0,
      retryingExecutions: 7,
      stuckExecutions: 0,
    });

    renderPage();

    // Wait for the page to finish loading.
    await waitFor(() => {
      expect(screen.queryByText('Loading executions...')).not.toBeInTheDocument();
    });

    // The "Retrying" card must show the server-provided count (7), NOT the
    // count of loaded rows that match inferRetrying (which would be 1).
    const cards = screen.getAllByText('Retrying');
    // The card title element
    const retryingCard = cards.find((el) => el.classList.contains('card-title'));
    expect(retryingCard).toBeTruthy();
    // Its sibling value element
    const cardEl = retryingCard!.closest('.card');
    expect(cardEl).toBeTruthy();
    const valueEl = cardEl!.querySelector('.card-value');
    expect(valueEl).toHaveTextContent('7');
  });

  it('calls getOverviewAttention on load', async () => {
    mockListAllExecutions.mockResolvedValue({ executions: [], hasMore: false });
    mockGetQueueStatus.mockResolvedValue({ running: false, byStatus: {} });
    mockGetOverviewAttention.mockResolvedValue({
      pendingApprovals: 0,
      failedExecutions: 0,
      deadLetterExecutions: 0,
      retryingExecutions: 0,
      stuckExecutions: 0,
    });

    renderPage();

    await waitFor(() => {
      expect(mockGetOverviewAttention).toHaveBeenCalledTimes(1);
    });
  });

  it('shows server retrying count of 0 when there are no retrying executions', async () => {
    mockListAllExecutions.mockResolvedValue({ executions: [], hasMore: false });
    mockGetQueueStatus.mockResolvedValue({ running: true, byStatus: { queued: 3 } });
    mockGetOverviewAttention.mockResolvedValue({
      pendingApprovals: 1,
      failedExecutions: 0,
      deadLetterExecutions: 0,
      retryingExecutions: 0,
      stuckExecutions: 0,
    });

    renderPage();

    await waitFor(() => {
      expect(screen.queryByText('Loading executions...')).not.toBeInTheDocument();
    });

    const cards = screen.getAllByText('Retrying');
    const retryingCard = cards.find((el) => el.classList.contains('card-title'));
    expect(retryingCard).toBeTruthy();
    const cardEl = retryingCard!.closest('.card');
    const valueEl = cardEl!.querySelector('.card-value');
    expect(valueEl).toHaveTextContent('0');
  });

  it('per-row Retrying badge is still rendered for failed+transient rows (unchanged)', async () => {
    const retryingExec = makeExecution({
      status: 'failed',
      nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
      errorClass: 'transient',
    });

    mockListAllExecutions.mockResolvedValue({
      executions: [retryingExec],
      hasMore: false,
    });
    mockGetQueueStatus.mockResolvedValue({ running: true, byStatus: { failed: 1 } });
    mockGetOverviewAttention.mockResolvedValue({
      pendingApprovals: 0,
      failedExecutions: 1,
      deadLetterExecutions: 0,
      retryingExecutions: 1,
      stuckExecutions: 0,
    });

    renderPage();

    await waitFor(() => {
      expect(screen.queryByText('Loading executions...')).not.toBeInTheDocument();
    });

    // The table row badge should still read "Retrying" for a transient failed row.
    const retryingBadges = screen
      .getAllByText('Retrying')
      .filter((el) => el.classList.contains('badge'));
    expect(retryingBadges.length).toBeGreaterThan(0);
  });
});
