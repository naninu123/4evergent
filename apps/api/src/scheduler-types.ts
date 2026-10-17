export interface SchedulerConfig {
  intervalMs?: number;
  clock?: () => Date;
}

export interface ExecutionContext {
  executedAt: string;
}

export interface ScheduleRunAttempt {
  scheduleId: string;
  attemptedAt: string;
}
