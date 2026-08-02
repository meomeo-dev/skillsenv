import { renderHelp } from "./cli-help.mjs";
import { parseCli } from "./cli-parser.mjs";
import { createContext } from "./command-context.mjs";
import { environmentCommand } from "./environment-commands.mjs";
import { failUsage } from "./errors.mjs";
import { setOfflineMode } from "./io.mjs";
import { marketplaceCommand } from "./marketplace-commands.mjs";

const VERSION = "0.3.0";

const MARKETPLACE_HANDLERS = new Set([
  "marketplace-add",
  "marketplace-list",
  "marketplace-use",
  "marketplace-update",
  "marketplace-remove",
]);

function renderResult(context, result) {
  if (!context.json) return result;
  // In JSON mode stdout carries exactly one document; every hint and diagnostic
  // has already been routed to stderr (CFI-012).
  const payload = result?.data ?? { kind: result?.kind ?? null };
  context.emitJson(JSON.stringify(payload, null, 2));
  return result;
}

export async function runCli(argv, overrides = {}) {
  const intent = parseCli(argv);
  const context = createContext(overrides, intent.options);
  // Set once per run; the egress guard in io.mjs reads it.
  setOfflineMode(intent.options.offline === true);
  // Migration hints go to stderr so they never contaminate JSON on stdout.
  for (const hint of intent.deprecations) context.warn(`WARNING: ${hint}`);

  if (intent.kind === "help") {
    context.write(renderHelp(intent.path));
    return { kind: "help", path: intent.path };
  }
  if (intent.kind === "version") {
    if (context.json) {
      context.emitJson(JSON.stringify({ version: VERSION }, null, 2));
    } else {
      context.write(VERSION);
    }
    return { kind: "version", version: VERSION };
  }

  const { command, options, positional } = intent;
  const request = { context, options, positional, path: intent.path };
  if (MARKETPLACE_HANDLERS.has(command.handler)) {
    return renderResult(context, await marketplaceCommand(command.handler, request));
  }
  const result = await environmentCommand(command.handler, request);
  if (result) return renderResult(context, result);
  failUsage(`Unknown command: ${intent.path.join(" ")}; run skillsenv help`);
}

export { VERSION };
