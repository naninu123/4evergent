import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
});
