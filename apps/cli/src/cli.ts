#!/usr/bin/env node
/**
 * 4evergent Operator CLI — HTTP client for the 4evergent API.
 *
 * This is an operator client only — it does NOT sign, build, or submit
 * Stellar transactions directly. All transaction work is delegated to the
 * API server over HTTP.
 *
 * Configuration:
 *   FOREGENT_API_URL  — API base URL (default: http://127.0.0.1:3000)
 *   FOREGENT_API_KEY  — Bearer API key (production auth mode)
 *   FOREGENT_API_TIMEOUT_MS — Per-request timeout in ms (default: 5000)
 */

import { parseArgs } from "node:util";
import { exit } from "node:process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { APPROVAL_LIST_USAGE, COMMAND_TREE, COMMANDS_HELP, buildCommandTree, dispatchCommand } from "./commands.js";
import { generateCompletion } from "./completion.js";

// The build replaces this lookup with the package version for a standalone CLI.
const VERSION: string = createRequire(import.meta.url)("../package.json").version;

const API_URL = process.env.FOREGENT_API_URL ?? "http://127.0.0.1:3000";
const API_KEY = process.env.FOREGENT_API_KEY;

// Every request is bounded by a finite deadline so an unresponsive server can
// never hang the caller's shell. Override per invocation with
// FOREGENT_API_TIMEOUT_MS (positive integer, milliseconds).
const DEFAULT_API_TIMEOUT_MS = 5000;
// Non-zero exit reserved for the timeout failure mode, so scripts can tell
// "server too slow" (3) apart from "server down" and "server said no" (1).
const EXIT_TIMEOUT = 3;
// AbortSignal.timeout() rejects delays above this bound.
const MAX_API_TIMEOUT_MS = 2 ** 31 - 1;

function resolveApiTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_API_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_API_TIMEOUT_MS) {
    console.error(
      `Ignoring invalid FOREGENT_API_TIMEOUT_MS='${raw}' ` +
        `(expected a positive integer <= ${MAX_API_TIMEOUT_MS}); using default ${DEFAULT_API_TIMEOUT_MS}ms.`
    );
    return DEFAULT_API_TIMEOUT_MS;
  }
  return parsed;
}

const API_TIMEOUT_MS = resolveApiTimeoutMs(process.env.FOREGENT_API_TIMEOUT_MS);

// Set when a request fails because the deadline elapsed. The exit code is
// mapped to EXIT_TIMEOUT at the single exit point, so every command inherits
// the documented timeout exit code without duplicating it in each catch block.
let requestTimedOut = false;

function formatApiErrorDetails(details: unknown): string {
  if (details === undefined || details === null) return "";
  if (typeof details === "string") {
    const trimmed = details.trim();
    return trimmed ? `\n  ${trimmed}` : "";
  }
  if (Array.isArray(details)) {
    const lines = details
      .filter((item): item is string | number | boolean =>
        typeof item === "string" || typeof item === "number" || typeof item === "boolean"
      )
      .map((item) => String(item).trim())
      .filter((line) => line.length > 0);
    return lines.length > 0 ? lines.map((line) => `\n  - ${line}`).join("") : "";
  }
  if (typeof details === "object") {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
      if (value === undefined || value === null) continue;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        lines.push(`\n  ${key}: ${value}`);
      } else if (Array.isArray(value)) {
        const scalars = value
          .filter((item): item is string | number | boolean =>
            typeof item === "string" || typeof item === "number" || typeof item === "boolean"
          )
          .map((item) => String(item).trim())
          .filter((item) => item.length > 0);
        if (scalars.length > 0) {
          lines.push(`\n  ${key}: ${scalars.join(", ")}`);
        }
      }
    }
    return lines.join("");
  }
  return "";
}

class ApiError extends Error {
  public readonly code?: string;
  public readonly details?: unknown;

  constructor(public status: number, message: string, code?: string, details?: unknown) {
    // status 0 means "no HTTP response" (connection failure or timeout);
    // prefixing it with "HTTP 0:" would be misleading.
    const normalizedCode = typeof code === "string" && code.trim() !== "" ? code.trim() : undefined;
    const header =
      status === 0
        ? message
        : normalizedCode
          ? `HTTP ${status} [${normalizedCode}]: ${message}`
          : `HTTP ${status}: ${message}`;
    const formattedDetails = status === 0 ? "" : formatApiErrorDetails(details);
    super(`${header}${formattedDetails}`);
    this.name = "ApiError";
    this.code = normalizedCode;
    this.details = details;
  }
}

class TimeoutError extends ApiError {
  constructor(message: string) {
    super(0, message);
    this.name = "TimeoutError";
  }
}

interface ApiResponse {
  status: number;
  body: any;
}

