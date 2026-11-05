import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { mock } from "node:test";
import { type HostActivity, IdleExitDecider, runHostSupervisor } from "../../src/modes/rpc/host-lifecycle.ts";
import { HOST_IDLE_EXIT_MS_ENV } from "../../src/modes/rpc/host-lifecycle-policy.ts";

// Drive the real supervisor's clock and timer independently of socket I/O. The
// child runs in its own process, with the normal clock and transport implementation.
const socket = process.argv[2];
const agentDir = process.argv[3];
if (!socket || !agentDir) throw new Error("socket and agent directory required");
let now = 0;
let tick: (() => void) | undefined;
let shuttingDown = false;
let currentActivity: HostActivity | undefined;
let currentDecision: string | undefined;
const idleExitMs = Number(process.env[HOST_IDLE_EXIT_MS_ENV] ?? 800);
mock.method(Date, "now", () => now);
const setInterval = globalThis.setInterval;
mock.method(globalThis, "setInterval", (callback: () => void, interval: number) => {
	if (interval === Math.max(20, Math.min(1_000, idleExitMs / 4))) {
		tick = callback;
		return setInterval(() => {}, 2_147_483_647);
	}
	return setInterval(callback, interval);
});
const update = IdleExitDecider.prototype.update;
mock.method(IdleExitDecider.prototype, "update", function (this: IdleExitDecider, activity: HostActivity) {
	const decision = update.call(this, activity);
	if (this.idleExitMs === idleExitMs) {
		currentActivity = activity;
		currentDecision = decision;
		process.send?.({ type: "activity", activity, decision, now });
	}
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
	return server;
});
const link = fsPromises.link;
// The endpoint exists once the supervisor links its bound socket into place, not at "listening" (#5319).
mock.method(fsPromises, "link", async (...args: Parameters<typeof link>) => {
	await link(...args);
	if (args[1] === socket) process.send?.({ type: "ready" });
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
	process.send?.({ type: "clock", shuttingDown, activity: currentActivity, decision: currentDecision, now });
});
await runHostSupervisor({
	socket,
	agentDir,
	hostArgs: process.argv.slice(4),
});
