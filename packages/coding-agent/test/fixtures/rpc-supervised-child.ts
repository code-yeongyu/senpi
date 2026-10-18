/**
 * A host CHILD for a real lifecycle supervisor (`host-lifecycle.ts --child-command`): it listens on
 * the private hop the supervisor names last on argv, answers `get_protocol_info`, and runs the same
 * supervisor-lifetime watchdog and loop-lag watchdog the production host runs - so a test can stop,
 * stall or kill it and observe what the supervisor and its callers record, without booting a session
 * runtime. argv: <serverVersion> <capabilities> <behavior: answer|silent> ... --listen unix://<path>
 */
import { createServer } from "node:net";
import { HOST_GENERATION_ENV, HOST_INSTANCE_ID_ENV } from "../../src/modes/rpc/host-identity-env.ts";
import { armHostWatchdog, readHostWatchdogConfigFromBrandEnv } from "../../src/modes/rpc/host-watchdog.ts";
import { LoopLagWatchdog } from "../../src/modes/rpc/loop-lag-watchdog.ts";

const [serverVersion = "fixture-version", capabilities = "", behavior = "answer"] = process.argv.slice(2);
const listen = process.argv.at(-1) ?? "";
const socketPath = listen.startsWith("unix://") ? listen.slice("unix://".length) : listen;
if (socketPath === "") throw new Error("listen address required");

const server = createServer((socket) => {
	let buffer = "";
	socket.on("error", () => {});
	socket.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (behavior === "silent") continue;
			const request: unknown = JSON.parse(line);
			const id = typeof request === "object" && request !== null ? Reflect.get(request, "id") : undefined;
			const data = {
				protocolVersion: 1,
				serverVersion,
				capabilities: capabilities.split(",").filter(Boolean),
				mode: "multi",
				instanceId: process.env[HOST_INSTANCE_ID_ENV],
				generation: Number(process.env[HOST_GENERATION_ENV] ?? "0"),
			};
			socket.write(
				`${JSON.stringify({ id, type: "response", command: "get_protocol_info", success: true, data })}\n`,
			);
		}
	});
});
server.listen(socketPath);

const loopLag = new LoopLagWatchdog({ emit: () => {}, log: () => {} });
loopLag.start();
armHostWatchdog(readHostWatchdogConfigFromBrandEnv(), () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
// A drain request ends no work here: the fixture has none.
process.on("SIGUSR1", () => {});
