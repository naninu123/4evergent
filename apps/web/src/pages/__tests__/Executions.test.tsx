import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import Executions from '../Executions';

// Mock API — hoisted so vi.fn references are available in the mock factory
const { mockListAllExecutions, mockGetQueueStatus, mockGetOverviewAttention, mockGetAgent, mockListAgentExecutions, mockListActivity, mockListAgents, mockListAllAgents } = vi.hoisted(() => ({
  mockListAllExecutions: vi.fn(),
  mockGetQueueStatus: vi.fn(),
  // #383: Executions page now fetches overview/attention for the server-side
  // retrying count; every test must resolve it.
  mockGetOverviewAttention: vi.fn(),
  mockGetAgent: vi.fn(),
  mockListAgentExecutions: vi.fn(),
  mockListActivity: vi.fn(),
  mockListAgents: vi.fn(),
  mockListAllAgents: vi.fn(),
}));

const DEFAULT_ATTENTION = {
  pendingApprovals: 0,
  failedExecutions: 0,
  deadLetterExecutions: 0,
  retryingExecutions: 0,
  stuckExecutions: 0,
};

vi.mock('../../api', () => ({
  api: {
    listAllExecutions: mockListAllExecutions,
    getQueueStatus: mockGetQueueStatus,
    getOverviewAttention: mockGetOverviewAttention,
    getAgent: mockGetAgent,
    listAgentExecutions: mockListAgentExecutions,
    listActivity: mockListActivity,
    listAgents: mockListAgents,
    listAllAgents: mockListAllAgents,
  },
}));

