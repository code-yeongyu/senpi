import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { isBunBinary } from "../../config.ts";
import { ownProcessStartedAtMs } from "../../core/extensions/builtin/terminal/process-identity.ts";
import type { createWebViewBroker } from "../../core/webview/webview-broker.ts";

/** Bun wrapper builders define the worker entry name relative to their explicit --root. */
declare const SENPI_RPC_SESSION_WORKER_ENTRY: string | undefined;
const compiledWorkerEntry =
	typeof SENPI_RPC_SESSION_WORKER_ENTRY === "string"
		? SENPI_RPC_SESSION_WORKER_ENTRY
		: "./src/modes/rpc/session-worker.ts";

export function startSessionWorker(webviewBroker: ReturnType<typeof createWebViewBroker>): Worker {
	return new Worker(
		isBunBinary
			? fileURLToPath(new URL(compiledWorkerEntry, import.meta.url)).replaceAll("\\", "/")
			: new URL(import.meta.url.endsWith(".ts") ? "./session-worker.ts" : "./session-worker.js", import.meta.url),
		{
			workerData: {
				hostProcessStartedAtMs: ownProcessStartedAtMs(),
				...(webviewBroker ? { webviewBroker: webviewBroker.port } : {}),
			},
			...(webviewBroker ? { transferList: [webviewBroker.port] } : {}),
		},
	);
}
