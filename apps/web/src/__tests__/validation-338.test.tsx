import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import {
  isValidStellarAddress,
  isValidAssetCode,
  validateStellarAddressField,
  validateAssetCodeField,
  validateCronExpressionShape,
} from '../validation';

const {
  mockListAllAgents,
  mockSubmitPayment,
  mockSubmitTrustline,
  mockListSchedules,
  mockCreateSchedule,
  mockUpdateSchedule,
  mockGetAgent,
  mockGetAgentSpending,
  mockGetPolicy,
  mockUpdatePolicy,
} = vi.hoisted(() => ({
  mockListAllAgents: vi.fn(),
  mockSubmitPayment: vi.fn(),
  mockSubmitTrustline: vi.fn(),
  mockListSchedules: vi.fn(),
  mockCreateSchedule: vi.fn(),
  mockUpdateSchedule: vi.fn(),
  mockGetAgent: vi.fn(),
  mockGetAgentSpending: vi.fn(),
  mockGetPolicy: vi.fn(),
  mockUpdatePolicy: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listAllAgents: mockListAllAgents,
      submitPayment: mockSubmitPayment,
      submitTrustline: mockSubmitTrustline,
      listSchedules: mockListSchedules,
      createSchedule: mockCreateSchedule,
      updateSchedule: mockUpdateSchedule,
      getAgent: mockGetAgent,
      agentActivity: vi.fn().mockResolvedValue({ agentId: 'agent-1', activity: [] }),
      listAgentExecutions: vi.fn().mockResolvedValue({ agentId: 'agent-1', executions: [] }),
      getAgentSpending: mockGetAgentSpending,
      getPolicy: mockGetPolicy,
      updatePolicy: mockUpdatePolicy,
    },
  };
});

import Submit from '../pages/Submit';
import { ScheduleManagement } from '../pages/ScheduleManagement';
import AgentDetail from '../pages/AgentDetail';

const VALID_ADDR = 'GB3KJPLFUYN5VL6R3GU3EGCGVCKFDSD7BEDX42HWG5BWFKB3KQGJJRMA';

describe('Shared client-side validators (#338)', () => {
  test('isValidStellarAddress validates G prefix, 56-char length, and base32 alphabet (A-Z, 2-7)', () => {
    expect(isValidStellarAddress(VALID_ADDR)).toBe(true);
    expect(isValidStellarAddress('G')).toBe(false);
    expect(isValidStellarAddress('Gxxx')).toBe(false);
    // Contains invalid base32 digits '0', '1', '8', '9'
    expect(isValidStellarAddress('G0189JPLFUYN5VL6R3GU3EGCGVCKFDSD7BEDX42HWG5BWFKB3KQGJJRM')).toBe(false);
    // Lowercase or wrong prefix
    expect(isValidStellarAddress(VALID_ADDR.toLowerCase())).toBe(false);
    expect(isValidStellarAddress('S' + VALID_ADDR.slice(1))).toBe(false);
    expect(validateStellarAddressField('Gshort', 'Destination')).toMatch(/Destination must be a 56-character Stellar G/);
  });

  test('isValidAssetCode enforces 1-12 character length', () => {
    expect(isValidAssetCode('USDC')).toBe(true);
    expect(isValidAssetCode('ABCDEFGHIJKL')).toBe(true);
    expect(isValidAssetCode('')).toBe(false);
    expect(isValidAssetCode('   ')).toBe(false);
    expect(isValidAssetCode('ABCDEFGHIJKLM')).toBe(false);
    expect(validateAssetCodeField('', 'Custom asset code')).toMatch(/Custom asset code is required/);
    expect(validateAssetCodeField('1234567890123', 'Custom asset code')).toMatch(/1-12 characters/);
  });

  test('validateCronExpressionShape enforces 5 fields and server cron bounds', () => {
    expect(validateCronExpressionShape('0 0 * * *')).toEqual({ valid: true });
    expect(validateCronExpressionShape('*/15 0-12 1,15 1-6 0-5')).toEqual({ valid: true });
    expect(validateCronExpressionShape('garbage').valid).toBe(false);
    expect(validateCronExpressionShape('60 0 * * *').error).toMatch(/invalid minute/);
    expect(validateCronExpressionShape('0 24 * * *').error).toMatch(/invalid hour/);
    expect(validateCronExpressionShape('0 0 32 * *').error).toMatch(/invalid day-of-month/);
    expect(validateCronExpressionShape('0 0 * 13 *').error).toMatch(/invalid month/);
    expect(validateCronExpressionShape('0 0 * * 7').error).toMatch(/invalid day-of-week/);
  });
});

