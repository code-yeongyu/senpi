/**
 * Process-wide replacement of `node:child_process` for extension code (senpi#3566, plan todo 4).
 *
 * The Bun extension importer resolves `node:child_process` / `child_process` - in an extension and in every module of
 * its graph, transitive dependencies included - to the virtual id below, which serves whatever module this process
 * installed. The server installs nothing, so extensions there get the real module, exactly as before. A tool child
 * installs the gated module before any extension loads, so a named import there passes the execution barrier too.
 * Bun forbids overriding the builtin's own name, which is why the redirect goes to a separate id.
 */
import realChildProcess from "node:child_process";
import { promisify } from "node:util";
import realWorkerThreads from "node:worker_threads";

export const GATED_CHILD_PROCESS_ID = "senpi-tool-child:child_process";

export const CHILD_PROCESS_REDIRECTS: Readonly<Record<string, string>> = {
	"node:child_process": GATED_CHILD_PROCESS_ID,
	child_process: GATED_CHILD_PROCESS_ID,
};

let installed: typeof realChildProcess = realChildProcess;

export function installChildProcessModule(module: typeof realChildProcess): void {
	installed = module;
}

/** The launch functions the gated module replaces; every other export is the builtin's own, untouched. */
export const CHILD_PROCESS_LAUNCH_FUNCTIONS = [
	"spawn",
	"spawnSync",
	"exec",
	"execSync",
	"execFile",
	"execFileSync",
	"fork",
] as const;

/**
 * The module object the virtual id serves. Bun snapshots an object module's named exports when it is first loaded, so
 * each launch function forwards to the module installed at call time - and so does its `util.promisify.custom`, which
 * `promisify(exec)` relies on for `{ stdout, stderr }`. Every other export (`ChildProcess` and the rest) is the
 * builtin's own object, so the export key set, classes and identities are those of `node:child_process`.
 */
export function childProcessVirtualModule(): Readonly<Record<string, unknown>> {
	const exports: Record<string, unknown> = { ...realChildProcess };
	for (const name of CHILD_PROCESS_LAUNCH_FUNCTIONS) {
		const forward = (...args: unknown[]) => Reflect.apply(Reflect.get(installed, name), installed, args);
		const custom: unknown = Reflect.get(realChildProcess[name], promisify.custom);
		if (typeof custom === "function")
			Object.defineProperty(forward, promisify.custom, {
				value: (...args: unknown[]) => {
					const target: unknown = Reflect.get(Reflect.get(installed, name), promisify.custom);
					if (typeof target !== "function") throw new TypeError(`child_process.${name} has no promisified form`);
					return Reflect.apply(target, installed, args);
				},
			});
		exports[name] = forward;
	}
	exports.default = exports;
	return exports;
}

export const GATED_WORKER_THREADS_ID = "senpi-tool-child:worker_threads";

export const WORKER_THREADS_REDIRECTS: Readonly<Record<string, string>> = {
	"node:worker_threads": GATED_WORKER_THREADS_ID,
	worker_threads: GATED_WORKER_THREADS_ID,
};

export class NestedWorkerRefusedError extends Error {
	readonly code = "tool_child_nested_worker_refused";
	constructor() {
		super(
			"tool_child_nested_worker_refused: a tool-child job worker cannot start worker threads of its own (their launches would bypass the execution barrier)",
		);
		this.name = "NestedWorkerRefusedError";
	}
}

/** The Worker a job worker sees: constructing it throws, so no thread outside the barrier ever starts. */
export function RefusedWorker(): never {
	throw new NestedWorkerRefusedError();
}

/** `node:worker_threads` for a job worker's module graph: the builtin's exports with `Worker` refused. */
export function workerThreadsVirtualModule(): Readonly<Record<string, unknown>> {
	const exports: Record<string, unknown> = { ...realWorkerThreads, Worker: RefusedWorker };
	exports.default = exports;
	return exports;
}
