#!/usr/bin/env node
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
import { APP_NAME } from "./config.js";
import { main } from "./main.js";
process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => { });
setGlobalDispatcher(new EnvHttpProxyAgent());
main(process.argv.slice(2));
//# sourceMappingURL=cli.js.map