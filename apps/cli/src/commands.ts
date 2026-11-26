/**
 * Declared command tree for the 4evergent Operator CLI.
 *
 * Single source of truth for:
 *   1. CLI dispatch routing and validation
 *   2. Shell completion generation (bash, zsh)
 *   3. CLI usage and help formatting
 */

export interface CommandArg {
  readonly name: string;
  readonly description?: string;
  readonly values?: readonly string[];
  readonly optional?: boolean;
}

/**
 * A documented argument layout that varies by a leading type argument, such as
 * `intent submit <type> ...`. Rendered verbatim by the help formatter.
 */
export interface CommandArgVariant {
  readonly name: string;
  readonly usage: string;
}

export type CommandHandler = (args: string[]) => Promise<number> | number;

export interface SubcommandDef {
  readonly name: string;
  readonly description: string;
  readonly usage?: string;
  readonly args?: readonly CommandArg[];
  readonly variants?: readonly CommandArgVariant[];
  readonly flags?: readonly string[];
  run?: CommandHandler;
}

export interface CommandDef {
  readonly name: string;
  readonly description: string;
  readonly usage?: string;
  readonly reportUnknownSubcommand?: boolean | "if-present";
  readonly unknownSubcommandLabel?: string;
  readonly subcommands?: Record<string, SubcommandDef>;
  readonly args?: readonly CommandArg[];
  readonly flags?: readonly string[];
  run?: CommandHandler;
}

export type CommandTree = Record<string, CommandDef>;

export const APPROVAL_LIST_USAGE = "Usage: 4evergent approval list [--status <status>] [--limit <limit> | <limit>]";

export const INTENT_TYPES = ["payment", "trustline", "contract_call", "account_settings"] as const;
export type IntentType = (typeof INTENT_TYPES)[number];

export const SUPPORTED_SHELLS = ["bash", "zsh"] as const;
export type SupportedShell = (typeof SUPPORTED_SHELLS)[number];

export interface CommandTreeHandlers {
  health: () => Promise<number> | number;
  agent: {
    list: (args: string[]) => Promise<number> | number;
    get: (args: string[]) => Promise<number> | number;
    create: (args: string[]) => Promise<number> | number;
    pause: (args: string[]) => Promise<number> | number;
    resume: (args: string[]) => Promise<number> | number;
    disable: (args: string[]) => Promise<number> | number;
  };
  approval: {
    list: (args: string[]) => Promise<number> | number;
    get: (args: string[]) => Promise<number> | number;
    approve: (args: string[]) => Promise<number> | number;
    reject: (args: string[]) => Promise<number> | number;
  };
  execution: {
    list: (args: string[]) => Promise<number> | number;
    get: (args: string[]) => Promise<number> | number;
    retry: (args: string[]) => Promise<number> | number;
    cancel: (args: string[]) => Promise<number> | number;
  };
  policy: {
    get: (args: string[]) => Promise<number> | number;
    update: (args: string[]) => Promise<number> | number;
  };
  activity: {
    list: (args: string[]) => Promise<number> | number;
    get: (args: string[]) => Promise<number> | number;
  };
  schedule: {
    list: (args: string[]) => Promise<number> | number;
    get: (args: string[]) => Promise<number> | number;
    create: (args: string[]) => Promise<number> | number;
    update: (args: string[]) => Promise<number> | number;
    pause: (args: string[]) => Promise<number> | number;
    resume: (args: string[]) => Promise<number> | number;
    disable: (args: string[]) => Promise<number> | number;
    delete: (args: string[]) => Promise<number> | number;
  };
  intent: {
    submit: (args: string[]) => Promise<number> | number;
  };
  completion: {
    bash: () => Promise<number> | number;
    zsh: () => Promise<number> | number;
  };
}

/**
 * Creates the declared command tree, optionally binding runtime handlers for dispatch.
 */
