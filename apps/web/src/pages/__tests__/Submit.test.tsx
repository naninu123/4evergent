import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { test, expect, describe, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

const { mockSubmitPayment, mockSubmitTrustline, mockListAgents } = vi.hoisted(() => ({
  mockSubmitPayment: vi.fn(),
  mockSubmitTrustline: vi.fn(),
  mockListAgents: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: {
    listAgents: mockListAgents,
    submitPayment: mockSubmitPayment,
    submitTrustline: mockSubmitTrustline,
  },
}));

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
    mockListAgents.mockResolvedValue({
      agents: [{ id: 'agent-1', displayName: 'Test Agent' }],
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
    fireEvent.change(screen.getByLabelText('Destination (Stellar G...)'), { target: { value: 'GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQ' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Monthly payment' } });
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
      expect.objectContaining({ type: 'payment', amount: '10' }),
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/\S+/) })
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
    fireEvent.change(screen.getByLabelText('Issuer (Stellar G...)'), { target: { value: 'GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRS' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Add trustline' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));

    await waitFor(() => {
      expect(screen.getByText('View activity')).toBeInTheDocument();
    });

    expect(screen.getByText('View activity').closest('a')).toHaveAttribute(
      'href',
      '/agents/agent-1/activity/act-789'
    );
    expect(mockSubmitTrustline).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({ type: 'trustline', assetCode: 'USDC' }),
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/\S+/) })
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
    fireEvent.change(screen.getByLabelText('Destination (Stellar G...)'), { target: { value: 'GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQSS' } });
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
    fireEvent.change(screen.getByLabelText('Destination (Stellar G...)'), { target: { value: 'GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRS' } });
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
    fireEvent.change(screen.getByLabelText('Destination (Stellar G...)'), { target: { value: 'GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQ' } });

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
      expect.objectContaining({ idempotencyKey: expect.any(String) })
    );
  });

  test('reuses the same Idempotency-Key when retrying after a failure and renders 200 duplicate response as success', async () => {
    mockSubmitPayment
      .mockRejectedValueOnce(new Error('Network timeout'))
      .mockResolvedValueOnce({
        activityId: 'act-original-777',
        agentId: 'agent-1',
        status: 'submitted',
        policyDecision: { result: 'allow', reason: 'ok', rule: 'r', intent: {} },
        authorizationStatus: 'not_required',
        simulationResult: null,
        txHash: 'abc123',
        error: null,
      });

    renderSubmit();

    await waitFor(() => {
      expect(screen.getByLabelText('Agent')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '25' } });
    fireEvent.change(screen.getByLabelText('Destination (Stellar G...)'), { target: { value: 'GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQ' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Invoice 42' } });

    // First attempt fails
    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Network timeout');
    });

    const firstKey = mockSubmitPayment.mock.calls[0]![2]?.idempotencyKey;
    expect(typeof firstKey).toBe('string');
    expect(firstKey.length).toBeGreaterThan(0);

    // Retry of the exact same submission reuses the same key and renders duplicate 200 as success
    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(
        'Intent submitted. Activity: act-original-777. Status: submitted'
      );
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('View activity').closest('a')).toHaveAttribute(
      'href',
      '/agents/agent-1/activity/act-original-777'
    );

    const retryKey = mockSubmitPayment.mock.calls[1]![2]?.idempotencyKey;
    expect(retryKey).toBe(firstKey);
  });

  test('generates a fresh Idempotency-Key after success, form reset, or intent edit', async () => {
    mockSubmitPayment
      .mockResolvedValueOnce({
        activityId: 'act-first',
        agentId: 'agent-1',
        status: 'submitted',
      })
      .mockRejectedValueOnce(new Error('Temporary 503'))
      .mockRejectedValueOnce(new Error('Temporary 503'))
      .mockResolvedValueOnce({
        activityId: 'act-after-reset',
        agentId: 'agent-1',
        status: 'submitted',
      });

    const { container } = renderSubmit();

    await waitFor(() => {
      expect(screen.getByLabelText('Agent')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Destination (Stellar G...)'), { target: { value: 'GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQ' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Subscription' } });

    // 1. First submission succeeds
    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));
    await waitFor(() => {
      expect(screen.getByText(/act-first/)).toBeInTheDocument();
    });
    const key1 = mockSubmitPayment.mock.calls[0]![2]?.idempotencyKey;

    // 2. Submitting again after success sends a fresh key even with identical fields
    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Temporary 503');
    });
    const key2 = mockSubmitPayment.mock.calls[1]![2]?.idempotencyKey;
    expect(key2).not.toBe(key1);

    // 3. Editing the intent after a failure sends a fresh key (never shared across different intents)
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));
    await waitFor(() => {
      expect(mockSubmitPayment).toHaveBeenCalledTimes(3);
    });
    const key3 = mockSubmitPayment.mock.calls[2]![2]?.idempotencyKey;
    expect(key3).not.toBe(key2);

    // 4. Form reset clears the pending attempt key so the next submission gets a fresh key
    fireEvent.reset(container.querySelector('form')!);
    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));
    await waitFor(() => {
      expect(screen.getByText(/act-after-reset/)).toBeInTheDocument();
    });
    const key4 = mockSubmitPayment.mock.calls[3]![2]?.idempotencyKey;
    expect(key4).not.toBe(key3);
  });
});
