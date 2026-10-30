import { parentPort, workerData } from "node:worker_threads";
import { ExtensionOwner } from "../../src/modes/rpc/extension-owner.ts";

const owner = new ExtensionOwner(workerData);
parentPort.on("message", (command) => {
	if (command === "detach") {
		owner.retire();
		parentPort.postMessage({ type: "detached", aborted: owner.context.disconnectSignal.aborted });
		return;
	}
	let dispatched = 0;
	try {
		owner.context.admit(() => { dispatched++; });
		parentPort.postMessage({ type: "result", dispatched, aborted: owner.context.disconnectSignal.aborted });
	} catch (error) {
		parentPort.postMessage({
			type: "result",
			dispatched,
			aborted: owner.context.disconnectSignal.aborted,
			error: error.name,
		});
	}
});
parentPort.postMessage({ type: "ready" });
