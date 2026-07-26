#!/usr/bin/env node
import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { installEarlyInspectorVmImportRecovery } from "./inspector-policy.ts";
import { main } from "./main.ts";

// Must precede the asynchronous bootstrap: with --inspect-brk, the recoverable Inspector
// import rejection can fire before interactive mode registers its own crash handler.
installEarlyInspectorVmImportRecovery();

process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

configureHttpDispatcher();

await main(process.argv.slice(2));
