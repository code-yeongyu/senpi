#!/usr/bin/env node
import { APP_NAME } from "../config.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;

import { restoreSandboxEnv } from "./restore-sandbox-env.ts";
import { stripProjectDotenv } from "./strip-project-dotenv.ts";

restoreSandboxEnv();
stripProjectDotenv();

await import("./register-bedrock.ts");
await import("../cli-main.ts");