export function buildCommandTree(handlers?: CommandTreeHandlers): CommandTree {
  return {
    health: {
      name: "health",
      description: "Check API health",
      run: handlers ? () => handlers.health() : undefined,
    },
    agent: {
      name: "agent",
      description: "Manage agents and their status",
      usage:
        "Usage: 4evergent agent <list|get|create|pause|resume|disable> [id]\n" +
        "       4evergent agent list [--capability <capability>] [--limit <n>]\n" +
        "       4evergent agent disable <id> [--force|--yes]",
      reportUnknownSubcommand: true,
      subcommands: {
        list: {
          name: "list",
          description: "List your agents",
          flags: ["--capability", "--limit"],
          run: handlers ? (args) => handlers.agent.list(args) : undefined,
        },
        get: {
          name: "get",
          description: "Show agent details",
          args: [{ name: "id", description: "Agent ID" }],
          run: handlers ? (args) => handlers.agent.get(args) : undefined,
        },
        create: {
          name: "create",
          description: "Create a new agent",
          args: [
            { name: "name", description: "Agent display name" },
            { name: "description", description: "Agent description" },
            { name: "stellar-address", description: "Stellar G-address" },
            { name: "capabilities", description: "Agent capabilities" },
          ],
          run: handlers ? (args) => handlers.agent.create(args) : undefined,
        },
        pause: {
          name: "pause",
          description: "Pause agent (rejects new intents)",
          args: [{ name: "id", description: "Agent ID" }],
          run: handlers ? (args) => handlers.agent.pause(args) : undefined,
        },
        resume: {
          name: "resume",
          description: "Resume agent (active)",
          args: [{ name: "id", description: "Agent ID" }],
          run: handlers ? (args) => handlers.agent.resume(args) : undefined,
        },
        disable: {
          name: "disable",
          description: "Disable an agent permanently; use --force or --yes to skip confirmation",
          args: [{ name: "id", description: "Agent ID" }],
          flags: ["--force", "--yes"],
          run: handlers ? (args) => handlers.agent.disable(args) : undefined,
        },
      },
    },
    approval: {
      name: "approval",
      description: "Manage pending intent approvals",
      usage: "Usage: 4evergent approval <list|get|approve|reject> [id]",
      reportUnknownSubcommand: true,
      subcommands: {
        list: {
          name: "list",
          description: "List approvals, optionally filtered by status",
          usage: APPROVAL_LIST_USAGE,
          args: [{ name: "limit", description: "Maximum approvals (1-200, default 50)", optional: true }],
          flags: ["--status", "--limit"],
          run: handlers?.approval.list,
        },
        get: {
          name: "get",
          description: "Show approval detail",
          args: [{ name: "id", description: "Approval ID" }],
          run: handlers ? (args) => handlers.approval.get(args) : undefined,
        },
        approve: {
          name: "approve",
          description: "Approve an intent",
          args: [{ name: "id", description: "Approval ID" }],
          run: handlers ? (args) => handlers.approval.approve(args) : undefined,
        },
        reject: {
          name: "reject",
          description: "Reject an intent",
          args: [{ name: "id", description: "Approval ID" }],
          run: handlers ? (args) => handlers.approval.reject(args) : undefined,
        },
      },
    },
    execution: {
      name: "execution",
      description: "Manage executions across all agents",
      usage: "Usage: 4evergent execution <list|get|retry|cancel> [id]",
      reportUnknownSubcommand: true,
      subcommands: {
        list: {
          name: "list",
          description: "List executions across all agents",
          args: [{ name: "limit", description: "Max executions to list", optional: true }],
          run: handlers ? (args) => handlers.execution.list(args) : undefined,
        },
        get: {
          name: "get",
          description: "Show execution detail",
          args: [{ name: "id", description: "Execution ID" }],
          run: handlers ? (args) => handlers.execution.get(args) : undefined,
        },
        retry: {
          name: "retry",
          description: "Retry a failed or dead-letter execution",
          args: [{ name: "id", description: "Execution ID" }],
          run: handlers ? (args) => handlers.execution.retry(args) : undefined,
        },
        cancel: {
          name: "cancel",
          description: "Cancel a queued or executing execution",
          args: [{ name: "id", description: "Execution ID" }],
          run: handlers ? (args) => handlers.execution.cancel(args) : undefined,
        },
      },
    },
    policy: {
      name: "policy",
      description: "Manage agent policies",
      usage: "Usage: 4evergent policy <get|update> <agent-id>",
      reportUnknownSubcommand: false,
      subcommands: {
        get: {
          name: "get",
          description: "Show effective policy rules",
          args: [{ name: "agent-id", description: "Agent ID" }],
          run: handlers ? (args) => handlers.policy.get(args) : undefined,
        },
        update: {
          name: "update",
          description: "Update agent policy rules",
          args: [{ name: "agent-id", description: "Agent ID" }],
          flags: ["--rules"],
          run: handlers ? (args) => handlers.policy.update(args) : undefined,
        },
      },
    },
    activity: {
      name: "activity",
      description: "Manage agent activity logs",
      usage: "Usage: 4evergent activity <list <agent-id> [limit] | get <agent-id> <activity-id>>",
      reportUnknownSubcommand: false,
      subcommands: {
        list: {
          name: "list",
          description: "List agent activity",
          args: [
            { name: "agent-id", description: "Agent ID" },
            { name: "limit", description: "Limit (1-100, default 50)", optional: true },
          ],
          run: handlers ? (args) => handlers.activity.list(args) : undefined,
        },
        get: {
          name: "get",
          description: "Show activity detail",
          args: [
            { name: "agent-id", description: "Agent ID" },
            { name: "activity-id", description: "Activity ID" },
          ],
          run: handlers ? (args) => handlers.activity.get(args) : undefined,
        },
      },
    },
    schedule: {
      name: "schedule",
      description: "Manage recurring agent schedules",
      usage:
        "Usage: 4evergent schedule <list|get|create|update|pause|resume|disable|delete> [args...]\n" +
        "       4evergent schedule delete <agent-id> <schedule-id> [--force|--yes]",
      reportUnknownSubcommand: false,
      subcommands: {
        list: {
          name: "list",
          description: "List agent schedules",
          args: [
            { name: "agent-id", description: "Agent ID" },
            { name: "limit", description: "Limit (1-100, default 50)", optional: true },
          ],
          run: handlers ? (args) => handlers.schedule.list(args) : undefined,
        },
        get: {
          name: "get",
          description: "Show schedule detail",
          args: [
            { name: "agent-id", description: "Agent ID" },
            { name: "schedule-id", description: "Schedule ID" },
          ],
          run: handlers ? (args) => handlers.schedule.get(args) : undefined,
        },
        create: {
          name: "create",
          description: "Create a scheduled intent execution",
          args: [
            { name: "agent-id", description: "Agent ID" },
            { name: "expression", description: "Cron expression (5 fields)" },
            { name: "type", description: "Intent type", values: INTENT_TYPES },
          ],
          flags: ["--issuer", "--timezone"],
          run: handlers ? (args) => handlers.schedule.create(args) : undefined,
        },
        update: {
          name: "update",
          description: "Update schedule expression",
          args: [
            { name: "agent-id", description: "Agent ID" },
            { name: "schedule-id", description: "Schedule ID" },
            { name: "expression", description: "New cron expression" },
          ],
          run: handlers ? (args) => handlers.schedule.update(args) : undefined,
        },
        pause: {
          name: "pause",
          description: "Pause a schedule",
          args: [
            { name: "agent-id", description: "Agent ID" },
            { name: "schedule-id", description: "Schedule ID" },
          ],
          run: handlers ? (args) => handlers.schedule.pause(args) : undefined,
        },
        resume: {
          name: "resume",
          description: "Resume a paused schedule",
          args: [
            { name: "agent-id", description: "Agent ID" },
            { name: "schedule-id", description: "Schedule ID" },
          ],
          run: handlers ? (args) => handlers.schedule.resume(args) : undefined,
        },
        disable: {
          name: "disable",
          description: "Disable a schedule permanently",
          args: [
            { name: "agent-id", description: "Agent ID" },
            { name: "schedule-id", description: "Schedule ID" },
          ],
          run: handlers ? (args) => handlers.schedule.disable(args) : undefined,
        },
        delete: {
          name: "delete",
          description: "Delete a schedule permanently; use --force or --yes to skip confirmation",
          args: [
            { name: "agent-id", description: "Agent ID" },
            { name: "schedule-id", description: "Schedule ID" },
          ],
          flags: ["--force", "--yes"],
          run: handlers ? (args) => handlers.schedule.delete(args) : undefined,
        },
      },
    },
    intent: {
      name: "intent",
      description: "Submit transactional intents",
      usage:
        "Usage: 4evergent intent submit <agent-id> <type> [args...] [--issuer <G...>] [--idempotency-key <key>]\nTypes: payment | trustline | contract_call | account_settings",
      reportUnknownSubcommand: false,
      subcommands: {
        submit: {
          name: "submit",
          description: "Submit an intent (payment, trustline, contract_call, account_settings)",
          usage:
            "Usage: 4evergent intent submit <agent-id> <type> [args...] [--idempotency-key <key>] [--issuer <G...>]",
          args: [
            { name: "agent-id", description: "Agent ID" },
            {
              name: "type",
              description: "Intent type",
              values: INTENT_TYPES,
            },
          ],
          variants: [
            {
              name: "payment",
              usage: "payment <asset> <amount> <destination> <reason> [memo] [--issuer <G...>]",
            },
            { name: "trustline", usage: "trustline <assetCode> <issuer> <reason> [limit]" },
            {
              name: "contract_call",
              usage: "contract_call <contractId> <function> <args-json> <reason>",
            },
            {
              name: "account_settings",
              usage: "account_settings <setting> <value> <reason>",
            },
          ],
          flags: ["--idempotency-key", "--issuer"],
          run: handlers ? (args) => handlers.intent.submit(args) : undefined,
        },
      },
    },
    completion: {
      name: "completion",
      description: "Generate shell completion script (bash, zsh)",
      usage: "Usage: 4evergent completion <bash|zsh>",
      reportUnknownSubcommand: "if-present",
      unknownSubcommandLabel: "shell",
      subcommands: {
        bash: {
          name: "bash",
          description: "Generate Bash completion script",
          run: handlers ? () => handlers.completion.bash() : undefined,
        },
        zsh: {
          name: "zsh",
          description: "Generate Zsh completion script",
          run: handlers ? () => handlers.completion.zsh() : undefined,
        },
      },
      args: [
        {
          name: "shell",
          description: "Target shell",
          values: SUPPORTED_SHELLS,
        },
      ],
    },
  };
}

