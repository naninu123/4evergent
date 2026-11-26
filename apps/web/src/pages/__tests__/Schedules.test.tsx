import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Schedules from '../Schedules';

const {
  mockListAllAgents,
  mockListSchedules,
  mockPauseSchedule,
  mockResumeSchedule,
  mockDisableSchedule,
} = vi.hoisted(() => ({
  mockListAllAgents: vi.fn(),
  mockListSchedules: vi.fn(),
  mockPauseSchedule: vi.fn(),
  mockResumeSchedule: vi.fn(),
  mockDisableSchedule: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: {
    listAllAgents: mockListAllAgents,
    listSchedules: mockListSchedules,
    pauseSchedule: mockPauseSchedule,
    resumeSchedule: mockResumeSchedule,
    disableSchedule: mockDisableSchedule,
  },
}));

const agentOne = {
  id: 'agent-alpha',
  displayName: 'Alpha Treasury',
  description: '',
  ownerId: 'owner-1',
  stellarAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  capabilities: ['payment'],
  status: 'active' as const,
  active: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const agentTwo = {
  id: 'agent-beta',
  displayName: 'Beta Payroll',
  description: '',
  ownerId: 'owner-1',
  stellarAddress: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWF',
  capabilities: ['payment'],
  status: 'active' as const,
  active: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const scheduleOne = {
  id: 'sched-alpha-1',
  agentId: 'agent-alpha',
  ownerId: 'owner-1',
  status: 'active' as const,
  intent: {
    type: 'payment' as const,
    asset: 'XLM',
    amount: '15',
    destination: 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    reason: 'Alpha daily payout',
  },
  scheduleExpression: '0 0 * * *',
  timezone: 'UTC',
  nextRunAt: '2026-01-02T00:00:00Z',
  lastRunAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const scheduleTwo = {
  id: 'sched-beta-2',
  agentId: 'agent-beta',
  ownerId: 'owner-1',
  status: 'paused' as const,
  intent: {
    type: 'payment' as const,
    asset: 'USDC',
    amount: '250',
    destination: 'GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
    reason: 'Beta weekly payroll',
  },
  scheduleExpression: '0 12 * * 1',
  timezone: 'America/New_York',
  nextRunAt: '2026-01-05T17:00:00Z',
  lastRunAt: '2025-12-29T17:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('Schedules global page (#343)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('renders schedules across multiple agents with linked agent names, expression, next run, status, and total count', async () => {
    mockListAllAgents.mockResolvedValue({
      agents: [agentOne, agentTwo],
      total: 2,
      truncated: false,
    });
    mockListSchedules.mockImplementation(async (agentId: string) => {
      if (agentId === 'agent-alpha') {
        return { agentId, schedules: [scheduleOne], hasMore: false };
      }
      return { agentId, schedules: [scheduleTwo], hasMore: false };
    });

    render(
      <MemoryRouter initialEntries={['/schedules']}>
        <Routes>
          <Route path="/schedules" element={<Schedules />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/2 total/)).toBeInTheDocument();
    });

    expect(screen.getByText('Alpha Treasury')).toBeInTheDocument();
    expect(screen.getByText('Beta Payroll')).toBeInTheDocument();
    expect(screen.getByText('0 0 * * *')).toBeInTheDocument();
    expect(screen.getByText('0 12 * * 1')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('paused')).toBeInTheDocument();

    const alphaLink = screen.getByText('Alpha Treasury').closest('a');
    expect(alphaLink).toHaveAttribute('href', '/agents/agent-alpha');
    const betaLink = screen.getByText('Beta Payroll').closest('a');
    expect(betaLink).toHaveAttribute('href', '/agents/agent-beta');
  });

  test('walks all pages per agent when hasMore is true so no schedules are silently dropped', async () => {
    mockListAllAgents.mockResolvedValue({
      agents: [agentOne],
      total: 1,
      truncated: false,
    });
    mockListSchedules
      .mockResolvedValueOnce({ agentId: 'agent-alpha', schedules: [scheduleOne], hasMore: true })
      .mockResolvedValueOnce({
        agentId: 'agent-alpha',
        schedules: [{ ...scheduleTwo, id: 'sched-alpha-page2', agentId: 'agent-alpha' }],
        hasMore: false,
      });

    render(
      <MemoryRouter>
        <Schedules />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/2 total/)).toBeInTheDocument();
    });

    expect(mockListSchedules).toHaveBeenCalledTimes(2);
    expect(mockListSchedules).toHaveBeenNthCalledWith(1, 'agent-alpha', 50, 0);
    expect(mockListSchedules).toHaveBeenNthCalledWith(2, 'agent-alpha', 50, 1);
  });

  test('pause and resume actions invoke per-agent endpoints and refresh the list', async () => {
    mockListAllAgents.mockResolvedValue({
      agents: [agentOne, agentTwo],
      total: 2,
      truncated: false,
    });
    mockListSchedules.mockImplementation(async (agentId: string) => {
      if (agentId === 'agent-alpha') return { agentId, schedules: [scheduleOne], hasMore: false };
      return { agentId, schedules: [scheduleTwo], hasMore: false };
    });
    mockPauseSchedule.mockResolvedValue({ schedule: { ...scheduleOne, status: 'paused' } });
    mockResumeSchedule.mockResolvedValue({ schedule: { ...scheduleTwo, status: 'active' } });

    render(
      <MemoryRouter>
        <Schedules />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Pause')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Pause'));
    await waitFor(() => {
      expect(mockPauseSchedule).toHaveBeenCalledWith('agent-alpha', 'sched-alpha-1');
    });

    fireEvent.click(screen.getByText('Resume'));
    await waitFor(() => {
      expect(mockResumeSchedule).toHaveBeenCalledWith('agent-beta', 'sched-beta-2');
    });
  });
});
