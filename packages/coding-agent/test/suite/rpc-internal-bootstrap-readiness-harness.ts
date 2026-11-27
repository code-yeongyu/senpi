import childProcess from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import net from "node:net";
import type { WorkerOptions } from "node:worker_threads";

// senpi#4839: only this subprocess fixture can hold the real Worker before its production script.
const mode = process.argv[2];
const hold = new Int32Array(new SharedArrayBuffer(8));
const threads: typeof import("node:worker_threads") = createRequire(import.meta.url)("node:worker_threads");
const OriginalWorker = threads.Worker;
const wait = Atomics.wait;
const notify = Atomics.notify;
const close = fs.closeSync;
const open = fs.openSync;
const spawn = childProcess.spawn;
const listen = net.Server.prototype.listen;
let state: Int32Array | undefined;
let workerExited: Promise<unknown> | undefined;
let worker: InstanceType<typeof OriginalWorker> | undefined;
let startupSignal: number | undefined;
let signalAtClose: number | undefined;
let applicationStarted = false;
let descendants = 0;
let listeners = 0;
const events: string[] = [];
const stdinNull = () => fs.fstatSync(0).isCharacterDevice() && fs.fstatSync(0).rdev === fs.statSync("/dev/null").rdev;

threads.Worker = class extends OriginalWorker {
	constructor(source: string | URL, options: WorkerOptions = {}) {
		state = new Int32Array(options.workerData.state);
		super(
			`const hold = new Int32Array(require("node:worker_threads").workerData.hold);
Atomics.store(hold, 1, 1);
Atomics.notify(hold, 1);
Atomics.wait(hold, 0, 0);
${source}`,
			{ ...options, workerData: { ...options.workerData, hold: hold.buffer } },
		);
		workerExited = once(this, "exit", { signal: AbortSignal.timeout(10_000) });
		worker = this;
	}
};
Atomics.wait = new Proxy(wait, {
	apply(target, receiver, args: unknown[]) {
		const [array, index] = args;
		if (!(array instanceof Int32Array) || array.buffer !== state?.buffer || index !== 1) {
			return Reflect.apply(target, receiver, args);
		}
		wait(hold, 1, 0, 5000);
		if (Atomics.load(hold, 1) !== 1) throw new Error("fixture Worker did not reach hold gate");
		if (!mode.startsWith("readiness-unready")) {
			Atomics.store(hold, 0, 1);
			notify(hold, 0);
			Reflect.apply(target, receiver, args);
			if (Atomics.load(array, index) !== 1) throw new Error("fixture Worker did not publish real readiness");
		}
		startupSignal = Atomics.load(array, index);
		// Never manufacture the readiness flag. Only the wait's return value is injected.
		return mode.endsWith("-ok") ? "ok" : "timed-out";
	},
});
Atomics.notify = new Proxy(notify, {
	apply(target, receiver, args: unknown[]) {
		const [array, index] = args;
		if (array instanceof Int32Array && array.buffer === state?.buffer && index === 0) {
			events.push(stdinNull() ? "release-null" : "release-not-null");
		}
		return Reflect.apply(target, receiver, args);
	},
});
fs.closeSync = (fd) => {
	if (fd === 0) {
		if (!state) throw new Error("fixture missing Worker state");
		signalAtClose = Atomics.load(state, 1);
		events.push("close");
	}
	return close(fd);
};
fs.openSync = (path, flags, permissions) => {
	if (path === "/dev/null" && mode === "readiness-restore-error") {
		throw Object.assign(new Error("fixture null open denied"), { code: "EACCES" });
	}
	const fd = open(path, flags, permissions);
	if (path === "/dev/null") events.push(fd === 0 ? "restore" : "restore-wrong-fd");
	return fd;
};
childProcess.spawn = new Proxy(spawn, {
	apply(target, receiver, args: unknown[]) {
		descendants += 1;
		return Reflect.apply(target, receiver, args);
	},
});
net.Server.prototype.listen = new Proxy(listen, {
	apply(target, receiver, args: unknown[]) {
		listeners += 1;
		return Reflect.apply(target, receiver, args);
	},
});
syncBuiltinESMExports();

let failure: unknown;
try {
	// Intentional lazy boundary: install fixture interception before linking the production bootstrap.
	const { getInternalHostBootstrap } = await import("../../src/modes/rpc/internal-bootstrap.ts");
	if (!getInternalHostBootstrap()) throw new Error("bootstrap not selected");
	applicationStarted = true;
	// Positive controls exercise the same listener/spawn instrumentation checked on the rejected path.
	const server = net.createServer();
	const listening = once(server, "listening");
	server.listen(0, "127.0.0.1");
	await listening;
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	const cat = childProcess.spawn("cat", [], { stdio: ["inherit", "ignore", "inherit"] });
	const [code] = await once(cat, "exit", { signal: AbortSignal.timeout(10_000) });
	if (code !== 0 || !stdinNull()) throw new Error("descendant did not inherit null stdin");
} catch (error) {
	failure = error;
}
const result = {
	type: failure === undefined ? "ready" : "failure",
	error: failure instanceof Error ? failure.message : undefined,
	startupSignal,
	signalAtClose,
	events,
	applicationStarted,
	descendants,
	listeners,
};
// Cleanup uses the originals, so it cannot be mistaken for the production release boundary.
Atomics.wait = wait;
Atomics.notify = notify;
fs.closeSync = close;
fs.openSync = open;
threads.Worker = OriginalWorker;
childProcess.spawn = spawn;
net.Server.prototype.listen = listen;
syncBuiltinESMExports();
if (workerExited && state) {
	worker?.ref();
	Atomics.store(state, 0, 1);
	notify(state, 0);
	Atomics.store(hold, 0, 1);
	notify(hold, 0);
	await workerExited;
}
process.send?.(result, () => process.exit(failure === undefined ? 0 : 1));