export const COMMAND_TREE: CommandTree = buildCommandTree();

export const COMMANDS_HELP = [
  "Commands:",
  "  --version, -v  Print the CLI package version",
  "  --help, -h     Show help (also: 4evergent <command> [<subcommand>] --help)",
  "  health",
  "  agent list | get <id> | create <name> | pause <id> | resume <id> | disable <id> [--force|--yes]",
  "  approval list | get <id> | approve <id> | reject <id>",
  "  execution list | get <id> | retry <id> | cancel <id>",
  "  policy get <agent-id> | update <agent-id>",
  "  activity list <agent-id> [limit] | get <agent-id> <activity-id>",
  "  schedule list <agent-id> [limit] | get <agent-id> <schedule-id> | create <agent-id> <cron> <intent> [--issuer <G...>] [--timezone <tz>] | update <agent-id> <schedule-id> <cron> | pause <agent-id> <schedule-id> | resume <agent-id> <schedule-id> | disable <agent-id> <schedule-id> | delete <agent-id> <schedule-id> [--force|--yes]",
  "  intent submit <agent-id> <type> [args...] [--issuer <G...>] [--idempotency-key <key>]",
  "  completion bash | zsh",
  "",
  "Run '4evergent <command> --help' or '4evergent <command> <subcommand> --help' for details.",
].join("\n");

