import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import Activity from '../Activity';
import * as api from '../../api';

const mockListActivity = vi.fn();
const mockListAgents = vi.fn();
const mockAgentActivity = vi.fn();

vi.mock('../../api', () => ({
  api: {
    listActivity: (...args: any[]) => mockListActivity(...args),
    listAgents: (...args: any[]) => mockListAgents(...args),
    agentActivity: (...args: any[]) => mockAgentActivity(...args),
  },
}));

describe('Activity page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls listActivity on mount', async () => {
    mockListActivity.mockResolvedValue({ activity: [] });
    render(<Activity />);
    await waitFor(() => {
      expect(mockListActivity).toHaveBeenCalled();
    });
  });

  it('does NOT call listAgents (N+1 removed)', async () => {
    mockListActivity.mockResolvedValue({ activity: [] });
    render(<Activity />);
    await waitFor(() => {
      expect(mockListActivity).toHaveBeenCalled();
    });
    expect(mockListAgents).not.toHaveBeenCalled();
    expect(mockAgentActivity).not.toHaveBeenCalled();
  });

  it('renders empty state when no activity', async () => {
    mockListActivity.mockResolvedValue({ activity: [] });
    render(<Activity />);
    await waitFor(() => {
      expect(screen.getByText('No activity')).toBeInTheDocument();
    });
  });

  it('renders error state', async () => {
    mockListActivity.mockRejectedValue(new Error('API error'));
    render(<Activity />);
    await waitFor(() => {
      expect(screen.getByText('Failed to load activity')).toBeInTheDocument();
    });
  });

  it('renders loading state', async () => {
    mockListActivity.mockReturnValue(new Promise(() => {}));
    render(<Activity />);
    expect(screen.getByText('Loading activity...')).toBeInTheDocument();
  });

  it('clicking a row invokes onActivityClick with agentId and activityId', async () => {
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
    const onActivityClick = vi.fn();
    render(<Activity onActivityClick={onActivityClick} />);
    await waitFor(() => {
      expect(screen.getByText('act-1'.slice(0, 8))).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('act-1'.slice(0, 8)).closest('tr')!);
    expect(onActivityClick).toHaveBeenCalledWith('agent-a', 'act-1');
  });
});
