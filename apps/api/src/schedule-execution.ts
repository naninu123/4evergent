import type { AgentIntent, PolicyDecision } from "@4evergent/shared";
import type { ScheduleRecord, ActivityStore, ApprovalStore } from "@4evergent/database";
import type { PipelineOutcome, PipelineExecuteInput } from "@4evergent/stellar";

export type { PipelineOutcome, PipelineExecuteInput };

/**
 * Result of a schedule execution. When the pipeline is not reached (e.g. source
 * account load failure), we synthesize a minimal rejected outcome.
 */
export type ScheduleExecutionResult = {
  status: string;
  message?: string;
  intent?: AgentIntent;
  policyDecision?: PolicyDecision | null;
  simulationResult?: unknown | null;
  txHash?: string | null;
  activityId?: string;
  approvalId?: string;
};

export interface ScheduleExecutionDeps {
  activityStore: ActivityStore;
  approvalStore: ApprovalStore;
  /** Resolve a StellarAccount-like object for the signer account. */
  getSourceAccount: () => Promise<{
    accountId: () => string;
    sequenceNumber: () => string;
    incrementSequenceNumber: () => void;
  }>;
  pipelineExecutor: (input: PipelineExecuteInput) => Promise<PipelineOutcome>;
  sequenceCoordinator: {
    runExclusive<T>(accountId: string, task: () => Promise<T>): Promise<T>;
  };
  sequenceAccountId: string;
  now?: () => Date;
}

/**
 * ScheduleExecutionService — runs a scheduled intent through the SAME pipeline
 * as manual intents. The scheduler only decides WHEN to run; this service
 * decides HOW (via the existing pipeline).
 */
export class ScheduleExecutionService {
  private now: () => Date;

  constructor(private deps: ScheduleExecutionDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async executeSchedule(schedule: ScheduleRecord): Promise<ScheduleExecutionResult> {
    const intent = schedule.intent;

    const execute = async (): Promise<ScheduleExecutionResult> => {
      let sourceAccount: PipelineExecuteInput["sourceAccount"];
      try {
        const raw = await this.deps.getSourceAccount();
        sourceAccount = {
          agentId: schedule.agentId,
          ownerId: schedule.ownerId,
          accountId: raw.accountId,
          sequenceNumber: raw.sequenceNumber,
          incrementSequenceNumber: raw.incrementSequenceNumber,
        };
      } catch (e: any) {
        return {
          status: "rejected",
          message: `Cannot load source account: ${e.message}`,
          intent,
          policyDecision: {
            result: "deny",
            reason: "source account load failed",
            rule: "schedule",
            intent,
          },
          simulationResult: null,
        };
      }

      const outcome = await this.deps.pipelineExecutor({ intent, sourceAccount });
      return outcome;
    };

    // Keep the account load inside the lock: it obtains the Horizon sequence
    // used to build and submit this transaction.
    return this.deps.sequenceCoordinator.runExclusive(this.deps.sequenceAccountId, execute);
  }
}
