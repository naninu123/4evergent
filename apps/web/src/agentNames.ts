import { useEffect, useState } from 'react';
import { api } from './api';
import type { AgentRecord } from './types';

export type AgentNameMap = Record<string, string>;

/**
 * Build a lookup map of agent ID -> displayName from a list of agents.
 */
export function buildAgentNameMap(
  agents: ReadonlyArray<Pick<AgentRecord, 'id' | 'displayName'>>,
): AgentNameMap {
  const map: AgentNameMap = {};
  for (const agent of agents) {
    if (agent.id && agent.displayName?.trim()) {
      map[agent.id] = agent.displayName;
    }
  }
  return map;
}

/**
 * Resolve an agent ID to its display name, falling back to the full raw ID
 * when the agent is unknown or deleted.
 */
export function resolveAgentName(agentId: string, agentNames: AgentNameMap): string {
  return agentNames[agentId] || agentId;
}

/**
 * Fetch the owner's agents once on mount and return an ID -> displayName map.
 * Fails silently to an empty map so operational lists still render with raw IDs.
 */
export function useAgentNames(): AgentNameMap {
  const [agentNames, setAgentNames] = useState<AgentNameMap>({});

  useEffect(() => {
    let cancelled = false;
    const fetchAgents =
      typeof api.listAllAgents === 'function'
        ? () => api.listAllAgents()
        : typeof api.listAgents === 'function'
          ? () => api.listAgents()
          : null;

    if (!fetchAgents) return;

    Promise.resolve(fetchAgents())
      .then((res) => {
        if (!cancelled && res && Array.isArray(res.agents)) {
          setAgentNames(buildAgentNameMap(res.agents));
        }
      })
      .catch(() => {
        // Leave map empty; callers fall back to raw agent IDs.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return agentNames;
}
