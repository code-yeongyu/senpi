import { createConnection, Server } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCoordinatorProcess } from "../../src/experimental/coordinator.ts";
import { consumeInternalProcessRole } from "../../src/experimental/process.ts";

/**
 * Coordinator entry that holds the coordinator's SECOND socket listen until the test releases it.
 * When it holds, it reports `{ held: <path> }` over the gate socket named by
 * SENPI_TEST_COORDINATOR_GATE; on any reply it performs the listen and answers `{ listening: <path> }`
 * once that socket is listening. This freezes the coordinator exactly between its two socket
 * publications, so a test can observe which socket is reachable in that window.
 */
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const role = consumeInternalProcessRole();
	if (role !== "coordinator") throw new Error("Coordinator listen gate requires a coordinator invocation");
	const requestedGatePath = process.env.SENPI_TEST_COORDINATOR_GATE;
	if (!requestedGatePath) throw new Error("SENPI_TEST_COORDINATOR_GATE is required");
	const gatePath: string = requestedGatePath;
	const originalListen = Server.prototype.listen;
	let listenCalls = 0;
	function gatedListen(this: Server, ...args: unknown[]): Server {
		listenCalls += 1;
		if (listenCalls !== 2) return Reflect.apply(originalListen, this, args);
		const path = args[0];
		const gate = createConnection(gatePath);
		gate.once("connect", () => gate.write(`${JSON.stringify({ held: path })}\n`));
		gate.once("data", () => {
			this.once("listening", () => gate.end(`${JSON.stringify({ listening: path })}\n`));
			Reflect.apply(originalListen, this, args);
		});
		return this;
	}
	Object.defineProperty(Server.prototype, "listen", { value: gatedListen, configurable: true, writable: true });
	void runCoordinatorProcess(process.argv.slice(2)).catch((error: unknown) => {
		console.error(error);
		process.exit(1);
	});
}
