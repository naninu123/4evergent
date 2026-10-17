import type { Agent } from "@4evergent/shared";

export const MAX_DISPLAY_NAME_LEN = 100;
export const MAX_DESCRIPTION_LEN = 500;
export const MAX_CAPABILITIES = 32;
export const MAX_CAPABILITY_LEN = 32;

export interface UpdateAgentInput {
  displayName?: string;
  description?: string;
  capabilities?: string[];
}

export interface CreateAgentInput {
  id?: string;
  displayName: string;
  description?: string;
  capabilities?: string[];
  ownerId: string;
  stellarAddress?: string;
  status?: "active" | "paused" | "disabled";
}

export interface AgentStore {
  create(input: CreateAgentInput): Promise<Agent>;
  get(id: string): Promise<Agent | null>;
  getForOwner(id: string, ownerId: string): Promise<Agent | null>;
  listByOwner(ownerId: string, limit?: number): Promise<Agent[]>;
  update(id: string, patch: UpdateAgentInput): Promise<Agent | null>;
  delete(id: string): Promise<boolean>;
}
