import net from "node:net";
import { mock } from "node:test";
import { type HostActivity, IdleExitDecider, runHostSupervisor } from "../../src/modes/rpc/host-lifecycle.ts";
import { HOST_IDLE_EXIT_MS_ENV } from "../../src/modes/rpc/host-lifecycle-policy.ts";

// Drive the real supervisor's clock and timer independently of socket I/O. The
// child runs in its own process, with the normal clock and transport implementation.
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
// Observe the supervisor's server through the event it emits. Replacing `net.createServer` reaches the
// supervisor's named `createServer` import only through Node's `syncBuiltinESMExports`, which Bun does not
// implement, so under Bun no hook was installed and every case waited for a `ready` that never came.
const emit = net.Server.prototype.emit;
mock.method(net.Server.prototype, "emit", function (this: net.Server, event: string | symbol, ...args: unknown[]) {
	const handled = emit.call(this, event, ...args);
	if (event === "listening") process.send?.({ type: "ready" });
	else if (event === "connection" && args[0] instanceof net.Socket) {
		// Register after the supervisor's own listener, so detached means its occupancy changed.
		args[0].once("close", () => process.send?.({ type: "detached" }));
		process.send?.({ type: "attached" });
	}
	return handled;
});
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
const socket = process.argv[2];
const agentDir = process.argv[3];
if (!socket || !agentDir) throw new Error("socket and agent directory required");
await runHostSupervisor({
	socket,
	agentDir,
	hostArgs: process.argv.slice(4),
});
