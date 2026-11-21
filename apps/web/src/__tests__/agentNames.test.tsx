import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { buildAgentNameMap, resolveAgentName } from '../agentNames';
import { AgentName } from '../components';

describe('agentNames helpers', () => {
  it('buildAgentNameMap maps agent IDs to display names and skips blank names', () => {
    const map = buildAgentNameMap([
      { id: 'agent-1', displayName: 'Treasury' },
      { id: 'agent-2', displayName: 'Payroll' },
      { id: 'agent-3', displayName: '   ' },
    ]);

    expect(map).toEqual({
      'agent-1': 'Treasury',
      'agent-2': 'Payroll',
    });
  });

  it('resolveAgentName returns display name for known ID and full raw ID for unknown ID', () => {
    const map = { 'agent-1': 'Treasury' };
    expect(resolveAgentName('agent-1', map)).toBe('Treasury');
    expect(resolveAgentName('agent-unknown-1234567890', map)).toBe('agent-unknown-1234567890');
  });
});

describe('AgentName component', () => {
  it('renders display name with raw ID in title for known agent', () => {
    render(<AgentName agentId="agent-1" agentNames={{ 'agent-1': 'Treasury' }} />);
    const el = screen.getByText('Treasury');
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute('title', 'agent-1');
  });

  it('renders full raw ID fallback for unknown or deleted agent', () => {
    render(<AgentName agentId="agent-deleted-1234567890" agentNames={{ 'agent-1': 'Treasury' }} />);
    const el = screen.getByText('agent-deleted-1234567890');
    expect(el).toBeInTheDocument();
    expect(el.tagName).toBe('CODE');
    expect(el).toHaveAttribute('title', 'agent-deleted-1234567890');
  });

  it('renders display name and raw ID when showId is true', () => {
    render(<AgentName agentId="agent-1" agentNames={{ 'agent-1': 'Treasury' }} showId />);
    expect(screen.getByText('Treasury')).toBeInTheDocument();
    expect(screen.getByText('agent-1')).toBeInTheDocument();
  });
});
