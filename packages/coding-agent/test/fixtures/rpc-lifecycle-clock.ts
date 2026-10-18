import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { mock } from "node:test";
import { type HostActivity, IdleExitDecider, runHostSupervisor } from "../../src/modes/rpc/host-lifecycle.ts";

// Drive the real supervisor's clock and timer independently of socket I/O. The
// child runs in its own process, with the normal clock and transport implementation.
let now = 0;
let tick: (() => void) | undefined;
let shuttingDown = false;
mock.method(Date, "now", () => now);
const setInterval = globalThis.setInterval;
mock.method(globalThis, "setInterval", (callback: () => void, interval: number) => {
	if (interval === 200) {
		tick = callback;
		return setInterval(() => {}, 2_147_483_647);
	}
	return setInterval(callback, interval);
});
const update = IdleExitDecider.prototype.update;
mock.method(IdleExitDecider.prototype, "update", function (this: IdleExitDecider, activity: HostActivity) {
	const decision = update.call(this, activity);
	if (decision === "exit") shuttingDown = true;
	return decision;
});
const createServer = net.createServer;
mock.method(net, "createServer", (accept: (socket: net.Socket) => void) => {
	const server = createServer((socket) => {
		accept(socket);
		// Register after the supervisor, so detached means its occupancy changed.
		socket.once("close", () => process.send?.({ type: "detached" }));
		process.send?.({ type: "attached" });
	});
	server.once("listening", () => process.send?.({ type: "ready" }));
	return server;
});
syncBuiltinESMExports();
process.on("message", (message: unknown) => {
	if (typeof message !== "object" || message === null || !("now" in message) || typeof message.now !== "number") {
		throw new Error("clock command requires now");
	}
	now = message.now;
	if ("tick" in message && message.tick === true) {
		if (!tick) throw new Error("supervisor timer not registered");
		tick();
	}
	process.send?.({ type: "clock", shuttingDown });
});
const socket = process.argv[2];
const agentDir = process.argv[3];
if (!socket || !agentDir) throw new Error("socket and agent directory required");
await runHostSupervisor({
	socket,
	agentDir,
	hostArgs: [],
});
