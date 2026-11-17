import { parentPort } from "node:worker_threads";
import "../../windows-power-throttling-startup.ts";
import { isBunBinary } from "../../config.ts";
import type { HostToLooplessWorker, LooplessWorkerToHost } from "./loopless-worker-protocol.ts";
import { createLooplessRuntimeFactory, type LooplessRuntime } from "./runtime-factory-loopless.ts";

if (isBunBinary) {
	const { registerBunRuntimeModules } = await import("../../bun/runtime-modules.ts");
	registerBunRuntimeModules();
}

const port = parentPort;
if (!port) throw new Error("Loopless worker requires a parent port");
const send = (message: LooplessWorkerToHost): void => port.postMessage(message);
let runtime: LooplessRuntime | undefined;

async function handle(message: HostToLooplessWorker): Promise<void> {
	switch (message.type) {
		case "start": {
			if (runtime) throw new Error("Loopless worker already started");
			runtime = await createLooplessRuntimeFactory(message.configuration)({ cwd: message.cwd });
			send({ type: "ready", tools: [...runtime.definitions.keys()] });
			return;
		}
		case "close":
			await runtime?.dispose();
			process.exit(0);
	}
}

port.on("message", (message: HostToLooplessWorker) => {
	void handle(message).catch((cause: unknown) => {
		send({ type: "failure", error: cause instanceof Error ? cause.message : String(cause) });
		process.exit(1);
	});
});
