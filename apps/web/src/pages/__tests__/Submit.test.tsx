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
      expect.objectContaining({ asset: 'USDC' }),
      expect.any(String)
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

  test('reuses the same Idempotency-Key on retry after failure and renders 200 duplicate as success', async () => {
    const uuidSpy = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');

    // First attempt fails with a 500/network error; retry receives a 200 idempotent-duplicate response
    mockSubmitPayment
      .mockRejectedValueOnce(new ApiError(502, 'Upstream timeout'))
      .mockResolvedValueOnce({
        activityId: 'act-orig-999',
        agentId: 'agent-1',
        status: 'submitted',
      });

    renderSubmit();

    await waitFor(() => {
      expect(screen.getByLabelText('Agent')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '25' } });
    fireEvent.change(screen.getByLabelText('Destination (Stellar G...)'), {
      target: { value: 'GB3KJPLFUYN5VL6R3GU3EGCGVCKFDSD7BEDX42HWG5BWFKB3KQGJJRMA' },
    });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Invoice 42' } });

    // First attempt fails
    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Upstream timeout');
    });

    // Retry the same submission
    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument();
    });

    expect(mockSubmitPayment).toHaveBeenCalledTimes(2);
    const firstKey = mockSubmitPayment.mock.calls[0]![2];
    const secondKey = mockSubmitPayment.mock.calls[1]![2];
    expect(firstKey).toBe('11111111-1111-4111-8111-111111111111');
    expect(secondKey).toBe(firstKey);

    // 200 duplicate response renders as success showing original activity link, not an error
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const statusBanner = screen.getByRole('status');
    expect(statusBanner).toHaveClass('success-banner');
    expect(statusBanner).toHaveTextContent('act-orig-999');
    expect(screen.getByText('View activity').closest('a')).toHaveAttribute(
      'href',
      '/agents/agent-1/activity/act-orig-999'
    );

    uuidSpy.mockRestore();
  });

  test('reuses the same Idempotency-Key on trustline retry after failure', async () => {
    const uuidSpy = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('33333333-3333-4333-8333-333333333333')
      .mockReturnValueOnce('44444444-4444-4444-8444-444444444444');

    mockSubmitTrustline
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({
        activityId: 'act-tl-orig',
        agentId: 'agent-1',
        status: 'submitted',
      });

    renderSubmit();

    await waitFor(() => {
      expect(screen.getByLabelText('Agent')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Intent Type'), { target: { value: 'trustline' } });
    fireEvent.change(screen.getByLabelText('Asset Code'), { target: { value: 'USDC' } });
    fireEvent.change(screen.getByLabelText('Issuer (Stellar G...)'), {
      target: { value: 'GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U' },
    });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Enable USDC' } });

    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Network error');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('act-tl-orig');
    });

    expect(mockSubmitTrustline).toHaveBeenCalledTimes(2);
    expect(mockSubmitTrustline.mock.calls[0]![2]).toBe('33333333-3333-4333-8333-333333333333');
    expect(mockSubmitTrustline.mock.calls[1]![2]).toBe('33333333-3333-4333-8333-333333333333');

    uuidSpy.mockRestore();
  });

  test('generates a fresh Idempotency-Key for a new submission after success', async () => {
    const uuidSpy = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('55555555-5555-4555-8555-555555555555')
      .mockReturnValueOnce('66666666-6666-4666-8666-666666666666');

    mockSubmitPayment
      .mockResolvedValueOnce({ activityId: 'act-1', agentId: 'agent-1', status: 'submitted' })
      .mockResolvedValueOnce({ activityId: 'act-2', agentId: 'agent-1', status: 'submitted' });

    renderSubmit();

    await waitFor(() => {
      expect(screen.getByLabelText('Agent')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Destination (Stellar G...)'), {
      target: { value: 'GB3KJPLFUYN5VL6R3GU3EGCGVCKFDSD7BEDX42HWG5BWFKB3KQGJJRMA' },
    });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Recurring payment' } });

    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('act-1');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('act-2');
    });

    expect(mockSubmitPayment).toHaveBeenCalledTimes(2);
    expect(mockSubmitPayment.mock.calls[0]![2]).toBe('55555555-5555-4555-8555-555555555555');
    expect(mockSubmitPayment.mock.calls[1]![2]).toBe('66666666-6666-4666-8666-666666666666');

    uuidSpy.mockRestore();
  });

  test('generates a fresh Idempotency-Key when the intent changes or the form resets after failure', async () => {
    const uuidSpy = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('77777777-7777-4777-8777-777777777777')
      .mockReturnValueOnce('88888888-8888-4888-8888-888888888888')
      .mockReturnValueOnce('99999999-9999-4999-8999-999999999999');

    mockSubmitPayment
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce({ activityId: 'act-3', agentId: 'agent-1', status: 'submitted' });

    const { container } = renderSubmit();

    await waitFor(() => {
      expect(screen.getByLabelText('Agent')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Destination (Stellar G...)'), {
      target: { value: 'GB3KJPLFUYN5VL6R3GU3EGCGVCKFDSD7BEDX42HWG5BWFKB3KQGJJRMA' },
    });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Payment' } });

    // 1st attempt fails
    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Failed to fetch');
    });

    // Edit amount -> different intent -> must get a fresh key
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));
    await waitFor(() => {
      expect(mockSubmitPayment).toHaveBeenCalledTimes(2);
    });

    // Reset form -> must clear stored key so next submit gets a fresh key
    fireEvent.reset(container.querySelector('form')!);
    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('act-3');
    });

    expect(mockSubmitPayment.mock.calls[0]![2]).toBe('77777777-7777-4777-8777-777777777777');
    expect(mockSubmitPayment.mock.calls[1]![2]).toBe('88888888-8888-4888-8888-888888888888');
    expect(mockSubmitPayment.mock.calls[2]![2]).toBe('99999999-9999-4999-8999-999999999999');

    uuidSpy.mockRestore();
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
