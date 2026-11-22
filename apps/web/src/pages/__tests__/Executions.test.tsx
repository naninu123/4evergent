import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import Executions from '../Executions';

// Mock API — hoisted so vi.fn references are available in the mock factory
const { mockListAllExecutions, mockGetQueueStatus, mockGetAgent, mockListAgentExecutions, mockListActivity, mockListAgents, mockListAllAgents } = vi.hoisted(() => ({
  mockListAllExecutions: vi.fn(),
  mockGetQueueStatus: vi.fn(),
  mockGetAgent: vi.fn(),
  mockListAgentExecutions: vi.fn(),
  mockListActivity: vi.fn(),
  mockListAgents: vi.fn(),
  mockListAllAgents: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: {
    listAllExecutions: mockListAllExecutions,
    getQueueStatus: mockGetQueueStatus,
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
  });

  it('renders loading state', () => {
    mockListAllExecutions.mockReturnValue(new Promise(() => {}));
    mockGetQueueStatus.mockReturnValue(new Promise(() => {}));
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

  it('filters failed executions server-side across >50 total rows, resets pagination on filter change, and counts filtered items', async () => {
    const makeExecution = (id: string, status: 'confirmed' | 'failed') => ({
      id,
      ownerId: 'owner-a',
      agentId: 'agent-a',
      approvalId: null,
      activityId: null,
      intent: { type: 'payment', asset: 'XLM', amount: '10', destination: 'G...', reason: 'test' },
      status,
      policyDecision: null,
      simulationResult: null,
      txHash: null,
      error: status === 'failed' ? 'boom' : null,
      attempt: 1,
      nextRetryAt: null,
      startedAt: null,
      completedAt: null,
      errorClass: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    // Simulate >50 total executions: 60 confirmed + 55 failed (115 total)
    const allPage1 = Array.from({ length: 50 }, (_, i) => makeExecution(`conf-${String(i).padStart(3, '0')}`, 'confirmed'));
    const failedPage1 = Array.from({ length: 50 }, (_, i) => makeExecution(`fail-${String(i).padStart(3, '0')}`, 'failed'));
    const failedPage2 = Array.from({ length: 5 }, (_, i) => makeExecution(`fail-${String(50 + i).padStart(3, '0')}`, 'failed'));

    mockListAllExecutions.mockImplementation(async (_limit: number, offset: number, status?: string) => {
      if (status === 'failed') {
        if (offset === 0) return { executions: failedPage1, hasMore: true };
        if (offset === 50) return { executions: failedPage2, hasMore: false };
      }
      if (!status && offset === 0) {
        return { executions: allPage1, hasMore: true };
      }
      return { executions: [], hasMore: false };
    });
    mockGetQueueStatus.mockResolvedValue({ running: true, byStatus: { confirmed: 60, failed: 55 } });

    render(<MemoryRouter><Executions /></MemoryRouter>);

    // Initial unfiltered load
    await waitFor(() => {
      expect(mockListAllExecutions).toHaveBeenCalledWith(50, 0, undefined);
      expect(screen.getByText('conf-000')).toBeInTheDocument();
    });

    // Switch filter to "failed" -> resets pagination to offset 0 with server-side status='failed'
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'failed' } });

    await waitFor(() => {
      expect(mockListAllExecutions).toHaveBeenCalledWith(50, 0, 'failed');
      expect(screen.getByText('fail-000')).toBeInTheDocument();
    });
    expect(screen.queryByText('conf-000')).not.toBeInTheDocument();
    expect(screen.getByText('50 shown')).toBeInTheDocument();

    // Load more -> pages only through failed rows at offset 50
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() => {
      expect(mockListAllExecutions).toHaveBeenCalledWith(50, 50, 'failed');
      expect(screen.getByText('fail-054')).toBeInTheDocument();
    });
    expect(screen.getAllByRole('row')).toHaveLength(56); // 1 header + 55 failed rows
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();

    // Switching back to "all" resets pagination to offset 0 with status=undefined
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'all' } });

    await waitFor(() => {
      expect(mockListAllExecutions).toHaveBeenLastCalledWith(50, 0, undefined);
      expect(screen.getByText('conf-000')).toBeInTheDocument();
    });
  });
});
