import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { isBunBinary } from "../../config.ts";
import { ownProcessStartedAtMs } from "../../core/extensions/builtin/terminal/process-identity.ts";
import type { createWebViewBroker } from "../../core/webview/webview-broker.ts";
import { sessionWorkerDataRegistry } from "./session-worker-data.ts";

/** Bun wrapper builders define the worker entry name relative to their explicit --root. */
declare const SENPI_RPC_SESSION_WORKER_ENTRY: string | undefined;
const compiledWorkerEntry =
	typeof SENPI_RPC_SESSION_WORKER_ENTRY === "string"
		? SENPI_RPC_SESSION_WORKER_ENTRY
		: "./src/modes/rpc/session-worker.ts";

export function startSessionWorker(webviewBroker: ReturnType<typeof createWebViewBroker>) {
	return sessionWorkerDataRegistry.spawn(
		(issued) =>
			new Worker(
				isBunBinary
					? fileURLToPath(new URL(compiledWorkerEntry, import.meta.url)).replaceAll("\\", "/")
					: new URL(
							import.meta.url.endsWith(".ts") ? "./session-worker.ts" : "./session-worker.js",
							import.meta.url,
						),
				{
					workerData: {
						hostProcessStartedAtMs: ownProcessStartedAtMs(),
						extensionData: issued.extensionData,
						...(webviewBroker ? { webviewBroker: webviewBroker.port } : {}),
					},
					transferList: [...(webviewBroker ? [webviewBroker.port] : []), ...issued.transfer],
				},
			),
	);
}
