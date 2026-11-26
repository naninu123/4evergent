import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Approvals from '../Approvals';
import { test, expect, describe, vi, afterEach } from 'vitest';

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    listApprovals: vi.fn(),
    listAllAgents: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
  }
}));

vi.mock('../../api', () => ({ api: mockApi }));

function makeApproval(id: string, agentId: string, amount: string) {
  return {
    id: `aprv-${id}`,
    activityId: `act-${id}`,
    agentId,
    intent: { type: 'payment', asset: 'XLM', amount, destination: 'GXXX' },
    policyDecision: { result: 'requires_approval', reason: 'test', rule: 'test', intent: {} as any },
    status: 'pending_approval',
    requestedAt: new Date().toISOString(),
    approvedAt: null,
    rejectedAt: null,
    expiredAt: null,
    approver: null,
    expiresAt: null,
    txHash: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('Approvals', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test('renders loading state initially', async () => {
    mockApi.listApprovals.mockReturnValue(new Promise(() => {}));
    render(<MemoryRouter><Approvals /></MemoryRouter>);
    expect(screen.getByText(/Loading approvals/i)).toBeInTheDocument();
  });

  test('renders empty state when no pending approvals', async () => {
    mockApi.listApprovals.mockResolvedValue({ approvals: [] });
    render(<MemoryRouter><Approvals /></MemoryRouter>);
    expect(await screen.findByText(/No pending approvals/i)).toBeInTheDocument();
  });

  test('renders approval row with agent and intent type', async () => {
    mockApi.listApprovals.mockResolvedValue({ approvals: [makeApproval('1', 'agent-a', '50')] });
    render(<MemoryRouter><Approvals /></MemoryRouter>);

    const row = await screen.findByText('agent-a').then((el) => el.closest('tr')!);
    expect(within(row).getByText('Approve')).toBeInTheDocument();
    expect(within(row).getByText('Reject')).toBeInTheDocument();
    expect(within(row).getByText('payment')).toBeInTheDocument();
  });

  test('approve button calls api.approve without raw XDR', async () => {
    mockApi.listApprovals.mockResolvedValue({ approvals: [makeApproval('2', 'agent-b', '10')] });
    mockApi.approve.mockResolvedValue({ approvalId: 'aprv-2', status: 'approved', message: 'ok', activityId: 'act-2' });

    render(<MemoryRouter><Approvals /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Approve')).toBeInTheDocument());

    screen.getByText('Approve').click();

    await waitFor(() => {
      const callArg = mockApi.approve.mock.calls[0];
      expect(callArg).toBeDefined();
      expect(callArg![0]).toBe('aprv-2');
      expect(typeof callArg![0]).toBe('string');
    });
  });

  test('expired approval renders expired badge and no approve/reject buttons', async () => {
    const expiredAppr = {
      ...makeApproval('expired', 'agent-exp', '100'),
      expiresAt: new Date(Date.now() - 3600_000).toISOString(),
    };
    mockApi.listApprovals.mockResolvedValue({ approvals: [expiredAppr] });
    render(<MemoryRouter><Approvals /></MemoryRouter>);

    const row = await screen.findByText('agent-exp').then((el) => el.closest('tr')!);
    expect(within(row).getByText('expired')).toBeInTheDocument();
    expect(within(row).queryByText('Approve')).not.toBeInTheDocument();
    expect(within(row).queryByText('Reject')).not.toBeInTheDocument();
  });

  test('reject button confirms before calling api.reject', async () => {
    mockApi.listApprovals.mockResolvedValue({ approvals: [makeApproval('3', 'agent-c', '5')] });
    mockApi.reject.mockResolvedValue({ approvalId: 'aprv-3', status: 'rejected', message: 'rejected', activityId: 'act-3' });

    render(<MemoryRouter><Approvals /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Reject')).toBeInTheDocument());

    screen.getByText('Reject').click();
    expect(await screen.findByRole('dialog', { name: 'Reject this approval?' })).toBeInTheDocument();
    expect(mockApi.reject).not.toHaveBeenCalled();
  });

  test('cancel reject does not call api.reject', async () => {
    mockApi.listApprovals.mockResolvedValue({ approvals: [makeApproval('4', 'agent-d', '3')] });
    mockApi.reject.mockResolvedValue({});

    render(<MemoryRouter><Approvals /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Reject')).toBeInTheDocument());

    screen.getByText('Reject').click();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockApi.reject).not.toHaveBeenCalled();
  });

  test('successful approve refreshes the list from server', async () => {
    mockApi.listApprovals
      .mockResolvedValueOnce({ approvals: [makeApproval('5', 'agent-e', '20')] })
      .mockResolvedValueOnce({ approvals: [] }); // after approve: nothing pending
    mockApi.approve.mockResolvedValue({ approvalId: 'aprv-5', status: 'approved', message: 'ok', activityId: 'act-5' });

    render(<MemoryRouter><Approvals /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Approve')).toBeInTheDocument());

    screen.getByText('Approve').click();

    await waitFor(() => {
      expect(mockApi.listApprovals).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByText(/No pending approvals/i)).toBeInTheDocument();
    });
  });

  test('successful reject refreshes the list from server', async () => {
    mockApi.listApprovals
      .mockResolvedValueOnce({ approvals: [makeApproval('6', 'agent-f', '30')] })
      .mockResolvedValueOnce({ approvals: [] });
    mockApi.reject.mockResolvedValue({ approvalId: 'aprv-6', status: 'rejected', message: 'rejected', activityId: 'act-6' });

    render(<MemoryRouter><Approvals /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Reject')).toBeInTheDocument());

    screen.getByText('Reject').click();
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reject' }));

    await waitFor(() => {
      expect(mockApi.listApprovals).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByText(/No pending approvals/i)).toBeInTheDocument();
    });
  });

  test('failed approve does not remove the row and terminates loading state', async () => {
    mockApi.listApprovals.mockResolvedValue({ approvals: [makeApproval('7', 'agent-g', '40')] });
    mockApi.approve.mockRejectedValue(new Error('409: conflict'));

    render(<MemoryRouter><Approvals /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Approve')).toBeInTheDocument());

    screen.getByText('Approve').click();

    // Row must remain (list untouched on failure) and button returns to enabled.
    await waitFor(() => {
      expect(screen.getByText('Approve')).toBeEnabled();
    });
    expect(screen.getByText('agent-g')).toBeInTheDocument();
    expect(mockApi.listApprovals).toHaveBeenCalledTimes(1); // no refresh on failure
  });

  test('failed reject does not remove the row and terminates loading state', async () => {
    mockApi.listApprovals.mockResolvedValue({ approvals: [makeApproval('8', 'agent-h', '15')] });
    mockApi.reject.mockRejectedValue(new Error('409: conflict'));

    render(<MemoryRouter><Approvals /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Reject')).toBeInTheDocument());

    screen.getByText('Reject').click();
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reject' }));

    await waitFor(() => {
      expect(screen.getByText('Reject')).toBeEnabled();
    });
    expect(screen.getByText('agent-h')).toBeInTheDocument();
    expect(mockApi.listApprovals).toHaveBeenCalledTimes(1);
  });

  test('renders agent display names for known agents and falls back to raw ID for unknown agents', async () => {
    mockApi.listAllAgents.mockResolvedValue({
      agents: [
        { id: 'agent-1', displayName: 'Treasury' },
        { id: 'agent-2', displayName: 'Payroll' },
      ],
      total: 2,
      truncated: false,
    });
    mockApi.listApprovals.mockResolvedValue({
      approvals: [
        makeApproval('1', 'agent-1', '50'),
        makeApproval('2', 'agent-2', '75'),
        makeApproval('3', 'agent-deleted-9999', '10'),
      ],
      hasMore: false,
    });

    render(<MemoryRouter><Approvals /></MemoryRouter>);

    expect(await screen.findByText('Treasury')).toBeInTheDocument();
    expect(screen.getByText('Payroll')).toBeInTheDocument();
    expect(screen.getByText('agent-deleted-9999')).toBeInTheDocument();
    expect(mockApi.listAllAgents).toHaveBeenCalledTimes(1);
  });
});
