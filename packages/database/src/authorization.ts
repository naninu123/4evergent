import type { RequestContext, AuthorizationService } from '@4evergent/shared';
import type { ActivityStore, ApprovalStore, ScheduleStore, AgentStore } from './index.js';

export interface AuthorizationContext {
  activityStore: ActivityStore;
  approvalStore: ApprovalStore;
  scheduleStore: ScheduleStore;
  agents: Map<string, { id: string; ownerId: string }>;
  /**
   * Optional agent store for fallback lookups.
   *
   * PHASE 28I: When an agent is not found in the in-memory map (e.g., after
   * server restart with persistent storage), the service falls back to
   * looking up the agent from the store. This prevents authorization bypass
   * for agents created in previous sessions.
   */
  agentStore?: AgentStore;
}

export class ResourceAuthorizationService implements AuthorizationService {
  constructor(private ctx: AuthorizationContext) {}

  async canAccessAgent(ctx: RequestContext, agentId: string): Promise<boolean> {
    const agent = await this.resolveAgent(agentId);
    return agent?.ownerId === ctx.ownerId;
  }

  async canSubmitIntent(ctx: RequestContext, agentId: string): Promise<boolean> {
    return this.canAccessAgent(ctx, agentId);
  }

  /**
   * Activity access, optionally bound to a path agent (issue #385).
   *
   * Nested single-resource endpoints (/agents/:id/activity/:activityId) name an
   * agent in the path. When `agentId` is provided, access is only granted if
   * the activity's agentId equals it — a resource must never be served under
   * an agent it does not belong to. Owner scoping is still enforced through
   * the agent's ownerId, so cross-owner behaviour is unchanged.
   */
  async canAccessActivity(ctx: RequestContext, activityId: string, agentId?: string): Promise<boolean> {
    const activity = await this.ctx.activityStore.get(activityId);
    if (!activity) return false;
    if (agentId !== undefined && activity.agentId !== agentId) return false;
    return this.canAccessAgent(ctx, activity.agentId);
  }

  async canAccessApproval(ctx: RequestContext, approvalId: string): Promise<boolean> {
    const approval = await this.ctx.approvalStore.get(approvalId);
    if (!approval) return false;
    return this.canAccessAgent(ctx, approval.agentId);
  }

  async canApprove(ctx: RequestContext, approvalId: string): Promise<boolean> {
    return this.canAccessApproval(ctx, approvalId);
  }

  async canReject(ctx: RequestContext, approvalId: string): Promise<boolean> {
    return this.canAccessApproval(ctx, approvalId);
  }

  async canChangeAgentStatus(ctx: RequestContext, agentId: string): Promise<boolean> {
    return this.canAccessAgent(ctx, agentId);
  }

  /**
   * Schedule access, optionally bound to a path agent (issue #385).
   *
   * Nested single-resource endpoints (/agents/:id/schedules/:scheduleId) name
   * an agent in the path. When `agentId` is provided, access is only granted
   * if the schedule's agentId equals it. Owner scoping (schedule.ownerId) is
   * unchanged, so cross-owner behaviour is identical to before.
   */
  async canAccessSchedule(ctx: RequestContext, scheduleId: string, agentId?: string): Promise<boolean> {
    const schedule = await this.ctx.scheduleStore.get(scheduleId);
    if (!schedule) return false;
    if (agentId !== undefined && schedule.agentId !== agentId) return false;
    return schedule.ownerId === ctx.ownerId;
  }

  async canCreateSchedule(ctx: RequestContext, agentId: string): Promise<boolean> {
    return this.canAccessAgent(ctx, agentId);
  }

  async canUpdateSchedule(ctx: RequestContext, scheduleId: string, agentId?: string): Promise<boolean> {
    return this.canAccessSchedule(ctx, scheduleId, agentId);
  }

  async canDeleteSchedule(ctx: RequestContext, scheduleId: string, agentId?: string): Promise<boolean> {
    return this.canAccessSchedule(ctx, scheduleId, agentId);
  }

  async canPauseSchedule(ctx: RequestContext, scheduleId: string, agentId?: string): Promise<boolean> {
    return this.canAccessSchedule(ctx, scheduleId, agentId);
  }

  async canResumeSchedule(ctx: RequestContext, scheduleId: string, agentId?: string): Promise<boolean> {
    return this.canAccessSchedule(ctx, scheduleId, agentId);
  }

  async canDisableSchedule(ctx: RequestContext, scheduleId: string, agentId?: string): Promise<boolean> {
    return this.canAccessSchedule(ctx, scheduleId, agentId);
  }

  /**
   * Resolve agent by ID with fallback to agent store.
   *
   * First checks the in-memory map (fast path). If not found, falls back
   * to the configured agent store (if any) for persistent agents.
   */
  private async resolveAgent(agentId: string): Promise<{ id: string; ownerId: string } | null> {
    const cached = this.ctx.agents.get(agentId);
    if (cached) return cached;

    if (this.ctx.agentStore) {
      const dbAgent = await this.ctx.agentStore.get(agentId);
      if (dbAgent) {
        const entry = { id: dbAgent.id, ownerId: dbAgent.ownerId };
        // Cache for subsequent lookups
        this.ctx.agents.set(agentId, entry);
        return entry;
      }
    }

    return null;
  }
}
