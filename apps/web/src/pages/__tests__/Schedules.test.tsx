import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { test, expect, describe, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
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

const mockAgents = [
  {
    id: 'agent-1',
    ownerId: 'owner-1',
    displayName: 'Treasury Agent',
    description: 'Handles treasury payments',
    capabilities: ['payment'],
    stellarAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'agent-2',
    ownerId: 'owner-1',
    displayName: 'Payroll Agent',
    description: 'Disburses payroll',
    capabilities: ['payment'],
    stellarAddress: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

const mockSchedulesAgent1 = [
  {
    id: 'sched-1',
    agentId: 'agent-1',
    ownerId: 'owner-1',
    status: 'active',
    intent: {
      type: 'payment',
      asset: 'XLM',
      amount: '50',
      destination: 'GDEST111111111111111111111111111111111111111111111111111',
    },
    scheduleExpression: '0 * * * *',
    timezone: 'UTC',
    nextRunAt: '2026-02-01T12:00:00Z',
    lastRunAt: '2026-02-01T11:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

const mockSchedulesAgent2 = [
  {
    id: 'sched-2',
    agentId: 'agent-2',
    ownerId: 'owner-1',
    status: 'paused',
    intent: {
      type: 'payment',
      asset: 'USDC',
      amount: '1000',
      destination: 'GDEST222222222222222222222222222222222222222222222222222',
    },
    scheduleExpression: '0 0 * * 1',
    timezone: 'America/New_York',
    nextRunAt: '2026-02-02T00:00:00Z',
    lastRunAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'sched-3',
    agentId: 'agent-2',
    ownerId: 'owner-1',
    status: 'disabled',
    intent: {
      type: 'trustline',
      asset: 'USDC',
    },
    scheduleExpression: '0 0 1 * *',
    timezone: 'UTC',
    nextRunAt: '2026-03-01T00:00:00Z',
    lastRunAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

describe('Schedules page (/schedules)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('renders loading skeleton while loading schedules', () => {
    mockListAllAgents.mockReturnValue(new Promise(() => {}));
    render(
      <MemoryRouter>
        <Schedules />
      </MemoryRouter>
    );

    expect(screen.getByText('Loading schedules...')).toBeInTheDocument();
  });

  test('renders error state and handles retry', async () => {
    mockListAllAgents.mockRejectedValueOnce(new Error('Network error fetching agents'));

    render(
      <MemoryRouter>
        <Schedules />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Failed to load schedules')).toBeInTheDocument();
      expect(screen.getByText('Network error fetching agents')).toBeInTheDocument();
    });

    // Mock successful recovery for Retry
    mockListAllAgents.mockResolvedValueOnce({
      agents: [],
      total: 0,
      truncated: false,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(screen.getByText('No schedules found')).toBeInTheDocument();
    });
  });

  test('renders empty state when there are no schedules across all agents', async () => {
    mockListAllAgents.mockResolvedValue({
      agents: mockAgents,
      total: 2,
      truncated: false,
    });
    mockListSchedules.mockResolvedValue({ schedules: [], hasMore: false });

    render(
      <MemoryRouter>
        <Schedules />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('No schedules found')).toBeInTheDocument();
      expect(screen.getByText(/0 schedules/i)).toBeInTheDocument();
    });
  });

  test('shows schedules belonging to two or more different agents in one list', async () => {
    mockListAllAgents.mockResolvedValue({
      agents: mockAgents,
      total: 2,
      truncated: false,
    });
    mockListSchedules.mockImplementation((agentId: string) => {
      if (agentId === 'agent-1') {
        return Promise.resolve({ schedules: mockSchedulesAgent1, hasMore: false });
      }
      if (agentId === 'agent-2') {
        return Promise.resolve({ schedules: mockSchedulesAgent2, hasMore: false });
      }
      return Promise.resolve({ schedules: [], hasMore: false });
    });

    render(
      <MemoryRouter>
        <Schedules />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/3 schedules/i)).toBeInTheDocument();
    });

    // Both agent names should appear
    expect(screen.getByText('Treasury Agent')).toBeInTheDocument();
    expect(screen.getAllByText('Payroll Agent')).toHaveLength(2);

    // Expressions and statuses should appear
    expect(screen.getByText('0 * * * *')).toBeInTheDocument();
    expect(screen.getByText('0 0 * * 1')).toBeInTheDocument();
    expect(screen.getByText('0 0 1 * *')).toBeInTheDocument();

    // Reusing status vocabulary
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('paused')).toBeInTheDocument();
    expect(screen.getByText('disabled')).toBeInTheDocument();

    // Check links to owning agent and schedule management UI
    const agentLinks = screen.getAllByRole('link', { name: 'Treasury Agent' });
    expect(agentLinks[0]).toHaveAttribute('href', '/agents/agent-1');

    const manageLinks = screen.getAllByRole('link', { name: 'Manage' });
    expect(manageLinks).toHaveLength(3);
    expect(manageLinks[0]).toHaveAttribute('href', '/agents/agent-1#schedules');
    expect(manageLinks[1]).toHaveAttribute('href', '/agents/agent-2#schedules');
  });

  test('surfaces truncation notice when agents are truncated at pagination limit', async () => {
    mockListAllAgents.mockResolvedValue({
      agents: mockAgents,
      total: 250,
      truncated: true,
    });
    mockListSchedules.mockResolvedValue({ schedules: [], hasMore: false });

    render(
      <MemoryRouter>
        <Schedules />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(
        screen.getByText(/Showing schedules from 2 of 250 agents/i)
      ).toBeInTheDocument();
    });
  });

  test('surfaces truncation notice when an agent has more than 50 schedules', async () => {
    mockListAllAgents.mockResolvedValue({
      agents: [mockAgents[0]],
      total: 1,
      truncated: false,
    });
    mockListSchedules.mockResolvedValue({
      schedules: mockSchedulesAgent1,
      hasMore: true,
    });

    render(
      <MemoryRouter>
        <Schedules />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(
        screen.getByText(/Some agents \(Treasury Agent\) have more schedules than shown/i)
      ).toBeInTheDocument();
    });
  });

  test('supports pause and disable actions on active schedule', async () => {
    mockListAllAgents.mockResolvedValue({
      agents: [mockAgents[0]],
      total: 1,
      truncated: false,
    });
    mockListSchedules.mockResolvedValue({ schedules: mockSchedulesAgent1, hasMore: false });
    mockPauseSchedule.mockResolvedValue({});
    mockDisableSchedule.mockResolvedValue({});

    render(
      <MemoryRouter>
        <Schedules />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => {
      expect(mockPauseSchedule).toHaveBeenCalledWith('agent-1', 'sched-1');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => {
      expect(mockDisableSchedule).toHaveBeenCalledWith('agent-1', 'sched-1');
    });
  });

  test('supports resume and disable actions on paused schedule', async () => {
    mockListAllAgents.mockResolvedValue({
      agents: [mockAgents[1]],
      total: 1,
      truncated: false,
    });
    mockListSchedules.mockResolvedValue({ schedules: [mockSchedulesAgent2[0]], hasMore: false });
    mockResumeSchedule.mockResolvedValue({});

    render(
      <MemoryRouter>
        <Schedules />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => {
      expect(mockResumeSchedule).toHaveBeenCalledWith('agent-2', 'sched-2');
    });
  });

  test('displays action error when pause/resume fails', async () => {
    mockListAllAgents.mockResolvedValue({
      agents: [mockAgents[0]],
      total: 1,
      truncated: false,
    });
    mockListSchedules.mockResolvedValue({ schedules: mockSchedulesAgent1, hasMore: false });
    mockPauseSchedule.mockRejectedValue(new Error('Failed to pause schedule: invalid state'));

    render(
      <MemoryRouter>
        <Schedules />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));

    await waitFor(() => {
      expect(
        screen.getByText('Failed to pause schedule: invalid state')
      ).toBeInTheDocument();
    });
  });
});