async function request(path: string, init: RequestInit = {}): Promise<ApiResponse> {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> ?? {}),
  };

  if (API_KEY) {
    headers["Authorization"] = `Bearer ${API_KEY}`;
  }

  let res: Response;
  const signal = AbortSignal.timeout(API_TIMEOUT_MS);
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers,
      // Bounds this HTTP request (headers and body). Once the response has
      // been received, no deadline applies to printing or further processing.
      signal,
    });
  } catch (err: any) {
    // Our signal aborts only on timeout. Checking it as well as the error name
    // keeps the classification correct when fetch wraps the abort reason
    // (e.g. an abort raised during the connect phase).
    if (signal.aborted || err?.name === "TimeoutError" || err?.name === "AbortError") {
      requestTimedOut = true;
      throw new TimeoutError(
        `Request timed out after ${API_TIMEOUT_MS}ms: ${init.method ?? "GET"} ${API_URL}${path}. ` +
          `The server accepted the connection but did not respond in time. ` +
          `Set FOREGENT_API_TIMEOUT_MS to change the deadline; the CLI does not retry automatically.`
      );
    }
    if (err.cause?.code === "ECONNREFUSED" || err.cause?.code === "ENOTFOUND" || err.code === "ECONNREFUSED") {
      throw new ApiError(0, `Cannot connect to API at ${API_URL}. Is the server running?`);
    }
    throw new ApiError(0, `Network error: ${err.message ?? "unknown"}`);
  }

  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }

  if (!res.ok) {
    const msg = body?.error ?? body?.message ?? `Request failed`;
    const code = typeof body?.code === "string" ? body.code : undefined;
    throw new ApiError(res.status, msg, code, body?.details);
  }

  return { status: res.status, body };
}

// --- Formatters ---

function formatAgent(agent: any) {
  return `Agent:
  ID:           ${agent.id}
  Name:         ${agent.displayName}
  Description:  ${agent.description ?? "-"}
  Owner:        ${agent.ownerId ?? "-"}
  Stellar:      ${agent.stellarAddress ?? "-"}
  Status:       ${agent.status ?? (agent.active ? "active" : "paused")}
  Created:      ${agent.createdAt ?? "-"}
`;
}

function formatExecution(e: any) {
  return `Execution:
  ID:            ${e.id}
  Agent:         ${e.agentId}
  Status:        ${e.status}
  Amount:        ${e.intent?.amount ?? "-"} ${(e.intent?.assetDetails as any)?.code ?? e.intent?.asset ?? ""}
  TxHash:        ${e.txHash ?? "-"}
  Attempt:       ${e.attempt ?? 0}
  Error:         ${e.error ?? "-"}
  Started:       ${e.startedAt ?? "-"}
  Completed:     ${e.completedAt ?? "-"}
  Created:       ${e.createdAt ?? "-"}
`;
}

function _formatApproval(a: any) {
  const intent = a.intent ?? {};
  const rule = a.policyDecision?.rule ?? a.policyRule ?? a.rule ?? "-";
  return `Approval:
  ID:            ${a.id}
  Status:        ${a.status}
  Agent:         ${a.agentId ?? "-"}
  Intent Type:   ${intent.type ?? "-"}
  Amount:        ${intent.amount ?? "-"} ${intent.asset ?? intent.assetCode ?? ""}
  Destination:   ${intent.destination ?? intent.contractId ?? "-"}
  Policy Rule:   ${rule}
  Requester:     ${a.requesterId ?? a.requestedBy ?? "-"}
  Approver:      ${a.approverId ?? a.approvedBy ?? "-"}
  Expires:       ${a.expiresAt ?? "-"}
  Activity:      ${a.activityId ?? "-"}
  Created:       ${a.createdAt ?? "-"}
`;
}

// --- Commands ---

async function cmdHealth() {
  try {
    const { body } = await request("/health");
    console.log(`API Status: ${body.status === "ok" ? "healthy" : "unhealthy"}`);
    console.log(`Signer: ${body.signerAccountId?.slice(0, 12)}...`);
    return 0;
  } catch (err: any) {
    console.error(`Health check failed: ${err.message}`);
    return 1;
  }
}

// GET /agents clamps limit to 1-200 and defaults to 200, so the CLI validates
// the same range and omits the parameter entirely when the flag is absent.
const AGENT_LIST_MAX_LIMIT = 200;
const AGENT_LIST_USAGE =
  "Usage: 4evergent agent list [--capability <capability>] [--limit <n>]";

interface AgentListOptions {
  capability?: string;
  limit?: number;
}

/** Parses agent list flags, returning an error message for usage errors. */
function parseAgentListArgs(args: string[]): AgentListOptions | string {
  const options: AgentListOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--capability") {
      const value = args[++i];
      if (value === undefined || value === "") {
        return `--capability requires a value.\n${AGENT_LIST_USAGE}`;
      }
      // Passed through unchanged: the API matches capabilities exactly and
      // case-sensitively, so the CLI must not normalize the value.
      options.capability = value;
    } else if (arg === "--limit") {
      const raw = args[++i];
      const parsed = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > AGENT_LIST_MAX_LIMIT) {
        return `Invalid --limit '${raw ?? ""}': expected an integer between 1 and ${AGENT_LIST_MAX_LIMIT}.\n${AGENT_LIST_USAGE}`;
      }
      options.limit = parsed;
    } else {
      return `Unknown argument: ${arg}\n${AGENT_LIST_USAGE}`;
    }
  }

  return options;
}

