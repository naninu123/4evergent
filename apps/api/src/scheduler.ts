import type { ScheduleRecord } from "@4evergent/database";
import type { SchedulerConfig, ExecutionContext } from "./scheduler-types.js";
import type { ScheduleExecutionResult } from "./schedule-execution.js";

type AgentInfo = { id: string; status: string; ownerId: string };

export interface ScheduleStoreLike {
  get(id: string): Promise<ScheduleRecord | null>;
  listDue(before: string, limit?: number): Promise<ScheduleRecord[]>;
  update(id: string, patch: Partial<ScheduleRecord>): Promise<ScheduleRecord | null>;
  delete(id: string): Promise<boolean>;
}

export class AgentScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private clock: () => Date;
  private intervalMs: number;

  constructor(
    private scheduleStore: ScheduleStoreLike,
    private agentStore: { get(id: string): Promise<AgentInfo | null> },
    private executeCallback: (schedule: ScheduleRecord, ctx: ExecutionContext) => Promise<ScheduleExecutionResult>,
    config: SchedulerConfig = {}
  ) {
    this.clock = config.clock ?? (() => new Date());
    this.intervalMs = config.intervalMs ?? 60_000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  async runDue(nowIso?: string): Promise<number> {
    const now = nowIso ?? this.clock().toISOString();
    const due = await this.scheduleStore.listDue(now, 100);
    let executed = 0;

    for (const schedule of due) {
      if (schedule.status !== "active") continue;

      const agent = await this.agentStore.get(schedule.agentId);
      if (!agent || agent.status !== "active") continue;

      // Duplicate trigger guard: skip if already ran at this exact timestamp
      if (schedule.lastRunAt && schedule.lastRunAt === now) continue;

      // Interrupted-run guard: an attempted marker that was not cleared
      // means a run was started but never completed its bookkeeping.
      // Treat it as already-attempted rather than repeating it.
      if (schedule.attemptedAt) {
        await this.reconcileInterrupted(schedule, now);
        continue;
      }

      try {
        await this.runSchedule(schedule, now);
        executed++;
      } catch (err) {
        console.error(`[scheduler] schedule ${schedule.id} failed:`, err);
      }
    }

    return executed;
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      await this.runDue();
    } catch (err) {
      console.error("[scheduler] tick error:", err);
    }

    if (!this.running) return;

    this.timer = setTimeout(() => {
      void this.tick();
    }, this.intervalMs);
  }

  /**
   * Advances a stale attempted schedule to its next valid occurrence and
   * clears the attemptedAt marker. The interrupted run is treated as
   * already-attempted: it is not repeated, and the schedule resumes on
   * its normal cadence. This is idompotent — a record with no marker is
   * untouched.
   */
  async reconcileInterrupted(schedule: ScheduleRecord, nowIso?: string): Promise<boolean> {
    const now = nowIso ?? this.clock().toISOString();
    // Re-fetch for idempotency: another caller may have already cleared it.
    const current = await this.scheduleStore.get(schedule.id);
    if (!current || !current.attemptedAt) return false;

    const { validateScheduleExpression } = await import("@4evergent/database");
    const result = validateScheduleExpression(current.scheduleExpression, current.timezone);

    await this.scheduleStore.update(current.id, {
      attemptedAt: null,
      lastRunAt: current.attemptedAt,
      ...(result.valid ? { nextRunAt: result.nextRunAt ?? current.nextRunAt } : {}),
    });
    return true;
  }

  private async runSchedule(schedule: ScheduleRecord, nowIso: string): Promise<void> {
    // Mark the run as attempted BEFORE invoking the callback. If the
    // process dies between here and the bookkeeping write, the marker
    // survives and the next tick (or startup reconciliation) treats the
    // run as already-attempted instead of repeating it.
    await this.scheduleStore.update(schedule.id, { attemptedAt: nowIso });

    try {
      await this.executeCallback(schedule, { executedAt: nowIso });

      const { validateScheduleExpression } = await import("$4evergent/database");
      const result = validateScheduleExpression(schedule.scheduleExpression, schedule.timezone);

      await this.scheduleStore.update(schedule.id, {
        lastRunAt: nowIso,
        attemptedAt: null,
        ...(result.valid ? { nextRunAt: result.nextRunAt ?? schedule.nextRunAt } : {}),
      });
    } catch (err) {
      await this.scheduleStore.update(schedule.id, { lastRunAt: nowIso, attemptedAt: null });
      throw err;
    }
  }
}
