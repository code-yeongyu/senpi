#!/usr/bin/env node
import "./valid-cwd.ts";
// Second: capture the private descriptor table before anything can spawn (senpi#4749).
import "./private-fds.ts";
// Third, and before anything that can touch process.stdin: the guards above only change directory and read env.
import "./modes/rpc/internal-bootstrap.ts";
import "./internal-role.ts";
import { enableStartupCompileCache } from "./compile-cache.ts";
import { APP_NAME } from "./config.ts";
import { scrubBrandFromEnvironment } from "./core/brand.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { installStaleExtensionContainment } from "./core/stale-extension-containment.ts";
import { installEarlyInspectorVmImportRecovery } from "./inspector-policy.ts";
import { dispatchAgentDirectoryCommand } from "./cli/agent-dir-command.ts";

await dispatchAgentDirectoryCommand(process.argv.slice(2));

// A direct `cli-main` invocation (the bun binary, `--inspect` runs, tests) has no launcher parent to
// inherit the cache from. Enabling it here is a no-op when cli.ts already published the directory.
await enableStartupCompileCache();

// Must precede the asynchronous bootstrap: with --inspect-brk, the recoverable Inspector
// import rejection can fire before interactive mode registers its own crash handler.
installEarlyInspectorVmImportRecovery();
// A retired extension ctx must never end a print, RPC or host process either (oh-my-openagent#7114).
installStaleExtensionContainment();

process.title = APP_NAME;
// The brand has been resolved for this process; nested engine runs must not inherit it.
scrubBrandFromEnvironment();
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

configureHttpDispatcher();

// Metadata commands exit above without importing the agent graph or opening any state.
const { main } = await import("./main.ts");
await main(process.argv.slice(2));
