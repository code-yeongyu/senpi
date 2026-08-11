#!/usr/bin/env node
import { APP_NAME } from "./config.ts";
import { scrubBrandFromEnvironment } from "./core/brand.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { main } from "./main.ts";

process.title = `${APP_NAME}-rpc`;
scrubBrandFromEnvironment();
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

configureHttpDispatcher();

main(["--mode", "rpc", ...process.argv.slice(2)]);
