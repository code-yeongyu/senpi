/** Real supervisor/host, with only the supervisor clock and OS-watch failure controlled by the test. */
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { mock } from "node:test";
import { callerHostOwner } from "../../src/modes/rpc/host-daemon-state.ts";
import { runHostSupervisor } from "../../src/modes/rpc/host-lifecycle.ts";
import { type SupervisorActivity, SupervisorOwner } from "../../src/modes/rpc/host-lifecycle-activity.ts";

const [mode, socket, agentDir, generationDir, ownerPid, watchMode] = process.argv.slice(2);
if (mode === "owner") {
	process.send?.({ type: "owner", owner: await callerHostOwner() });
	process.on("message", () => process.disconnect?.());
} else {
	if (!socket || !agentDir || !generationDir) throw new Error("supervisor paths required");
	let now = 0;
	let tick: (() => void) | undefined;
	mock.method(performance, "now", () => now);
	const interval = globalThis.setInterval;
	mock.method(globalThis, "setInterval", (callback: () => void, ms: number) => {
		if (ms !== 1_000 || tick !== undefined) return interval(callback, ms);
		tick = callback;
		return interval(() => {}, 2_147_483_647);
	});
	const watch = fs.watch;
	mock.method(fs, "watch", (...args: Parameters<typeof fs.watch>) => {
		if (String(args[0]) === generationDir) {
			process.send?.({ type: "watch" });
			if (watchMode === "throw") throw Object.assign(new Error("watch capacity exhausted"), { code: "ENOSPC" });
		}
		return watch(...args);
	});
	const execFile = childProcess.execFile;
	mock.method(childProcess, "execFile", (...args: Parameters<typeof childProcess.execFile>) => {
		if (args[0] === "ps" && Array.isArray(args[1]) && args[1].at(-1) === ownerPid) {
			process.send?.({ type: "probe", now });
		}
		return execFile(...args);
	});
	const spawn = childProcess.spawn;
	mock.method(childProcess, "spawn", (...args: Parameters<typeof childProcess.spawn>) => {
		const child = spawn(...args);
		process.send?.({ type: "host", pid: child.pid });
		return child;
	});
	const createServer = net.createServer;
	mock.method(net, "createServer", (accept: (peer: net.Socket) => void) => {
		const server = createServer((peer) => {
			accept(peer);
			peer.once("close", () => process.send?.({ type: "detached" }));
		});
		server.once("listening", () => process.send?.({ type: "ready" }));
		return server;
	});
	syncBuiltinESMExports();
	const check = SupervisorOwner.prototype.shouldExit;
	mock.method(
		SupervisorOwner.prototype,
		"shouldExit",
		async function (this: SupervisorOwner, activity: SupervisorActivity) {
			const exit = await check.call(this, activity);
			process.send?.({ type: "checked", now, exit });
			return exit;
		},
	);
	process.on("message", (message: unknown) => {
		if (typeof message !== "object" || message === null || !("now" in message) || typeof message.now !== "number") {
			throw new Error("clock requires now");
		}
		now = message.now;
		if ("tick" in message && message.tick === true) {
			if (!tick) throw new Error("lifecycle ticker missing");
			tick();
		} else process.send?.({ type: "clock", now });
	});
	await runHostSupervisor({ socket, agentDir, hostArgs: ["--no-extensions", "--no-skills", "--no-prompt-templates"] });
}