describe('Executions page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: resolve with zero counts so tests that don't care about the
    // retrying count don't need to set it up explicitly (#383).
    mockGetOverviewAttention.mockResolvedValue(DEFAULT_ATTENTION);
  });

  it('renders loading state', () => {
    mockListAllExecutions.mockReturnValue(new Promise(() => {}));
    mockGetQueueStatus.mockReturnValue(new Promise(() => {}));
    mockGetOverviewAttention.mockReturnValue(new Promise(() => {}));
    render(<MemoryRouter><Executions /></MemoryRouter>);
    expect(screen.getByText('Loading executions...')).toBeInTheDocument();
  });

  it('renders empty state when no executions', async () => {
    mockListAllExecutions.mockResolvedValue({ executions: [] });
    mockGetQueueStatus.mockResolvedValue({ running: false, byStatus: {} });
    render(<MemoryRouter><Executions /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText('No executions found')).toBeInTheDocument();
    });
  });

  it('renders error state', async () => {
    mockListAllExecutions.mockRejectedValue(new Error('API error'));
    mockGetQueueStatus.mockResolvedValue({ running: false, byStatus: {} });
    render(<MemoryRouter><Executions /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText('API error')).toBeInTheDocument();
    });
  });

  it('renders execution list with correct data', async () => {
    mockListAllExecutions.mockResolvedValue({
      executions: [
        {
          id: 'exec-1',
          ownerId: 'owner-a',
          agentId: 'agent-a',
          approvalId: null,
          activityId: null,
          intent: { type: 'payment', asset: 'XLM', amount: '10', destination: 'G...', reason: 'test' },
          status: 'submitted',
          policyDecision: null,
          simulationResult: null,
          txHash: 'tx-hash-1',
          error: null,
          attempt: 1,
          nextRetryAt: null,
          startedAt: null,
          completedAt: null,
          errorClass: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    mockGetQueueStatus.mockResolvedValue({ running: true, byStatus: { submitted: 1 } });
    render(<MemoryRouter><Executions /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText('exec-1'.slice(0, 8))).toBeInTheDocument();
    });
  });

  it('renders a View execution link per row with correct href', async () => {
    mockListAllExecutions.mockResolvedValue({
      executions: [
        {
          id: 'exec-1',
          ownerId: 'owner-a',
          agentId: 'agent-a',
          approvalId: null,
          activityId: null,
          intent: { type: 'payment', asset: 'XLM', amount: '10', destination: 'G...', reason: 'test' },
          status: 'submitted',
          policyDecision: null,
          simulationResult: null,
          txHash: 'tx-hash-1',
          error: null,
          attempt: 1,
          nextRetryAt: null,
          startedAt: null,
          completedAt: null,
          errorClass: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    mockGetQueueStatus.mockResolvedValue({ running: true, byStatus: { submitted: 1 } });
    render(<MemoryRouter><Executions /></MemoryRouter>);
    await waitFor(() => {
      const link = screen.getByRole('link', { name: /exec-1/ });
      expect(link).toHaveAttribute('href', '/executions/exec-1');
    });
  });

  it('does not render a link when execution id is missing', async () => {
    mockListAllExecutions.mockResolvedValue({
      executions: [
        {
          id: '',
          ownerId: 'owner-a',
          agentId: 'agent-a',
          approvalId: null,
          activityId: null,
          intent: { type: 'payment', asset: 'XLM', amount: '10', destination: 'G...', reason: 'test' },
          status: 'queued',
          policyDecision: null,
          simulationResult: null,
          txHash: null,
          error: null,
          attempt: 0,
          nextRetryAt: null,
          startedAt: null,
          completedAt: null,
          errorClass: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    mockGetQueueStatus.mockResolvedValue({ running: false, byStatus: {} });
    render(<MemoryRouter><Executions /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
    });
  });

  it('renders dead-letter status correctly', async () => {
    mockListAllExecutions.mockResolvedValue({
      executions: [
        {
          id: 'exec-dl',
          ownerId: 'owner-a',
          agentId: 'agent-a',
          approvalId: null,
          activityId: null,
          intent: { type: 'payment', asset: 'XLM', amount: '10', destination: 'G...', reason: 'test' },
          status: 'dead_letter',
          policyDecision: null,
          simulationResult: null,
          txHash: null,
          error: 'Max retries exceeded',
          attempt: 3,
          nextRetryAt: null,
          startedAt: null,
          completedAt: '2026-01-01T00:00:00Z',
          errorClass: 'permanent',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    mockGetQueueStatus.mockResolvedValue({ running: true, byStatus: { dead_letter: 1 } });
    render(<MemoryRouter><Executions /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getAllByText(/Dead Letter/).length).toBeGreaterThan(0);
    });
  });

  it('renders cancelled status correctly and includes Cancelled in filter options', async () => {
    mockListAllExecutions.mockResolvedValue({
      executions: [
        {
          id: 'exec-cancelled',
          ownerId: 'owner-a',
          agentId: 'agent-a',
          approvalId: null,
          activityId: null,
          intent: { type: 'payment', asset: 'XLM', amount: '10', destination: 'G...', reason: 'test' },
          status: 'cancelled',
          policyDecision: null,
          simulationResult: null,
          txHash: null,
          error: 'cancelled by user',
          attempt: 0,
          nextRetryAt: null,
          startedAt: null,
          completedAt: '2026-01-01T00:00:00Z',
          errorClass: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    mockGetQueueStatus.mockResolvedValue({ running: true, byStatus: { cancelled: 1 } });
    render(<MemoryRouter><Executions /></MemoryRouter>);
    await waitFor(() => {
      const badge = screen.getByText('Cancelled', { selector: '.badge' });
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveClass('badge-neutral');
    });
    expect(screen.getByRole('option', { name: 'Cancelled' })).toBeInTheDocument();
  });

  it('calls listAllExecutions and never listAgents (N+1 removed)', async () => {
    mockListAllExecutions.mockResolvedValue({ executions: [] });
    mockGetQueueStatus.mockResolvedValue({ running: false, byStatus: {} });
    render(<MemoryRouter><Executions /></MemoryRouter>);
    await waitFor(() => {
      expect(mockListAllExecutions).toHaveBeenCalledTimes(1);
    });
    expect(mockListAgents).not.toHaveBeenCalled();
    expect(mockListAgentExecutions).not.toHaveBeenCalled();
  });

  it('renders agent display names for known agents and falls back to raw ID for unknown agents', async () => {
    mockListAllAgents.mockResolvedValue({
      agents: [
        { id: 'agent-1', displayName: 'Treasury' },
        { id: 'agent-2', displayName: 'Payroll' },
      ],
      total: 2,
      truncated: false,
    });
    mockListAllExecutions.mockResolvedValue({
      executions: [
        {
          id: 'exec-1',
          ownerId: 'owner-a',
          agentId: 'agent-1',
          approvalId: null,
          activityId: null,
          intent: { type: 'payment', asset: 'XLM', amount: '10', destination: 'G...', reason: 'test' },
          status: 'confirmed',
          policyDecision: null,
          simulationResult: null,
          txHash: null,
          error: null,
          attempt: 1,
          nextRetryAt: null,
          startedAt: null,
          completedAt: null,
          errorClass: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 'exec-2',
          ownerId: 'owner-a',
          agentId: 'agent-2',
          approvalId: null,
          activityId: null,
          intent: { type: 'payment', asset: 'XLM', amount: '20', destination: 'G...', reason: 'test' },
          status: 'confirmed',
          policyDecision: null,
          simulationResult: null,
          txHash: null,
          error: null,
          attempt: 1,
          nextRetryAt: null,
          startedAt: null,
          completedAt: null,
          errorClass: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 'exec-3',
          ownerId: 'owner-a',
          agentId: 'agent-unknown-9999',
          approvalId: null,
          activityId: null,
          intent: { type: 'payment', asset: 'XLM', amount: '30', destination: 'G...', reason: 'test' },
          status: 'failed',
          policyDecision: null,
          simulationResult: null,
          txHash: null,
          error: null,
          attempt: 1,
          nextRetryAt: null,
          startedAt: null,
          completedAt: null,
          errorClass: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      hasMore: false,
    });
    mockGetQueueStatus.mockResolvedValue({ running: true, byStatus: {} });

    render(<MemoryRouter><Executions /></MemoryRouter>);

    expect(await screen.findByText('Treasury')).toBeInTheDocument();
    expect(screen.getByText('Payroll')).toBeInTheDocument();
    expect(screen.getByText('agent-unknown-9999')).toBeInTheDocument();
    expect(mockListAllAgents).toHaveBeenCalledTimes(1);
  });
});
