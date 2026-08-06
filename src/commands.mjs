import { commandMayUseNetwork } from "./cli-contract.mjs";
import { renderHelp } from "./cli-help.mjs";
import { parseCli } from "./cli-parser.mjs";
import { createContext } from "./command-context.mjs";
import { environmentCommand } from "./environment-commands.mjs";
import { failUsage } from "./errors.mjs";
import { setOfflineMode } from "./io.mjs";
import {
  marketplaceCommand,
  MARKETPLACE_HANDLERS,
} from "./marketplace-commands.mjs";

const VERSION = "0.4.0";

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
  // Set once per run; the egress guard in io.mjs reads it. A command whose
  // contract declares no network access is held offline even without --offline,
  // so `network: false` is enforced instead of merely documented.
  setOfflineMode(
    intent.options.offline === true ||
      (intent.kind === "command" &&
        !commandMayUseNetwork(intent.command, intent.options)),
  );
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
  // Membership comes from the handler map itself, so there is no second list of
  // command names to drift out of sync with the contract.
  if (Object.hasOwn(MARKETPLACE_HANDLERS, command.handler)) {
    return renderResult(context, await marketplaceCommand(command.handler, request));
  }
  const result = await environmentCommand(command.handler, request);
  if (result) return renderResult(context, result);
  failUsage(`Unknown command: ${intent.path.join(" ")}; run skillsenv help`);
}

export { VERSION };
