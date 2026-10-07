#!/usr/bin/env bun
/**
 * One cell of the host zombie matrix: a process that spawns children through a
 * chosen API, from a chosen thread, under a chosen lifecycle, then holds still
 * so the driver can count its Z-state children from outside.
 *
 * The probe models the HOST PROCESS of the shared RPC daemon: an extension that
 * creates a `worker_threads` Worker gets a thread of this process, exactly like
 * `session-worker-client.ts`'s session worker, and children spawned from that
 * thread are children of this process either way.
 *
 * It runs unchanged under `bun <this file>`, `node <this file>` (node API only)
 * and as a `bun build --compile` executable - the worker entry is this same file
 * re-entered through `import.meta.url`, which bun embeds into the executable.
 *
 * Protocol (stdout, line based): `PID=<pid>` first, then `MSG:<marker>` per
 * lifecycle milestone, then `READY`. The probe exits when its stdin receives any
 * byte, so the driver decides when the measurement window closes.
 *
 * `--reaper-ms <ms>` arms the real host reaper (`src/modes/rpc/child-reaper.ts`)
 * on the probe's main thread with that window, which is how the matrix measures
 * both what the reaper cleans up and what it must never steal.
 */
import { execSync, spawn as nodeSpawn } from "node:child_process";
import { isMainThread, parentPort, Worker } from "node:worker_threads";

const flag = (name, fallback) => {
	const index = process.argv.indexOf(name);
	return index === -1 ? fallback : process.argv[index + 1];
};
const api = flag("--api", "node");
const kase = flag("--case", "steady");
const count = Number(flag("--count", "20"));
const blockMs = Number(flag("--block-ms", "12000"));
const liveMs = Number(flag("--live-ms", "1500"));
const hasBun = typeof Bun !== "undefined";

/** Starts one child through the API under test and resolves with its exit code. */
function startChild(command, args) {
	if (api === "node") {
		const child = nodeSpawn(command, args, { stdio: "ignore" });
		return new Promise((resolve, reject) => {
			child.once("exit", (code) => resolve(code));
			child.once("error", reject);
		});
	}
	if (api === "bun-spawn") {
		return Bun.spawn([command, ...args], { stdout: "ignore", stderr: "ignore" }).exited;
	}
	// `Bun.$` is lazy: the command starts when the promise is consumed, so every
	// caller below attaches a handler even when it ignores the result.
	return Bun.$`${command} ${{ raw: args.map((arg) => `'${arg}'`).join(" ") }}`
		.quiet()
		.nothrow()
		.then((result) => result.exitCode);
}

/** Starts a child without awaiting it, the way an unhandled tool spawn behaves. */
function fireChild(command, args) {
	const exited = startChild(command, args);
	exited.then(
		() => {},
		() => {},
	);
	return exited;
}

async function runCase(post) {
	if (kase === "steady") {
		for (let index = 0; index < count; index++) await startChild("/usr/bin/true", []);
		post("done");
		return;
	}
	if (kase === "terminate-live") {
		for (let index = 0; index < count; index++) fireChild("/bin/sh", ["-c", `sleep ${liveMs / 1000}`]);
		post("spawned");
		return;
	}
	if (kase === "terminate-after-exit") {
		for (let index = 0; index < count; index++) fireChild("/usr/bin/true", []);
		post("spawned");
		return;
	}
	if (kase === "blocked-sync") {
		const exited = fireChild("/bin/sh", ["-c", "sleep 1; exit 7"]);
		exited.then(
			(code) => post(`childExit=${code}`),
			(cause) => post(`childError=${cause}`),
		);
		post("spawned");
		execSync(`sleep ${blockMs / 1000}`);
		post("unblocked");
		return;
	}
	throw new Error(`unknown --case ${kase}`);
}

/** Arms the real host reaper in this process, exactly as a socket host does. */
async function armReaper(minWaitableMs) {
	const { createChildReaper } = await import("../../src/modes/rpc/child-reaper.ts");
	const { loadChildReaperSyscalls } = await import("../../src/modes/rpc/child-reaper-syscalls.ts");
	const syscalls = await loadChildReaperSyscalls();
	if (syscalls === undefined) {
		process.stdout.write("MSG:reaperUnavailable\n");
		return;
	}
	const reaper = createChildReaper({
		syscalls,
		minWaitableMs,
		log: (message) => process.stdout.write(`MSG:${message}\n`),
	});
	setInterval(() => reaper.tick(), 1_000).unref();
}

if (isMainThread) {
	process.stdout.write(`PID=${process.pid}\nRUNTIME=${hasBun ? "bun" : "node"}\n`);
	const reaperMs = flag("--reaper-ms", undefined);
	if (reaperMs !== undefined) await armReaper(Number(reaperMs));
	if (flag("--thread", "main") === "main") {
		await runCase((marker) => process.stdout.write(`MSG:${marker}\n`));
	} else {
		const worker = new Worker(new URL(import.meta.url), { argv: process.argv.slice(2) });
		worker.on("message", (marker) => process.stdout.write(`MSG:${marker}\n`));
		worker.on("error", (cause) => process.stdout.write(`MSG:workerError=${cause}\n`));
		await new Promise((resolve) => worker.once("message", resolve));
		if (flag("--terminate", "no") === "yes") {
			await worker.terminate();
			process.stdout.write("MSG:terminated\n");
		}
	}
	process.stdout.write("READY\n");
	process.stdin.on("data", () => process.exit(0));
	process.stdin.resume();
} else {
	await runCase((marker) => parentPort.postMessage(marker));
	await new Promise(() => {});
}