const HELP_FLAGS: readonly string[] = ["--help", "-h"];

function pad(text: string, width: number): string {
  return text.padEnd(width);
}

function formatArgUsage(arg: CommandArg): string {
  return arg.optional ? `[<${arg.name}>]` : `<${arg.name}>`;
}

/**
 * Builds a usage line from the declared arg/flag definitions, so a command
 * cannot advertise arguments it does not declare (or omit ones it does).
 */
function buildUsage(
  path: string,
  def: { args?: readonly CommandArg[]; flags?: readonly string[] }
): string {
  const signature = [
    (def.args ?? []).map(formatArgUsage).join(" "),
    (def.flags ?? []).map((flag) => `[${flag}]`).join(" "),
  ]
    .filter((part) => part.length > 0)
    .join(" ");
  return `Usage: 4evergent ${path}${signature ? ` ${signature}` : ""}`;
}

function formatArgLines(args: readonly CommandArg[]): string[] {
  const width = Math.max(...args.map((arg) => arg.name.length + 2));
  return args.map((arg) => {
    const notes = [
      arg.values ? `one of: ${arg.values.join(", ")}` : "",
      arg.optional ? "optional" : "",
    ].filter(Boolean);
    const suffix = notes.length > 0 ? ` (${notes.join("; ")})` : "";
    return `  ${pad(`<${arg.name}>`, width)}  ${arg.description ?? ""}${suffix}`.trimEnd();
  });
}

/**
 * Help for a top-level command: its usage line plus every declared subcommand.
 */
export function formatCommandHelp(cmdName: string, cmdDef: CommandDef): string {
  const lines = [`4evergent ${cmdName} — ${cmdDef.description}`, ""];
  lines.push(cmdDef.usage ?? buildUsage(cmdName, cmdDef));

  if (cmdDef.args && cmdDef.args.length > 0) {
    lines.push("", "Arguments:", ...formatArgLines(cmdDef.args));
  }
  if (cmdDef.flags && cmdDef.flags.length > 0) {
    lines.push("", `Flags: ${cmdDef.flags.join(", ")}`);
  }

  const subcommands = Object.values(cmdDef.subcommands ?? {});
  if (subcommands.length > 0) {
    const width = Math.max(...subcommands.map((sub) => sub.name.length));
    lines.push("", "Subcommands:");
    for (const sub of subcommands) {
      lines.push(`  ${pad(sub.name, width)}  ${sub.description}`);
    }
    lines.push("", `Run '4evergent ${cmdName} <subcommand> --help' for arguments and flags.`);
  }

  return lines.join("\n");
}

