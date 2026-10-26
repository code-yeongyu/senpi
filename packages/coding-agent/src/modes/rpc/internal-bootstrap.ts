// Calls go through the module object: Bun does not re-bind named built-in imports after the first link,
// so an OS failure injected with syncBuiltinESMExports reaches this read path only by property access.
import fs from "node:fs";
import { Worker } from "node:worker_threads";

const INTERNAL_KEY_STDIN_ENV = "SENPI_RPC_INTERNAL_KEY_STDIN";
const INTERNAL_KEY_DEADLINE_MS = 2000;
// Runs on its own thread: a launcher that keeps stdin open without sending the key leaves the main thread blocked in
// read(2) (child stdio is a blocking socketpair and neither runtime can make it non-blocking), so only another thread can
// enforce the bound. It stops as soon as the main thread reports the read finished. Its first statement reports that
// its startup (event loop, descriptors) is complete, so the main thread never frees fd 0 while this thread may still
// claim the lowest free descriptor.
const KEY_DEADLINE_WORKER = `const { workerData } = require("node:worker_threads");
const state = new Int32Array(workerData.state);
Atomics.store(state, 1, 1);
Atomics.notify(state, 1);
if (Atomics.wait(state, 0, 0, workerData.ms) === "timed-out") {
	require("node:fs").writeSync(2, "senpi rpc host: internal_key_unavailable: no key within " + workerData.ms + "ms\\n");
	process.kill(process.pid, "SIGKILL");
}`;

const KEY_DEADLINE_WORKER_START_MS = 5000;

// Slot 0: the read finished. Slot 1: the worker finished starting.
function armKeyDeadline(): () => void {
	const state = new Int32Array(new SharedArrayBuffer(8));
	new Worker(KEY_DEADLINE_WORKER, {
		eval: true,
		workerData: { state: state.buffer, ms: INTERNAL_KEY_DEADLINE_MS },
	}).unref();
	return () => {
		Atomics.store(state, 0, 1);
		Atomics.notify(state, 0);
		// Bounded: a worker that never starts cannot hold the host; the restore check below still guards fd 0.
		Atomics.wait(state, 1, 0, KEY_DEADLINE_WORKER_START_MS);
	};
}
export interface InternalHostBootstrap {
	readonly key: Buffer;
	readonly lifetimeFd?: number;
}

function bootstrap(): InternalHostBootstrap | undefined {
	if (process.platform === "win32" || process.env[INTERNAL_KEY_STDIN_ENV] !== "1") return undefined;
	// Launchers forward stdin; only the engine consumes it. Descendants must never bootstrap again.
	delete process.env[INTERNAL_KEY_STDIN_ENV];
	const key = Buffer.alloc(32);
	const deadline = Date.now() + INTERNAL_KEY_DEADLINE_MS;
	const readFinished = armKeyDeadline();
	const pause = new Int32Array(new SharedArrayBuffer(4));
	let offset = 0;
	let lifetimeFd: number | undefined;
	let failure: unknown;
	try {
		while (offset < key.length) {
			if (Date.now() >= deadline) throw new Error("internal_key_unavailable");
			try {
				const n = fs.readSync(0, key, offset, key.length - offset, null);
				if (n === 0) throw new Error("internal_key_unavailable");
				offset += n;
			} catch (cause) {
				if (cause instanceof Error && "code" in cause && cause.code === "EAGAIN") {
					Atomics.wait(pause, 0, 0, 5);
					continue;
				}
				throw new Error("internal_key_unavailable", { cause });
			}
		}
		try {
			// close-on-exec: descendants inherit only restored /dev/null, never this lifetime fd.
			lifetimeFd = fs.openSync("/dev/fd/0", "r");
		} catch {
			// Linux socketpair stdin returns ENXIO. Every reopen failure has the same safe fallback.
			process.stderr.write("senpi rpc host: stdin lifetime reopen unavailable; using supervisor identity poll\n");
		}
	} catch (cause) {
		failure = cause;
	}
	readFinished();
	// Runs on success and failure alike: descendants must inherit /dev/null, never the key pipe.
	fs.closeSync(0);
	const restored = fs.openSync("/dev/null", "r");
	// Fatal by design: a host whose fd 0 is not /dev/null would hand the key pipe to every descendant, so it refuses
	// to start rather than run with stdin it cannot account for.
	if (restored !== 0) throw new Error("internal_key_unavailable: cannot restore stdin");
	if (failure !== undefined) throw failure;
	return { key, ...(lifetimeFd === undefined ? {} : { lifetimeFd }) };
}

// Imported before the CLI graph can instantiate process.stdin.
const internalHostBootstrap = bootstrap();
export function getInternalHostBootstrap(): InternalHostBootstrap | undefined {
	return internalHostBootstrap;
}
