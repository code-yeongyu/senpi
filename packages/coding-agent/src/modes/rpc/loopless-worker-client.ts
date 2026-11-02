import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { isBunBinary } from "../../config.ts";
import type { CliRuntimeConfiguration } from "../../main.ts";
import type { HostToLooplessWorker, LooplessWorkerToHost } from "./loopless-worker-protocol.ts";

/** The host's side of one loopless worker isolate (senpi#5413): start it in a cwd, then close it. */
export interface LooplessWorker {
	readonly exited: Promise<void>;
	start(configuration: CliRuntimeConfiguration, cwd: string): Promise<readonly string[]>;
	close(): Promise<void>;
}

function looplessWorkerEntry(): string | URL {
	return isBunBinary
		? fileURLToPath(new URL("./src/modes/rpc/loopless-worker.ts", import.meta.url)).replaceAll("\\", "/")
		: new URL(import.meta.url.endsWith(".ts") ? "./loopless-worker.ts" : "./loopless-worker.js", import.meta.url);
}

export function startLooplessWorker(): LooplessWorker {
	const worker = new Worker(looplessWorkerEntry());
	const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
	const post = (message: HostToLooplessWorker): void => worker.postMessage(message);
	return {
		exited,
		start: (configuration, cwd) =>
			new Promise<readonly string[]>((resolve, reject) => {
				const onMessage = (message: LooplessWorkerToHost): void => {
					worker.off("message", onMessage);
					if (message.type === "ready") resolve(message.tools);
					else reject(new Error(message.error));
				};
				worker.on("message", onMessage);
				void exited.then(() => reject(new Error("loopless_worker_exited")));
				post({ type: "start", configuration, cwd });
			}),
		close: async () => {
			post({ type: "close" });
			await exited;
		},
	};
}
