import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ApprovalDetail from '../ApprovalDetail';

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    approvalDetail: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
  },
}));

vi.mock('../../api', () => ({ api: mockApi }));

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/approvals/aprv-1']}>
      <Routes>
        <Route path="/approvals/:approvalId" element={<ApprovalDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

function makeApproval(): any {
  return {
    id: 'aprv-1',
    activityId: 'act-1',
    agentId: 'agent-a',
    intent: { type: 'payment', asset: 'XLM', amount: '50', destination: 'GXXX', reason: 'test' },
    policyDecision: { result: 'requires_approval', reason: 'test', rule: 'test', intent: {} as any },
    status: 'pending_approval',
    requestedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('ApprovalDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state initially', () => {
    mockApi.approvalDetail.mockReturnValue(new Promise(() => {}));
    renderDetail();
    expect(screen.getByText(/Loading approval/i)).toBeInTheDocument();
  });

  it('renders approval detail on success', async () => {
    mockApi.approvalDetail.mockResolvedValue({ approval: makeApproval() });
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText(/Approval/i)).toBeInTheDocument();
    });
    expect(screen.getByText('agent-a')).toBeInTheDocument();
  });

  it('rejects only after confirming the pending approval', async () => {
    const approval = makeApproval();
    mockApi.approvalDetail.mockResolvedValueOnce({ approval })
      .mockResolvedValue({ approval: { ...approval, status: 'rejected' } });
    mockApi.reject.mockResolvedValue({});
    renderDetail();
    const trigger = await screen.findByRole('button', { name: 'Reject' });
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Reject this approval?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockApi.reject).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reject' }));
    expect(mockApi.reject).toHaveBeenCalledWith('aprv-1');
    await waitFor(() => expect(trigger).not.toBeInTheDocument());
  });

  it('renders error state', async () => {
    mockApi.approvalDetail.mockRejectedValue(new Error('API error'));
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText('API error')).toBeInTheDocument();
    });
  });

  it('renders not-found when approval is null', async () => {
    mockApi.approvalDetail.mockResolvedValue({ approval: null });
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText('Approval not found')).toBeInTheDocument();
    });
  });

  it('does not offer approve/reject buttons for an expired approval', async () => {
    const expired = {
      ...makeApproval(),
      expiresAt: new Date(Date.now() - 3600_000).toISOString(),
    };
    mockApi.approvalDetail.mockResolvedValue({ approval: expired });
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText(/Approval/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reject/i })).not.toBeInTheDocument();
  });

  it('surfaces rejection error when approving for a paused or disabled agent', async () => {
    const approval = makeApproval();
    mockApi.approvalDetail.mockResolvedValue({ approval });
    mockApi.approve.mockRejectedValue({
      status: 409,
      code: 'AGENT_NOT_ACTIVE',
      message: 'agent is paused; cannot approve intent',
    });
    renderDetail();
    const trigger = await screen.findByRole('button', { name: 'Approve' });
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByText('agent is paused; cannot approve intent')).toBeInTheDocument();
    });
  });
});