/**
 * Help for a single subcommand: usage, arguments, per-type argument order and flags.
 */
export function formatSubcommandHelp(
  cmdName: string,
  cmdDef: CommandDef,
  subName: string,
  subDef: SubcommandDef
): string {
  const lines = [`4evergent ${cmdName} ${subName} — ${subDef.description}`, ""];
  lines.push(subDef.usage ?? buildUsage(`${cmdName} ${subName}`, subDef));

  if (subDef.args && subDef.args.length > 0) {
    lines.push("", "Arguments:", ...formatArgLines(subDef.args));
  }

  if (subDef.variants && subDef.variants.length > 0) {
    const width = Math.max(...subDef.variants.map((variant) => variant.name.length));
    lines.push("", "Argument order by type:");
    for (const variant of subDef.variants) {
      lines.push(`  ${pad(variant.name, width)}  ${variant.usage}`);
    }
  }

  if (subDef.flags && subDef.flags.length > 0) {
    lines.push("", `Flags: ${subDef.flags.join(", ")}`);
  }

  if (cmdDef.subcommands) {
    lines.push("", `Run '4evergent ${cmdName} --help' for all ${cmdName} subcommands.`);
  }

  return lines.join("\n");
}

/**
 * Prints help selected by the first positional tokens and returns the exit code.
 * A help flag never reaches a handler, so it can never be read as a positional.
 */
function printHelp(tree: CommandTree, argv: string[], helpText: string): number {
  const positionals = argv.filter((arg) => !HELP_FLAGS.includes(arg));
  const [cmd, sub] = positionals;

  if (!cmd || cmd === "help") {
    console.log(`4evergent Operator CLI\n\n${helpText}`);
    return 0;
  }

  const cmdDef = tree[cmd];
  if (!cmdDef) {
    console.error(`Unknown command: ${cmd}`);
    return 1;
  }

  const subDef = sub ? cmdDef.subcommands?.[sub] : undefined;
  if (sub && subDef) {
    console.log(formatSubcommandHelp(cmd, cmdDef, sub, subDef));
    return 0;
  }

  console.log(formatCommandHelp(cmd, cmdDef));
  return 0;
}

/**
 * Dispatches a command line using the declared command tree.
 */
export async function dispatchCommand(
  tree: CommandTree,
  argv: string[],
  options: {
    version: string;
    helpText?: string;
  }
): Promise<number> {
  const cmd = argv[0];
  const sub = argv[1];
  const helpText = options.helpText ?? COMMANDS_HELP;

  // --help/-h anywhere short-circuits: no handler runs and no usage error is
  // reported about positionals the operator did not intend to supply.
  if (argv.some((arg) => HELP_FLAGS.includes(arg))) {
    return printHelp(tree, argv, helpText);
  }

  if (cmd === "--version" || cmd === "-v") {
    console.log(options.version);
    return 0;
  }

  if (cmd === "help") {
    console.log(`4evergent Operator CLI\n\n${helpText}`);
    return 0;
  }

  if (!cmd) {
    console.error(`Usage: 4evergent <command> [args...]\n\n${helpText}`);
    return 1;
  }

  const cmdDef = tree[cmd];
  if (!cmdDef) {
    console.error(`Unknown command: ${cmd}`);
    return 1;
  }

  if (cmdDef.subcommands) {
    const subDef = sub ? cmdDef.subcommands[sub] : undefined;
    if (!subDef || !subDef.run) {
      if (cmdDef.reportUnknownSubcommand === true) {
        console.error(`Unknown ${cmd} subcommand: ${sub}`);
      } else if (cmdDef.reportUnknownSubcommand === "if-present" && sub) {
        const label = cmdDef.unknownSubcommandLabel ?? "subcommand";
        console.error(`Unknown ${cmd} ${label}: ${sub}`);
      }
      if (cmdDef.usage) {
        console.error(cmdDef.usage);
      }
      return 1;
    }
    return subDef.run(argv.slice(2));
  }

  if (cmdDef.run) {
    return cmdDef.run(argv.slice(1));
  }

  console.error(`Unknown command: ${cmd}`);
  return 1;
}