async function cmdAgentList(args: string[] = []) {
  const parsed = parseAgentListArgs(args);
  if (typeof parsed === "string") {
    console.error(parsed);
    return 1;
  }

  const query = new URLSearchParams();
  if (parsed.capability !== undefined) query.set("capability", parsed.capability);
  if (parsed.limit !== undefined) query.set("limit", String(parsed.limit));
  const qs = query.toString();

  try {
    const { body } = await request(`/agents${qs ? `?${qs}` : ""}`);
    if (!body.agents || body.agents.length === 0) {
      console.log("No agents found.");
      return 0;
    }
    for (const a of body.agents) {
      console.log(`${a.id}\t${a.displayName}\t${a.status ?? (a.active ? "active" : "paused")}`);
    }
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

async function cmdAgentGet(agentId: string) {
  if (!agentId) {
    console.error("Usage: 4evergent agent get <id>");
    return 1;
  }
  try {
    const { body } = await request(`/agents/${encodeURIComponent(agentId)}`);
    console.log(formatAgent(body));
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

interface DestructiveConfirmationOptions {
  force: boolean;
  isTTY?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

async function confirmDestructiveAction(
  target: string,
  consequence: string,
  options: DestructiveConfirmationOptions
): Promise<boolean> {
  if (options.force) return true;

  if (!(options.isTTY ?? Boolean(process.stdin.isTTY))) {
    console.error("Refusing destructive action: stdin is not a TTY. Rerun with --force or --yes to proceed.");
    return false;
  }

  const rl = createInterface({
    input: options.input ?? process.stdin,
    output: options.output ?? process.stderr,
  });
  const confirmed = await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (answer: boolean) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(answer);
    };

    rl.once("close", () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    });
    rl.once("SIGINT", () => finish(false));
    rl.question(
      `${consequence}\n  Target: ${target}\nThis action cannot be undone. Continue? [y/N] `,
      (answer) => finish(/^(y|yes)$/i.test(answer.trim()))
    );
  });

  return confirmed;
}

async function cmdAgentStatus(agentId: string, status: "active" | "paused" | "disabled", force = false) {
  if (!agentId) {
    console.error(
      status === "disabled"
        ? "Usage: 4evergent agent disable <id> [--force|--yes]"
        : "Usage: 4evergent agent <pause|resume> <id>"
    );
    return 1;
  }
  try {
    if (status === "disabled") {
      if (!force && !process.stdin.isTTY) {
        console.error("Refusing destructive action: stdin is not a TTY. Rerun with --force or --yes to proceed.");
        return 1;
      }
      if (!force) {
        const { body: agent } = await request(`/agents/${encodeURIComponent(agentId)}`);
        const target = `${agent.displayName ?? "(unnamed agent)"} (ID: ${agent.id ?? agentId})`;
        const confirmed = await confirmDestructiveAction(target, "Disable this agent permanently?", { force });
        if (!confirmed) {
          console.error("Aborted; no changes made.");
          return 1;
        }
      }
    }

    const { body } = await request(`/agents/${encodeURIComponent(agentId)}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    console.log(`Agent ${body.id} status: ${body.status}`);
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

const approvalStatuses = ["pending_approval", "approved", "rejected", "expired", "executing", "submitted", "confirmed", "failed"];

async function cmdApprovalList(args: string[]) {
  const params = new URLSearchParams();
  try {
    const { values, positionals } = parseArgs({
      args,
      options: { status: { type: "string" }, limit: { type: "string" } },
      allowPositionals: true,
    });
    if (values.status !== undefined) {
      if (!approvalStatuses.includes(values.status)) {
        throw new Error(`status must be one of: ${approvalStatuses.join(", ")}`);
      }
      params.set("status", values.status);
    }
    if (positionals.length > 1 || (positionals.length && values.limit !== undefined)) {
      throw new Error("Specify the limit once, either as --limit or as a positional argument.");
    }
    const limit = values.limit ?? positionals[0];
    if (limit !== undefined) {
      if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 200) {
        throw new Error("limit must be an integer between 1 and 200");
      }
      params.set("limit", String(Number(limit)));
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    console.error(APPROVAL_LIST_USAGE);
    return 1;
  }
  try {
    const { body } = await request(params.size ? `/approvals?${params}` : "/approvals");
    if (!body.approvals || body.approvals.length === 0) {
      console.log("No approvals found.");
      return 0;
    }
    console.log(`ID\t\t\tAgent\t\t\tStatus\t\t\tCreated`);
    for (const a of body.approvals) {
      console.log(`${a.id.slice(0, 18)}\t${a.agentId.slice(0, 14)}\t\t${a.status}\t\t${new Date(a.createdAt).toLocaleString()}`);
    }
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

async function cmdApprovalAction(approvalId: string, action: "approve" | "reject") {
  if (!approvalId) {
    console.error(`Usage: 4evergent approval ${action} <id>`);
    return 1;
  }
  try {
    const { body } = await request(`/approvals/${encodeURIComponent(approvalId)}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    console.log(`Approval ${body.status}: agent=${body.agentId} activity=${body.activityId}`);
    if (body.message) console.log(`  ${body.message}`);
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

async function cmdExecutionList(limit?: string) {
  const n = Number(limit || "100");
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    console.error("Usage: 4evergent execution list [limit]");
    console.error("limit must be an integer between 1 and 100");
    return 1;
  }
  try {
    const { body } = await request(`/executions?limit=${n}`);
    const all: any[] = body.executions ?? [];
    if (all.length === 0) {
      console.log("No executions found.");
      return 0;
    }
    // Global endpoint already returns owner-scoped records sorted by the store
    console.log(`ID\t\tAgent\t\tStatus\t\tTxHash\t\t\tAttempt\tCreated`);
    for (const e of all) {
      const txh = e.txHash ? e.txHash.slice(0, 16) + "…" : "-";
      console.log(`${e.id.slice(0, 14)}\t${e.agentId.slice(0, 10)}\t${e.status}\t${txh}\t${e.attempt}\t${new Date(e.createdAt).toLocaleString()}`);
    }
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

async function cmdExecutionGet(executionId: string) {
  if (!executionId) {
    console.error("Usage: 4evergent execution get <id>");
    return 1;
  }
  try {
    const { body } = await request(`/executions/${encodeURIComponent(executionId)}`);
    console.log(formatExecution(body.execution));
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

async function cmdApprovalGet(approvalId: string) {
  if (!approvalId) {
    console.error("Usage: 4evergent approval get <id>");
    return 1;
  }
  try {
    const { body } = await request(`/approvals/${encodeURIComponent(approvalId)}`);
    console.log(_formatApproval(body.approval ?? body));
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

async function cmdExecutionRetry(executionId: string) {
  if (!executionId) {
    console.error("Usage: 4evergent execution retry <id>");
    return 1;
  }
  try {
    const { body } = await request(`/executions/${encodeURIComponent(executionId)}/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    console.log(`Execution ${body.execution?.id ?? executionId} retry queued: ${body.message ?? "ok"}`);
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

async function cmdExecutionCancel(executionId: string) {
  if (!executionId) {
    console.error("Usage: 4evergent execution cancel <id>");
    return 1;
  }
  try {
    const { body } = await request(`/executions/${encodeURIComponent(executionId)}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    console.log(`Execution ${body.execution?.id ?? executionId} cancelled: ${body.message ?? "ok"}`);
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

// --- Policy / Activity / Schedule / Intent commands ---

function formatPolicy(p: any) {
  const rules = p.policy ?? {};
  const fmt = (v: any) => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v));
  return `Policy:
  Agent:        ${p.agentId}
  Version:      ${p.version ?? "-"}
  Updated:      ${p.updatedAt ?? "-"}
  Max Tx:       ${fmt(rules.maxTxAmount)}
  Daily Limit:  ${fmt(rules.dailySpendingLimit)}
  Assets:       ${Array.isArray(rules.allowedAssets) ? rules.allowedAssets.join(", ") : "-"}
  Contracts:    ${Array.isArray(rules.allowedContractIds) ? rules.allowedContractIds.join(", ") : "-"}
  Tx Types:     ${fmt(rules.txTypeRestrictions)}
  Approval Th:  ${rules.approvalThreshold ?? "-"}
  Human > :     ${rules.requireHumanApprovalForAmountAbove ?? "-"}
`;
}

function formatActivity(a: any) {
  return `Activity:
  ID:           ${a.id}
  Agent:        ${a.agentId}
  Type:         ${a.intent?.type ?? "-"}
  Amount:       ${a.intent?.amount ?? "-"} ${a.intent?.asset ?? ""}
  Status:       ${a.status}
  TxHash:       ${a.txHash ?? "-"}
  Error:        ${a.error ?? "-"}
  Created:      ${a.createdAt ?? "-"}
`;
}

function formatSchedule(s: any) {
  return `Schedule:
  ID:           ${s.id}
  Agent:        ${s.agentId}
  Status:       ${s.status}
  Expression:   ${s.scheduleExpression}
  Timezone:     ${s.timezone}
  Next Run:     ${s.nextRunAt}
  Last Run:     ${s.lastRunAt ?? "-"}
  Created:      ${s.createdAt}
  Updated:      ${s.updatedAt}
  Intent:       ${s.intent?.type ?? "-"} ${s.intent?.amount ? `${s.intent.amount} ${s.intent.asset ?? ""}` : ""} ${s.intent?.assetCode ? `${s.intent.assetCode} (trustline)` : ""} ${s.intent?.contractId ? `${s.intent.contractId}::${s.intent.function}` : ""}
`;
}

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

function isValidStellarAddress(value: string): boolean {
  return STELLAR_ADDRESS_RE.test(value);
}

/**
 * Build a typed intent object from CLI args.
 * Mirrors the AgentIntent union consumed by POST /agents/:id/intents.
 */
function buildIntentArgs(args: string[]): { intent: any; error?: string } {
  const type = args[0];
  if (!type) return { intent: null, error: "intent type required (payment | trustline | contract_call | account_settings)" };

  switch (type) {
    case "payment": {
      let issuer: string | undefined;
      const positional: string[] = [];
      for (let i = 1; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === "--issuer") {
          const val = args[i + 1];
          if (!val || val.startsWith("--")) {
            return { intent: null, error: "--issuer requires a Stellar address (G...)" };
          }
          issuer = val;
          i++;
        } else if (arg.startsWith("--issuer=")) {
          const val = arg.slice("--issuer=".length);
          if (!val) {
            return { intent: null, error: "--issuer requires a Stellar address (G...)" };
          }
          issuer = val;
        } else {
          positional.push(arg);
        }
      }

      const [asset, amount, destination, reason, memo] = positional;
      if (!asset || !amount || !destination || !reason) {
        return {
          intent: null,
          error: "payment requires: <asset> <amount> <destination> <reason> [memo] [--issuer <G...>]",
        };
      }

      if (asset === "XLM") {
        if (issuer !== undefined) {
          return { intent: null, error: "--issuer is not valid for native XLM payments" };
        }
        return {
          intent: {
            type: "payment",
            asset,
            destination,
            amount,
            reason,
            ...(memo ? { memo } : {}),
          },
        };
      }

      if (!issuer) {
        return {
          intent: null,
          error: `non-native asset '${asset}' requires an issuer (--issuer <G...>)`,
        };
      }

      if (!isValidStellarAddress(issuer)) {
        return {
          intent: null,
          error: `invalid --issuer '${issuer}': must be a valid Stellar address (56-character G... address)`,
        };
      }

      return {
        intent: {
          type: "payment",
          asset,
          assetDetails: { code: asset, issuer },
          destination,
          amount,
          reason,
          ...(memo ? { memo } : {}),
        },
      };
    }
    case "trustline": {
      const [, assetCode, issuer, reason, limit] = args;
      if (!assetCode || !issuer || !reason) {
        return { intent: null, error: "trustline requires: <assetCode> <issuer> <reason> [limit]" };
      }
      return {
        intent: {
          type: "trustline",
          assetCode,
          issuer,
          reason,
          ...(limit ? { limit } : {}),
        },
      };
    }
    case "contract_call": {
      const [, contractId, functionName, argsJson, reason] = args;
      if (!contractId || !functionName || !argsJson || !reason) {
        return { intent: null, error: "contract_call requires: <contractId> <function> <args-json> <reason>" };
      }
      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(argsJson);
      } catch {
        return { intent: null, error: "contract_call args must be a valid JSON array" };
      }
      if (!Array.isArray(parsedArgs)) {
        return { intent: null, error: "contract_call args must be a JSON array" };
      }
      return {
        intent: {
          type: "contract_call",
          contractId,
          function: functionName,
          args: parsedArgs,
          reason,
        },
      };
    }
    case "account_settings": {
      const [, setting, value, reason] = args;
      if (!setting || !value || !reason) {
        return { intent: null, error: "account_settings requires: <setting> <value> <reason>" };
      }
      // Attempt to parse value as JSON; if it fails, keep it as a plain string
      let parsedValue: any;
      try {
        parsedValue = JSON.parse(value);
      } catch {
        parsedValue = value;
      }
      return {
        intent: {
          type: "account_settings",
          setting,
          value: parsedValue,
          reason,
        },
      };
    }
    default:
      return { intent: null, error: `unknown intent type '${type}' (supported: payment, trustline, contract_call, account_settings)` };
  }
}

async function cmdPolicyGet(agentId: string) {
  if (!agentId) {
    console.error("Usage: 4evergent policy get <agent-id>");
    return 1;
  }
  try {
    const { body } = await request(`/agents/${encodeURIComponent(agentId)}/policy`);
    console.log(formatPolicy(body));
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

async function cmdActivityList(agentId: string, limit: string) {
  if (!agentId) {
    console.error("Usage: 4evergent activity list <agent-id> [limit]");
    return 1;
  }
  const n = Number(limit || "50");
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    console.error("limit must be an integer between 1 and 100");
    return 1;
  }
  try {
    const { body } = await request(`/agents/${encodeURIComponent(agentId)}/activity?limit=${n}`);
    const activity = body.activity ?? [];
    if (activity.length === 0) {
      console.log("No activity found.");
      return 0;
    }
    console.log(`ID\t\tAgent\t\tType\t\tStatus\t\tCreated`);
    for (const a of activity) {
      console.log(`${a.id.slice(0, 18)}\t${a.agentId.slice(0, 12)}\t${a.intent?.type ?? "-"}\t${a.status}\t${new Date(a.createdAt).toLocaleString()}`);
    }
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

async function cmdActivityGet(agentId: string, activityId: string) {
  if (!agentId || !activityId) {
    console.error("Usage: 4evergent activity get <agent-id> <activity-id>");
    return 1;
  }
  try {
    const { body } = await request(
      `/agents/${encodeURIComponent(agentId)}/activity/${encodeURIComponent(activityId)}`,
    );
    console.log(formatActivity(body.activity));
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

async function cmdScheduleList(agentId: string, limit: string) {
  if (!agentId) {
    console.error("Usage: 4evergent schedule list <agent-id> [limit]");
    return 1;
  }
  const n = Number(limit || "50");
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    console.error("limit must be an integer between 1 and 100");
    return 1;
  }
  try {
    const { body } = await request(`/agents/${encodeURIComponent(agentId)}/schedules?limit=${n}`);
    const schedules = body.schedules ?? [];
    if (schedules.length === 0) {
      console.log("No schedules found.");
      return 0;
    }
    console.log(`ID\t\tAgent\t\tStatus\t\tExpression\tNext Run`);
    for (const s of schedules) {
      console.log(`${s.id.slice(0, 18)}\t${s.agentId.slice(0, 12)}\t${s.status}\t${s.scheduleExpression}\t${s.nextRunAt}`);
    }
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

async function cmdScheduleGet(agentId: string, scheduleId: string) {
  if (!agentId || !scheduleId) {
    console.error("Usage: 4evergent schedule get <agent-id> <schedule-id>");
    return 1;
  }
  try {
    const { body } = await request(`/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}`);
    console.log(formatSchedule(body.schedule));
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

async function cmdIntentSubmit(agentId: string, args: string[], idempotencyKey: string | null) {
  if (!agentId) {
    console.error("Usage: 4evergent intent submit <agent-id> <type> [args...] [--issuer <G...>] [--idempotency-key <key>]");
    console.error("Types: payment | trustline | contract_call | account_settings");
    return 1;
  }

  // Extract --idempotency-key flag if present
  let key: string | null = idempotencyKey;
  const flagIdx = args.indexOf("--idempotency-key");
  if (flagIdx !== -1) {
    key = args[flagIdx + 1] ?? null;
    args = [...args.slice(0, flagIdx), ...args.slice(flagIdx + 2)];
  }

  const { intent, error } = buildIntentArgs(args);
  if (error) {
    console.error(`Error: ${error}`);
    return 1;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["Idempotency-Key"] = key;

  try {
    const { status, body } = await request(`/agents/${encodeURIComponent(agentId)}/intents`, {
      method: "POST",
      headers,
      body: JSON.stringify(intent),
    });
    // 200 = idempotent duplicate, 202 = accepted (requires approval or executing)
    console.log(`Intent ${status === 200 ? "(idempotent duplicate)" : status === 202 ? "(accepted)" : "(submitted)"}: agent=${body.agentId} activity=${body.activityId} status=${body.status}`);
    if (body.approvalId) console.log(`  Approval required: approvalId=${body.approvalId}`);
    if (body.txHash) console.log(`  TxHash: ${body.txHash}`);
    if (body.policyDecision) console.log(`  Policy: ${body.policyDecision.result} (${body.policyDecision.reason})`);
    if (body.error) console.log(`  Error: ${body.error}`);
    return 0;
  } catch (err: any) {
    if (err instanceof ApiError && err.status === 0) {
      // Network failure — the request MAY have been transmitted. Never retry
      // automatically; the server dedupes on Idempotency-Key when present.
      console.error(`Error: ${err.message}`);
      if (key) {
        console.error(`The request outcome is UNKNOWN (network failure after possible transmission).`);
        console.error(`Retry manually with the SAME --idempotency-key to avoid a duplicate intent.`);
      } else {
        console.error(`The request outcome is UNKNOWN (network failure after possible transmission).`);
        console.error(`No Idempotency-Key was provided — retrying may create a duplicate intent.`);
      }
    } else {
      console.error(`Error: ${err.message}`);
    }
    return 1;
  }
}

// --- Batch 3: Lifecycle Commands ---

async function cmdAgentCreate(args: string[]) {
  if (args.length === 0) {
    console.error("Usage: 4evergent agent create <name> [--description <desc>] [--capabilities a,b] [--stellar-address G...]");
    return 1;
  }
  const displayName = args[0];
  let description = "";
  let capabilities: string[] = [];
  let stellarAddress: string | undefined;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--description" && args[i + 1]) {
      const val = args[i + 1];
      if (val !== undefined) description = val;
      i++;
    } else if (args[i] === "--capabilities" && args[i + 1]) {
      capabilities = (args[i + 1] ?? "").split(",").map((s: string) => s.trim()).filter(Boolean);
      i++;
    } else if (args[i] === "--stellar-address" && args[i + 1]) {
      stellarAddress = args[i + 1];
      i++;
    }
  }

  try {
    const { body } = await request("/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName, description, capabilities, stellarAddress }),
    });
    console.log(`Agent created:\n  ID: ${body.agent.id}\n  Name: ${body.agent.displayName}\n  Status: ${body.agent.status}`);
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

const RECOGNIZED_POLICY_FIELDS = [
  "maxTxAmount",
  "dailySpendingLimit",
  "allowedAssets",
  "allowedDestinations",
  "allowedContractIds",
  "txTypeRestrictions",
  "approvalThreshold",
  "requireHumanApprovalForAmountAbove",
] as const;

async function cmdPolicyUpdate(agentId: string, args: string[]) {
  if (!agentId) {
    console.error("Usage: 4evergent policy update <agent-id> --rules '<json>'");
    console.error(`  --rules must be a JSON object with at least one policy field: ${RECOGNIZED_POLICY_FIELDS.join(", ")}`);
    console.error("  Note: pass the inner 'policy' object, not the 'policy get' envelope ({ agentId, policy, version, updatedAt }).");
    return 1;
  }
  const idx = args.indexOf("--rules");
  if (idx === -1 || !args[idx + 1]) {
    console.error("Error: --rules '<json>' is required");
    return 1;
  }
  let policy: any;
  try {
    policy = JSON.parse(args[idx + 1]!);
  } catch {
    console.error("Error: --rules must be valid JSON");
    return 1;
  }

  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    console.error(`Error: --rules must be a JSON object containing at least one recognized policy field (${RECOGNIZED_POLICY_FIELDS.join(", ")})`);
    return 1;
  }

  const hasRecognizedField = RECOGNIZED_POLICY_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(policy, field));
  if (!hasRecognizedField) {
    if (typeof policy.policy === "object" && policy.policy !== null && !Array.isArray(policy.policy)) {
      console.error(
        "Error: --rules appears to be a 'policy get' envelope ({ agentId, policy, version, updatedAt }). " +
          "Pass the inner 'policy' object instead."
      );
      return 1;
    }
    console.error(
      `Error: --rules contains no recognized policy fields. ` +
        `Expected at least one of: ${RECOGNIZED_POLICY_FIELDS.join(", ")}`
    );
    return 1;
  }

  try {
    const { body } = await request(`/agents/${encodeURIComponent(agentId)}/policy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(policy),
    });
    console.log(`Policy updated:\n${formatPolicy(body)}`);
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

async function cmdScheduleCreate(agentId: string, args: string[]) {
  if (!agentId || args.length < 2) {
    console.error("Usage: 4evergent schedule create <agent-id> <cron-expression> <intent-type> [intent-args...] [--issuer <G...>] [--timezone UTC]");
    return 1;
  }
  const expression = args[0];
  let timezone = "UTC";

  const tzIdx = args.indexOf("--timezone");
  if (tzIdx !== -1) {
    timezone = args[tzIdx + 1] ?? "UTC";
    args = [...args.slice(0, tzIdx), ...args.slice(tzIdx + 2)];
  }

  const { intent, error } = buildIntentArgs(args.slice(1));
  if (error) {
    console.error(`Error: ${error}`);
    return 1;
  }

  try {
    const { body } = await request(`/agents/${encodeURIComponent(agentId)}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent, scheduleExpression: expression, timezone }),
    });
    console.log(`Schedule created:\n  ID: ${body.schedule.id}\n  Expression: ${body.schedule.scheduleExpression}\n  Timezone: ${body.schedule.timezone}\n  Next Run: ${body.schedule.nextRunAt}`);
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

async function cmdScheduleUpdate(agentId: string, args: string[]) {
  if (!agentId || args.length < 2) {
    console.error("Usage: 4evergent schedule update <agent-id> <schedule-id> <expression>");
    return 1;
  }
  const scheduleId = args[0]!;
  const expression = args[1]!;

  try {
    const { body } = await request(`/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scheduleExpression: expression }),
    });
    console.log(`Schedule updated:\n  ID: ${body.schedule.id}\n  Expression: ${body.schedule.scheduleExpression}\n  Next Run: ${body.schedule.nextRunAt}`);
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

async function cmdSchedulePause(agentId: string, scheduleId: string) {
  if (!agentId || !scheduleId) {
    console.error("Usage: 4evergent schedule pause <agent-id> <schedule-id>");
    return 1;
  }
  try {
    const { body } = await request(`/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}/pause`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    console.log(`Schedule paused:\n  ID: ${body.schedule.id}\n  Status: ${body.schedule.status}`);
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

async function cmdScheduleResume(agentId: string, scheduleId: string) {
  if (!agentId || !scheduleId) {
    console.error("Usage: 4evergent schedule resume <agent-id> <schedule-id>");
    return 1;
  }
  try {
    const { body } = await request(`/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    console.log(`Schedule resumed:\n  ID: ${body.schedule.id}\n  Status: ${body.schedule.status}`);
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

async function cmdScheduleDisable(agentId: string, scheduleId: string) {
  if (!agentId || !scheduleId) {
    console.error("Usage: 4evergent schedule disable <agent-id> <schedule-id>");
    return 1;
  }
  try {
    const { body } = await request(`/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}/disable`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    console.log(`Schedule disabled:\n  ID: ${body.schedule.id}\n  Status: ${body.schedule.status}`);
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

async function cmdScheduleDelete(agentId: string, scheduleId: string, force = false) {
  if (!agentId || !scheduleId) {
    console.error("Usage: 4evergent schedule delete <agent-id> <schedule-id> [--force|--yes]");
    return 1;
  }
  try {
    if (!force && !process.stdin.isTTY) {
      console.error("Refusing destructive action: stdin is not a TTY. Rerun with --force or --yes to proceed.");
      return 1;
    }
    if (!force) {
      const { body } = await request(
        `/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}`
      );
      const schedule = body.schedule ?? body;
      const target = `${schedule.scheduleExpression ?? "(unknown expression)"} (ID: ${schedule.id ?? scheduleId})`;
      const confirmed = await confirmDestructiveAction(target, "Delete this schedule permanently?", { force });
      if (!confirmed) {
        console.error("Aborted; no changes made.");
        return 1;
      }
    }

    await request(`/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}`, {
      method: "DELETE",
    });
    console.log(`Schedule deleted: ${scheduleId}`);
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

// --- CLI dispatch ---

// --- CLI dispatch ---

const argv = process.argv.slice(2);

export const dispatcherTree = buildCommandTree({
  health: () => cmdHealth(),
  agent: {
    list: (args) => cmdAgentList(args),
    get: (args) => cmdAgentGet(args[0] ?? ""),
    create: (args) => cmdAgentCreate(args),
    pause: (args) => cmdAgentStatus(args[0] ?? "", "paused"),
    resume: (args) => cmdAgentStatus(args[0] ?? "", "active"),
    disable: (args) => {
      const force = args.some((arg) => arg === "--force" || arg === "--yes");
      return cmdAgentStatus(args.find((arg) => arg !== "--force" && arg !== "--yes") ?? "", "disabled", force);
    },
  },
  approval: {
    list: cmdApprovalList,
    get: (args) => cmdApprovalGet(args[0] ?? ""),
    approve: (args) => cmdApprovalAction(args[0] ?? "", "approve"),
    reject: (args) => cmdApprovalAction(args[0] ?? "", "reject"),
  },
  execution: {
    list: (args) => cmdExecutionList(args[0] ?? ""),
    get: (args) => cmdExecutionGet(args[0] ?? ""),
    retry: (args) => cmdExecutionRetry(args[0] ?? ""),
    cancel: (args) => cmdExecutionCancel(args[0] ?? ""),
  },
  policy: {
    get: (args) => cmdPolicyGet(args[0] ?? ""),
    update: (args) => cmdPolicyUpdate(args[0] ?? "", args.slice(1)),
  },
  activity: {
    list: (args) => cmdActivityList(args[0] ?? "", args[1] ?? ""),
    get: (args) => cmdActivityGet(args[0] ?? "", args[1] ?? ""),
  },
  schedule: {
    list: (args) => cmdScheduleList(args[0] ?? "", args[1] ?? ""),
    get: (args) => cmdScheduleGet(args[0] ?? "", args[1] ?? ""),
    create: (args) => cmdScheduleCreate(args[0] ?? "", args.slice(1)),
    update: (args) => cmdScheduleUpdate(args[0] ?? "", args.slice(1)),
    pause: (args) => cmdSchedulePause(args[0] ?? "", args[1] ?? ""),
    resume: (args) => cmdScheduleResume(args[0] ?? "", args[1] ?? ""),
    disable: (args) => cmdScheduleDisable(args[0] ?? "", args[1] ?? ""),
    delete: (args) => {
      const positionalArgs = args.filter((arg) => arg !== "--force" && arg !== "--yes");
      const force = positionalArgs.length !== args.length;
      return cmdScheduleDelete(positionalArgs[0] ?? "", positionalArgs[1] ?? "", force);
    },
  },
  intent: {
    submit: (args) => cmdIntentSubmit(args[0] ?? "", args.slice(1), null),
  },
  completion: {
    bash: () => {
      process.stdout.write(generateCompletion("bash", COMMAND_TREE));
      return 0;
    },
    zsh: () => {
      process.stdout.write(generateCompletion("zsh", COMMAND_TREE));
      return 0;
    },
  },
});

async function main(): Promise<number> {
  return dispatchCommand(dispatcherTree, argv, {
    version: VERSION,
    helpText: COMMANDS_HELP,
  });
}

main().then((code) => exit(requestTimedOut ? EXIT_TIMEOUT : code)).catch((err) => {
  console.error(`Fatal: ${err.message}`);
  exit(requestTimedOut ? EXIT_TIMEOUT : 1);
});
