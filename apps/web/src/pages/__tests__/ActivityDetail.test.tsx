import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import ActivityDetail from '../ActivityDetail';

const mockActivityDetail = vi.fn();

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    activityDetail: vi.fn(),
  },
}));

vi.mock('../../api', () => ({
  api: { activityDetail: mockApi.activityDetail },
}));

function makeActivity(): any {
  return {
    id: 'act-1',
    agentId: 'agent-a',
    ownerId: 'owner-a',
    intent: { type: 'payment', asset: 'XLM', amount: '50', destination: 'G...', reason: 'test' },
    policyDecision: { result: 'allow', reason: 'within limit', rule: 'maxTxAmount', intent: {} as any },
    authorizationStatus: 'not_required',
    simulationResult: { success: true, fee: '100', operations: 1, warnings: [] },
    txHash: 'ca1234567890abcdef',
    status: 'confirmed',
    error: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:01:00Z',
  };
}

describe('ActivityDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state', () => {
    mockApi.activityDetail.mockReturnValue(new Promise(() => {}));
    render(<ActivityDetail agentId="agent-a" activityId="act-1" />);
    expect(screen.getByText('Loading activity...')).toBeInTheDocument();
  });

  it('renders activity detail on success', async () => {
    mockApi.activityDetail.mockResolvedValue({ activity: makeActivity() });
    render(<ActivityDetail agentId="agent-a" activityId="act-1" />);
    await waitFor(() => {
      expect(screen.getByText('Activity Detail')).toBeInTheDocument();
    });
    expect(screen.getByText('act-1')).toBeInTheDocument();
    expect(screen.getByText('payment')).toBeInTheDocument();
    expect(screen.getByText('confirmed')).toBeInTheDocument();
  });

  it('renders error state', async () => {
    mockApi.activityDetail.mockRejectedValue(new Error('API error'));
    render(<ActivityDetail agentId="agent-a" activityId="act-1" />);
    await waitFor(() => {
      expect(screen.getByText('Failed to load activity')).toBeInTheDocument();
    });
  });

  it('renders not-found when activity is null', async () => {
    mockApi.activityDetail.mockResolvedValue({ activity: null });
    render(<ActivityDetail agentId="agent-a" activityId="act-1" />);
    await waitFor(() => {
      expect(screen.getByText('Activity not found')).toBeInTheDocument();
    });
  });

  it('calls activityDetail with correct agentId and activityId', async () => {
    mockApi.activityDetail.mockResolvedValue({ activity: makeActivity() });
    render(<ActivityDetail agentId="agent-a" activityId="act-1" />);
    await waitFor(() => {
      expect(mockApi.activityDetail).toHaveBeenCalledWith('agent-a', 'act-1');
    });
  });

  it('renders policy decision section when present', async () => {
    mockApi.activityDetail.mockResolvedValue({ activity: makeActivity() });
    render(<ActivityDetail agentId="agent-a" activityId="act-1" />);
    await waitFor(() => {
      expect(screen.getByText('Policy Decision')).toBeInTheDocument();
    });
    expect(screen.getByText('allow')).toBeInTheDocument();
    expect(screen.getByText('within limit')).toBeInTheDocument();
  });

  it('renders simulation result when present', async () => {
    mockApi.activityDetail.mockResolvedValue({ activity: makeActivity() });
    render(<ActivityDetail agentId="agent-a" activityId="act-1" />);
    await waitFor(() => {
      expect(screen.getByText('Simulation')).toBeInTheDocument();
    });
    expect(screen.getByText('ok')).toBeInTheDocument();
  });

  it('renders authorization status when present', async () => {
    mockApi.activityDetail.mockResolvedValue({ activity: makeActivity() });
    render(<ActivityDetail agentId="agent-a" activityId="act-1" />);
    await waitFor(() => {
      expect(screen.getByText('Authorization')).toBeInTheDocument();
    });
    expect(screen.getByText('not_required')).toBeInTheDocument();
  });

  it('renders error details when activity has error', async () => {
    const activity = makeActivity();
    activity.error = 'Transaction failed: insufficient funds';
    mockApi.activityDetail.mockResolvedValue({ activity });
    render(<ActivityDetail agentId="agent-a" activityId="act-1" />);
    await waitFor(() => {
      expect(screen.getByText('Error')).toBeInTheDocument();
    });
    expect(screen.getByText('Transaction failed: insufficient funds')).toBeInTheDocument();
  });

  it('calls onBack when back button clicked', async () => {
    const onBack = vi.fn();
    mockApi.activityDetail.mockResolvedValue({ activity: makeActivity() });
    render(<ActivityDetail agentId="agent-a" activityId="act-1" onBack={onBack} />);
    await waitFor(() => {
      expect(screen.getByText('Activity Detail')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('←'));
    expect(onBack).toHaveBeenCalled();
  });
});
