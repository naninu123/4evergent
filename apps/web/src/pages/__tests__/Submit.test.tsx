import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { test, expect, describe, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ApiError } from '../../api';

const { mockSubmitPayment, mockSubmitTrustline, mockListAllAgents } = vi.hoisted(() => ({
  mockSubmitPayment: vi.fn(),
  mockSubmitTrustline: vi.fn(),
  mockListAllAgents: vi.fn(),
}));

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    api: {
      listAllAgents: mockListAllAgents,
      submitPayment: mockSubmitPayment,
      submitTrustline: mockSubmitTrustline,
    },
  };
});

import Submit from '../Submit';

function renderSubmit() {
  return render(
    <MemoryRouter>
      <Submit />
    </MemoryRouter>
  );
}

describe('Submit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAllAgents.mockResolvedValue({
      agents: [{ id: 'agent-1', displayName: 'Test Agent' }],
      total: 1,
      truncated: false,
    });
  });

  test('shows View activity link after successful payment submit', async () => {
    mockSubmitPayment.mockResolvedValue({
      activityId: 'act-123',
      approvalId: 'appr-456',
      status: 'pending_approval',
    });

    renderSubmit();

    await waitFor(() => {
      expect(screen.getByLabelText('Agent')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Destination (Stellar G...)'), { target: { value: 'GB3KJPLFUYN5VL6R3GU3EGCGVCKFDSD7BEDX42HWG5BWFKB3KQGJJRMA' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Monthly payment' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));

    await waitFor(() => {
      expect(screen.getByText('View activity')).toBeInTheDocument();
    });

    expect(screen.getByText('View activity').closest('a')).toHaveAttribute(
      'href',
      '/agents/agent-1/activity/act-123'
    );
  });

  test('shows View activity link after successful trustline submit', async () => {
    mockSubmitTrustline.mockResolvedValue({
      activityId: 'act-789',
      status: 'pending',
    });

    renderSubmit();

    await waitFor(() => {
      expect(screen.getByLabelText('Agent')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Intent Type'), { target: { value: 'trustline' } });
    fireEvent.change(screen.getByLabelText('Asset Code'), { target: { value: 'USDC' } });
    fireEvent.change(screen.getByLabelText('Issuer (Stellar G...)'), { target: { value: 'GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Add trustline' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));

    await waitFor(() => {
      expect(screen.getByText('View activity')).toBeInTheDocument();
    });

    expect(screen.getByText('View activity').closest('a')).toHaveAttribute(
      'href',
      '/agents/agent-1/activity/act-789'
    );
  });

  test('does not show View activity link when activityId is missing', async () => {
    mockSubmitPayment.mockResolvedValue({
      activityId: '',
      status: 'pending',
    });

    renderSubmit();

    await waitFor(() => {
      expect(screen.getByLabelText('Agent')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Destination (Stellar G...)'), { target: { value: 'GB3KJPLFUYN5VL6R3GU3EGCGVCKFDSD7BEDX42HWG5BWFKB3KQGJJRMA' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Monthly payment' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));

    await waitFor(() => {
      expect(screen.getByText(/Intent submitted/)).toBeInTheDocument();
    });

    expect(screen.queryByText('View activity')).not.toBeInTheDocument();
  });

  test('renders error banner with role="alert" when submit fails', async () => {
    mockSubmitPayment.mockRejectedValue(new Error('Insufficient funds'));

    renderSubmit();

    await waitFor(() => {
      expect(screen.getByLabelText('Agent')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Destination (Stellar G...)'), { target: { value: 'GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Monthly payment' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Insufficient funds');
    });
  });

  test('every form input has an associated label', async () => {
    renderSubmit();

    await waitFor(() => {
      expect(screen.getByLabelText('Agent')).toBeInTheDocument();
    });

    expect(screen.getByLabelText('Intent Type')).toBeInTheDocument();
    expect(screen.getByLabelText('Asset')).toBeInTheDocument();
    expect(screen.getByLabelText('Amount')).toBeInTheDocument();
    expect(screen.getByLabelText('Destination (Stellar G...)')).toBeInTheDocument();
    expect(screen.getByLabelText('Reason')).toBeInTheDocument();
  });

  test('selecting Other and entering asset code keeps the value visible and submits correctly', async () => {
    mockSubmitPayment.mockResolvedValue({
      activityId: 'act-123',
      approvalId: 'appr-456',
      status: 'pending_approval',
    });

    renderSubmit();

    await waitFor(() => {
      expect(screen.getByLabelText('Agent')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Asset'), { target: { value: 'other' } });
    expect(screen.getByPlaceholderText('e.g. USDC')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('e.g. USDC'), { target: { value: 'USDC' } });
    expect(screen.getByPlaceholderText('e.g. USDC')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. USDC')).toHaveValue('USDC');

    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Monthly payment' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Destination (Stellar G...)'), { target: { value: 'GB3KJPLFUYN5VL6R3GU3EGCGVCKFDSD7BEDX42HWG5BWFKB3KQGJJRMA' } });

    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));

    await waitFor(() => {
      expect(screen.getByText('View activity')).toBeInTheDocument();
    });

    expect(screen.getByText('View activity').closest('a')).toHaveAttribute(
      'href',
      '/agents/agent-1/activity/act-123'
    );

    expect(mockSubmitPayment).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({ asset: 'USDC' })
    );
  });

  test('a 403 deny renders the policy decision reason and the activity link', async () => {
    const errorBody = {
      activityId: 'act-deny-123',
      agentId: 'agent-1',
      status: 'rejected',
      error: 'Transaction exceeds daily limit',
      policyDecision: {
        result: 'deny',
        reason: 'amount exceeds daily limit',
        rule: 'dailySpendingLimit',
      },
    };
    mockSubmitPayment.mockRejectedValue(
      new ApiError(403, 'Transaction exceeds daily limit', 'POLICY_DENIED', undefined, errorBody)
    );

    renderSubmit();

    await waitFor(() => {
      expect(screen.getByLabelText('Agent')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Destination (Stellar G...)'), { target: { value: 'GB3KJPLFUYN5VL6R3GU3EGCGVCKFDSD7BEDX42HWG5BWFKB3KQGJJRMA' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Large payment' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    const alertBanner = screen.getByRole('alert');
    expect(alertBanner).toHaveClass('error-banner');
    expect(alertBanner).toHaveTextContent('amount exceeds daily limit');
    expect(alertBanner).toHaveTextContent('act-deny-123');

    const activityLink = screen.getByText('View activity');
    expect(activityLink).toBeInTheDocument();
    expect(activityLink.closest('a')).toHaveAttribute(
      'href',
      '/agents/agent-1/activity/act-deny-123'
    );
  });

  test('a 422 simulation failure renders the failure and the activity link', async () => {
    const errorBody = {
      activityId: 'act-sim-456',
      agentId: 'agent-1',
      status: 'simulation_failed',
      error: 'Simulation failed: op_underfunded',
      simulationResult: { success: false, error: 'op_underfunded' },
    };
    mockSubmitPayment.mockRejectedValue(
      new ApiError(422, 'Simulation failed: op_underfunded', 'SIMULATION_FAILED', undefined, errorBody)
    );

    renderSubmit();

    await waitFor(() => {
      expect(screen.getByLabelText('Agent')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Destination (Stellar G...)'), { target: { value: 'GB3KJPLFUYN5VL6R3GU3EGCGVCKFDSD7BEDX42HWG5BWFKB3KQGJJRMA' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Payment' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    const alertBanner = screen.getByRole('alert');
    expect(alertBanner).toHaveClass('error-banner');
    expect(alertBanner).toHaveTextContent('Simulation failed: op_underfunded');
    expect(alertBanner).toHaveTextContent('act-sim-456');

    const activityLink = screen.getByText('View activity');
    expect(activityLink).toBeInTheDocument();
    expect(activityLink.closest('a')).toHaveAttribute(
      'href',
      '/agents/agent-1/activity/act-sim-456'
    );
  });

  test('a network failure with no body renders as today without activity link', async () => {
    mockSubmitPayment.mockRejectedValue(new Error('Failed to fetch'));

    renderSubmit();

    await waitFor(() => {
      expect(screen.getByLabelText('Agent')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Destination (Stellar G...)'), { target: { value: 'GB3KJPLFUYN5VL6R3GU3EGCGVCKFDSD7BEDX42HWG5BWFKB3KQGJJRMA' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Payment' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    const alertBanner = screen.getByRole('alert');
    expect(alertBanner).toHaveClass('error-banner');
    expect(alertBanner).toHaveTextContent('Failed to fetch');
    expect(screen.queryByText('View activity')).not.toBeInTheDocument();
  });
});

describe('Submit field-level validation', () => {
  const VALID = 'GB3KJPLFUYN5VL6R3GU3EGCGVCKFDSD7BEDX42HWG5BWFKB3KQGJJRMA';

  beforeEach(() => {
    vi.clearAllMocks();
    mockListAllAgents.mockResolvedValue({
      agents: [{ id: 'agent-1', displayName: 'Test Agent' }],
      total: 1,
      truncated: false,
    });
  });

  async function fillPayment(destination: string) {
    renderSubmit();
    await waitFor(() => expect(screen.getByLabelText('Agent')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Destination (Stellar G...)'), { target: { value: destination } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Monthly payment' } });
  }

  test('invalid destination is reported at the field and nothing is sent', async () => {
    await fillPayment('Gxxx');
    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));

    const err = await screen.findByText(/Destination must be a Stellar account/);
    expect(err).toHaveAttribute('id', 'destination-error');
    expect(screen.getByLabelText('Destination (Stellar G...)')).toHaveAttribute('aria-invalid', 'true');
    expect(mockSubmitPayment).not.toHaveBeenCalled();
  });

  test('empty "Other" asset code is rejected at the field', async () => {
    await fillPayment(VALID);
    fireEvent.change(screen.getByLabelText('Asset'), { target: { value: 'other' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));

    const err = await screen.findByText('Asset code is required.');
    expect(err).toHaveAttribute('id', 'asset-code-error');
    expect(mockSubmitPayment).not.toHaveBeenCalled();
  });

  test('malformed payment issuer is rejected at the field', async () => {
    await fillPayment(VALID);
    fireEvent.change(screen.getByLabelText('Asset'), { target: { value: 'USDC' } });
    fireEvent.change(screen.getByLabelText('Issuer (Stellar G...)'), { target: { value: 'GSHORT' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));

    const err = await screen.findByText(/Issuer must be a Stellar account/);
    expect(err).toHaveAttribute('id', 'issuer-error');
    expect(mockSubmitPayment).not.toHaveBeenCalled();
  });

  test('trustline: missing issuer and too-long asset code are rejected at their fields', async () => {
    renderSubmit();
    await waitFor(() => expect(screen.getByLabelText('Agent')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Intent Type'), { target: { value: 'trustline' } });
    fireEvent.change(screen.getByLabelText('Asset Code'), { target: { value: 'ABCDEFGHIJKLM' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Add trustline' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));

    expect(await screen.findByText('Asset code must be 1-12 characters.')).toHaveAttribute('id', 'tl-asset-code-error');
    expect(screen.getByText('Issuer is required.')).toHaveAttribute('id', 'tl-issuer-error');
    expect(mockSubmitTrustline).not.toHaveBeenCalled();
  });

  test('valid values still submit', async () => {
    mockSubmitPayment.mockResolvedValue({ activityId: 'act-1', status: 'executed' });
    await fillPayment(VALID);
    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));

    await waitFor(() => expect(mockSubmitPayment).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/must be a Stellar account/)).not.toBeInTheDocument();
  });
});
