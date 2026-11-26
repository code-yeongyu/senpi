// Calls go through the module object: Bun does not re-bind named built-in imports after the first link,
// so an OS failure injected with syncBuiltinESMExports reaches this read path only by property access.
import fs from "node:fs";
import { Worker } from "node:worker_threads";
import { INTERNAL_KEY_STDIN_ENV } from "./host-identity-env.ts";

const INTERNAL_KEY_DEADLINE_MS = 2000;
// Runs on its own thread: a launcher that keeps stdin open without sending the key leaves the main thread blocked in
// read(2) (child stdio is a blocking socketpair and neither runtime can make it non-blocking), so only another thread can
// enforce the bound. Its script reports readiness before waiting for release or the deadline. This signal does not
// fence unrelated runtime descriptor allocations. The release comes only after fd 0 is /dev/null
// again: on release the worker exits, and its exit opens files (the compile-cache flush under NODE_COMPILE_CACHE), so a
// release before the restore let that open take the free fd 0 and failed the host (senpi#4528).
const KEY_DEADLINE_WORKER = `const { workerData } = require("node:worker_threads");
const state = new Int32Array(workerData.state);
Atomics.store(state, 1, 1);
Atomics.notify(state, 1);
if (Atomics.wait(state, 0, 0, workerData.ms) === "timed-out") {
	require("node:fs").writeSync(2, "senpi rpc host: internal_key_unavailable: no key within " + workerData.ms + "ms\\n");
	process.kill(process.pid, "SIGKILL");
}`;

const KEY_DEADLINE_WORKER_START_MS = 5000;

// Slot 0: the main thread released the worker. Slot 1: the worker script reported readiness.
interface KeyDeadline {
	/** Waits, bounded, for script readiness; refuses an unconfirmed state before stdin is closed. */
	parked(): void;
	/** Lets the worker go: it exits, and its exit may open files, so this follows the fd 0 restore. */
	release(): void;
}

function armKeyDeadline(): KeyDeadline {
	const state = new Int32Array(new SharedArrayBuffer(8));
	new Worker(KEY_DEADLINE_WORKER, {
		eval: true,
		workerData: { state: state.buffer, ms: INTERNAL_KEY_DEADLINE_MS },
	}).unref();
	return {
		parked: () => {
			Atomics.wait(state, 1, 0, KEY_DEADLINE_WORKER_START_MS);
			// The flag is authoritative, including when it becomes ready as the bounded wait times out.
			if (Atomics.load(state, 1) !== 1) throw new Error("internal_key_unavailable: deadline worker not ready");
		},
		release: () => {
			Atomics.store(state, 0, 1);
			Atomics.notify(state, 0);
		},
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
	const keyWorker = armKeyDeadline();
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
	// Runs on success and failure alike: descendants must inherit /dev/null, never the key pipe. fd 0 is free between
	// the close and the open, and the lowest free descriptor goes to whichever thread opens next. Require this Worker's
	// readiness before the swap and release it only after restoration; unrelated allocators remain a separate race.
	keyWorker.parked();
	fs.closeSync(0);
	const restored = fs.openSync("/dev/null", "r");
	keyWorker.release();
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
