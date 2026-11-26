import type { AgentIntent, ScheduleStatus } from "@4evergent/shared";

export interface ScheduleRecord {
  id: string;
  agentId: string;
  ownerId: string;
  status: ScheduleStatus;
  intent: AgentIntent;
  scheduleExpression: string;
  timezone: string;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStartedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleStore {
  create(record: ScheduleRecord): Promise<ScheduleRecord>;
  get(id: string): Promise<ScheduleRecord | null>;
  /** List schedules for an agent. `status` filters at the store level so that
   *  `offset`/`limit` page over the FILTERED set, not the unfiltered one. */
  listByAgent(agentId: string, limit?: number, offset?: number, status?: string): Promise<ScheduleRecord[]>;
  listByOwner(ownerId: string, limit?: number, offset?: number): Promise<ScheduleRecord[]>;
  listDue(before: string, limit?: number): Promise<ScheduleRecord[]>;
  listInterrupted(limit?: number, offset?: number): Promise<ScheduleRecord[]>;
  update(id: string, patch: Partial<ScheduleRecord>): Promise<ScheduleRecord | null>;
  updateIfLastStartedAt(
    id: string,
    expectedLastStartedAt: string | null,
    patch: Partial<ScheduleRecord>
  ): Promise<ScheduleRecord | null>;
  delete(id: string): Promise<boolean>;
  close?(): void;
}
