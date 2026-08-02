import { createContext } from "./command-context.mjs";
import { environmentCommand } from "./environment-commands.mjs";
import { fail } from "./errors.mjs";
import { marketplaceCommand } from "./marketplace-commands.mjs";

const VERSION = "0.1.0";

const HELP = `Usage: skillsenv <command> [options]

Marketplace commands:
  marketplace add <source>       Register a Claude Code Plugin Marketplace
  marketplace list               List registered marketplaces
  marketplace use <name>         Select the default marketplace
  marketplace update [name]      Refresh one or all remote marketplaces
  marketplace remove <name>      Remove a marketplace registration

Environment commands:
  init                            Create .skillsenv in the current directory
  install <plugin[@market]>       Add, lock, cache, and sync a dependency
  uninstall <plugin[@market]>     Remove a dependency and sync managed links
  lock                            Resolve dependencies and write the lock file
  sync                            Resolve, lock, cache, and sync dependencies
  activate                        Trust-gated, cache-only project sync
  trust | untrust                Manage trust for the current project lock
  status                          Show the nearest environment and managed state
  clean                           Remove unchanged links managed by this environment
  agents                          List supported Agent IDs and target paths
  shell-init <bash|zsh|fish>      Print the optional auto-activation hook

Common options:
  --scope <project|user>          Select project (default) or user environment
  --agent <id[,id...]>            Agent targets for install
  --skill <name[,name...]>        Skill filter for install
  --replace                       Back up conflicting entries before linking
  --dry-run                       Resolve and preflight without persistent changes
  --frozen                        Sync only the existing lock and cache
  --root <path>                   Start project discovery at this directory
`;

export async function runCli(argv, overrides = {}) {
  const context = createContext(overrides);
  const [command, ...args] = argv;
  if (command === "--version" || command === "-V" || command === "version") {
    context.write(VERSION);
    return { kind: "version", version: VERSION };
  }
  if (!command || command === "help" || command === "--help" || command === "-h") {
    context.write(HELP.trimEnd());
    return { kind: "help" };
  }
  if (command === "marketplace") return marketplaceCommand(context, args);
  const result = environmentCommand(context, command, args);
  if (result) return result;
  fail(`Unknown command: ${command}; run skillsenv help`);
}

export { HELP };
