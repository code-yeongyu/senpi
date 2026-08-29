#!/usr/bin/env node
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { APP_NAME } from "../config.ts";
import { SECURE_FILE_MONITOR_WORKER_FLAG } from "../core/extensions/builtin/terminal/secure-file-monitor-worker-source.ts";

if (process.argv[2] === SECURE_FILE_MONITOR_WORKER_FLAG) {
	const { runSecureFileMonitorWorkerChild } = await import(
		"../core/extensions/builtin/terminal/secure-file-monitor-worker-source.ts"
	);
	runSecureFileMonitorWorkerChild();
	await new Promise<never>(() => {});
}

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;

registerBunOAuthFlows();

import { restoreSandboxEnv } from "./restore-sandbox-env.ts";

restoreSandboxEnv();

await import("./register-bedrock.ts");
await import("./register-cursor-agent.ts");
await import("../cli-main.ts");
