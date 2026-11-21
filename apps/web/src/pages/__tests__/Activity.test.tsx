import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import Activity from '../Activity';

const mockListActivity = vi.fn();
const mockListAllAgents = vi.fn();

vi.mock('../../api', () => ({
  api: {
    listActivity: (...args: any[]) => mockListActivity(...args),
    listAgents: vi.fn().mockResolvedValue({ agents: [] }),
    listAllAgents: (...args: any[]) => mockListAllAgents(...args),
    agentActivity: vi.fn().mockResolvedValue({ activity: [] }),
  },
}));

describe('Activity page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls listActivity on mount', async () => {
    mockListActivity.mockResolvedValue({ activity: [] });
    render(<MemoryRouter><Activity /></MemoryRouter>);
    await waitFor(() => {
      expect(mockListActivity).toHaveBeenCalled();
    });
  });

  it('renders empty state when no activity', async () => {
    mockListActivity.mockResolvedValue({ activity: [] });
    render(<MemoryRouter><Activity /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText('No activity')).toBeInTheDocument();
    });
  });

  it('renders error state', async () => {
    mockListActivity.mockRejectedValue(new Error('API error'));
    render(<MemoryRouter><Activity /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText('Failed to load activity')).toBeInTheDocument();
    });
  });

  it('retry button re-fetches and renders data after a transient failure', async () => {
    mockListActivity
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({
        activity: [
          {
            id: 'act-1',
            agentId: 'agent-a',
            ownerId: 'owner-a',
            intent: { type: 'payment', asset: 'XLM', amount: '10', destination: 'G...', reason: 'test' },
            policyDecision: { result: 'allow', reason: 'ok', rule: 'test', intent: {} as any },
            authorizationStatus: null,
            simulationResult: null,
            txHash: null,
            status: 'submitted',
            error: null,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      });

    render(<MemoryRouter><Activity /></MemoryRouter>);

    await waitFor(() => {
      expect(screen.getByText('Failed to load activity')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(mockListActivity).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByText('act-1'.slice(0, 8))).toBeInTheDocument();
    });
  });

  it('renders loading state', async () => {
    mockListActivity.mockReturnValue(new Promise(() => {}));
    render(<MemoryRouter><Activity /></MemoryRouter>);
    expect(screen.getByText('Loading activity...')).toBeInTheDocument();
  });

  it('renders activity table with correct data', async () => {
    mockListActivity.mockResolvedValue({
      activity: [
        {
          id: 'act-1',
          agentId: 'agent-a',
          ownerId: 'owner-a',
          intent: { type: 'payment', asset: 'XLM', amount: '10', destination: 'G...', reason: 'test' },
          policyDecision: { result: 'allow', reason: 'ok', rule: 'test', intent: {} as any },
          authorizationStatus: null,
          simulationResult: null,
          txHash: null,
          status: 'submitted',
          error: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    render(<MemoryRouter><Activity /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText('act-1'.slice(0, 8))).toBeInTheDocument();
    });
    expect(screen.getByText('submitted')).toBeInTheDocument();
    expect(screen.getByText('payment')).toBeInTheDocument();
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
    mockListActivity.mockResolvedValue({
      activity: [
        {
          id: 'act-1',
          agentId: 'agent-1',
          ownerId: 'owner-a',
          intent: { type: 'payment', asset: 'XLM', amount: '10', destination: 'G...', reason: 'test' },
          policyDecision: { result: 'allow', reason: 'ok', rule: 'test', intent: {} as any },
          authorizationStatus: null,
          simulationResult: null,
          txHash: null,
          status: 'submitted',
          error: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 'act-2',
          agentId: 'agent-2',
          ownerId: 'owner-a',
          intent: { type: 'payment', asset: 'XLM', amount: '20', destination: 'G...', reason: 'test' },
          policyDecision: { result: 'allow', reason: 'ok', rule: 'test', intent: {} as any },
          authorizationStatus: null,
          simulationResult: null,
          txHash: null,
          status: 'confirmed',
          error: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 'act-3',
          agentId: 'agent-deleted-9999',
          ownerId: 'owner-a',
          intent: { type: 'payment', asset: 'XLM', amount: '30', destination: 'G...', reason: 'test' },
          policyDecision: { result: 'allow', reason: 'ok', rule: 'test', intent: {} as any },
          authorizationStatus: null,
          simulationResult: null,
          txHash: null,
          status: 'failed',
          error: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      hasMore: false,
    });

    render(<MemoryRouter><Activity /></MemoryRouter>);

    expect(await screen.findByText('Treasury')).toBeInTheDocument();
    expect(screen.getByText('Payroll')).toBeInTheDocument();
    expect(screen.getByText('agent-deleted-9999')).toBeInTheDocument();
    expect(mockListAllAgents).toHaveBeenCalledTimes(1);
  });
});