describe('Form field-level validation (#338)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAllAgents.mockResolvedValue({
      agents: [{ id: 'agent-1', displayName: 'Test Agent' }],
      total: 1,
      truncated: false,
    });
    mockListSchedules.mockResolvedValue({ schedules: [] });
  });

  test('Submit form rejects short G... destination, empty Other asset code, and invalid issuer at the field before sending', async () => {
    render(<MemoryRouter><Submit /></MemoryRouter>);
    await waitFor(() => expect(screen.getByLabelText('Agent')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Asset'), { target: { value: 'other' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Destination (Stellar G...)'), { target: { value: 'Gshort' } });
    fireEvent.change(screen.getByLabelText('Issuer (Stellar G...)'), { target: { value: 'Gbadissuer' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Field check' } });

    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));

    expect(screen.getByTestId('asset-code-error')).toHaveTextContent(/Custom asset code is required/);
    expect(screen.getByTestId('destination-error')).toHaveTextContent(/Destination must be a 56-character Stellar G/);
    expect(screen.getByTestId('issuer-error')).toHaveTextContent(/Issuer must be a 56-character Stellar G/);
    expect(mockSubmitPayment).not.toHaveBeenCalled();
  });

  test('Submit trustline form rejects >12-char asset code and invalid issuer at the field', async () => {
    render(<MemoryRouter><Submit /></MemoryRouter>);
    await waitFor(() => expect(screen.getByLabelText('Agent')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Intent Type'), { target: { value: 'trustline' } });
    fireEvent.change(screen.getByLabelText('Asset Code'), { target: { value: 'TOO_LONG_ASSET_CODE' } });
    fireEvent.change(screen.getByLabelText('Issuer (Stellar G...)'), { target: { value: 'G123' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Trustline check' } });

    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));

    expect(screen.getByTestId('tl-asset-code-error')).toHaveTextContent(/1-12 characters/);
    expect(screen.getByTestId('tl-issuer-error')).toHaveTextContent(/Trustline issuer must be a 56-character Stellar G/);
    expect(mockSubmitTrustline).not.toHaveBeenCalled();
  });

  test('CreateScheduleForm rejects invalid destination and malformed cron expression at the field before sending', async () => {
    render(<MemoryRouter><ScheduleManagement agentId="agent-1" /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Create Schedule')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Create Schedule'));

    fireEvent.change(screen.getByPlaceholderText('10'), { target: { value: '15' } });
    fireEvent.change(screen.getByPlaceholderText('G...'), { target: { value: 'Gshort' } });
    fireEvent.change(screen.getByPlaceholderText('Recurring payment'), { target: { value: 'Payroll' } });
    fireEvent.change(
      screen.getByPlaceholderText('0 0 * * * (minute hour day-of-month month day-of-week)'),
      { target: { value: '99 0 * * *' } }
    );

    fireEvent.click(screen.getByText('Create Schedule'));

    expect(screen.getByTestId('schedule-destination-error')).toHaveTextContent(/Destination must be a 56-character Stellar G/);
    expect(screen.getByTestId('schedule-expression-error')).toHaveTextContent(/invalid minute/);
    expect(mockCreateSchedule).not.toHaveBeenCalled();
  });

  test('Policy editor refuses to add an invalid destination chip and shows inline field error', async () => {
    mockGetAgent.mockResolvedValue({
      id: 'agent-1',
      displayName: 'Test Agent',
      description: 'test',
      ownerId: 'owner-1',
      stellarAddress: VALID_ADDR,
      capabilities: ['payment'],
      status: 'active',
      active: true,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    mockGetAgentSpending.mockResolvedValue({ agentId: 'agent-1', spending: {} });
    mockGetPolicy.mockResolvedValue({
      agentId: 'agent-1',
      policy: {
        maxTxAmount: { XLM: '100' },
        dailySpendingLimit: { XLM: '500' },
        allowedAssets: ['XLM'],
        allowedDestinations: [],
        allowedContractIds: [],
        txTypeRestrictions: { payment: true, trustline: true, contract_call: false, account_settings: false },
        approvalThreshold: '50',
        requireHumanApprovalForAmountAbove: '50',
      },
      version: 1,
      updatedAt: '2026-01-01T00:00:00Z',
    });

    render(
      <MemoryRouter initialEntries={['/agents/agent-1']}>
        <Routes>
          <Route path="/agents/:agentId" element={<AgentDetail />} />
        </Routes>
      </MemoryRouter>
    );

    const destChipInput = await screen.findByLabelText('Add allowed destination');
    fireEvent.change(destChipInput, { target: { value: 'not-a-stellar-addr' } });
    fireEvent.keyDown(destChipInput, { key: 'Enter', code: 'Enter' });

    expect(screen.getByTestId('policy-destination-chip-error')).toHaveTextContent(/Destination address must be a 56-character Stellar G/);
    expect(screen.queryByLabelText('Remove allowed destination not-a-stellar-addr')).not.toBeInTheDocument();

    // Valid 56-char address adds the chip and clears the error
    fireEvent.change(destChipInput, { target: { value: VALID_ADDR } });
    fireEvent.keyDown(destChipInput, { key: 'Enter', code: 'Enter' });

    expect(screen.queryByTestId('policy-destination-chip-error')).not.toBeInTheDocument();
    expect(screen.getByLabelText(`Remove allowed destination ${VALID_ADDR}`)).toBeInTheDocument();
  });
});
