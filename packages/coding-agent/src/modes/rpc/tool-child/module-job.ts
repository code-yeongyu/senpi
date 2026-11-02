/**
 * The `module` job kind (senpi#3566, plan todo 4; the contract todo 8's `ctx.offload` reuses unchanged).
 *
 * Wire shape: `{ modulePath, export, args }`. The child loads `modulePath` in a gated job worker and calls the named
 * export with `args`; the result must be structured-cloneable. `modulePath` must resolve - after realpath - inside one
 * of the installed extension directories the server granted this child at spawn (`SENPI_TOOL_CHILD_MODULE_ROOTS`), so a
 * job can never name an arbitrary file.
 */
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { Worker } from "node:worker_threads";
import type { ToolChildJobContext } from "./entry.ts";
import { ToolChildJobError } from "./entry.ts";
import { siblingWorkerUrl, startGatedWorker } from "./gated-worker.ts";
import { HOST_CALL_KINDS, type HostCallKind } from "./protocol.ts";

export const MODULE_JOB_KIND = "module";
export const TOOL_CHILD_MODULE_ROOTS_ENV = "SENPI_TOOL_CHILD_MODULE_ROOTS";

export interface ModuleJobArgs {
	readonly modulePath: string;
	readonly export: string;
	readonly args: unknown;
}

export function parseModuleJobArgs(value: unknown): ModuleJobArgs {
	if (typeof value !== "object" || value === null)
		throw new ToolChildJobError("module_job_invalid", "args must be an object");
	const modulePath = Reflect.get(value, "modulePath");
	const exportName = Reflect.get(value, "export");
	if (typeof modulePath !== "string" || !isAbsolute(modulePath))
		throw new ToolChildJobError("module_job_invalid", "modulePath must be an absolute path");
	if (typeof exportName !== "string" || exportName.length === 0)
		throw new ToolChildJobError("module_job_invalid", "export must be a non-empty string");
	return { modulePath, export: exportName, args: Reflect.get(value, "args") };
}

export function parseModuleRoots(env: NodeJS.ProcessEnv): readonly string[] {
	const raw = env[TOOL_CHILD_MODULE_ROOTS_ENV];
	if (raw === undefined || raw === "") return [];
	const parsed: unknown = JSON.parse(raw);
	if (!Array.isArray(parsed) || !parsed.every((root) => typeof root === "string" && isAbsolute(root)))
		throw new ToolChildJobError(
			"module_job_invalid",
			`${TOOL_CHILD_MODULE_ROOTS_ENV} must be a JSON array of absolute paths`,
		);
	return parsed;
}

function realpathOrUndefined(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/** The module's realpath when it is a granted file or lies inside a granted directory (both realpath'd); otherwise refused. */
export function containedModulePath(modulePath: string, roots: readonly string[]): string {
	const resolved = realpathOrUndefined(modulePath);
	if (resolved === undefined)
		throw new ToolChildJobError("offload_module_unavailable", `${modulePath} does not exist`);
	for (const root of roots) {
		const realRoot = realpathOrUndefined(root);
		if (realRoot === undefined) continue;
		// A granted file is granted exactly; a granted directory grants what is strictly inside it.
		if (resolved === realRoot && statSync(resolved).isFile()) return resolved;
		const inside = relative(realRoot, resolved);
		if (inside !== "" && !inside.startsWith(`..${sep}`) && inside !== ".." && !isAbsolute(inside)) return resolved;
	}
	throw new ToolChildJobError(
		"module_job_outside_roots",
		`${modulePath} is not inside an installed extension directory`,
	);
}

/** How long a cancelled module body may take to settle on its own before its worker is ended. */
export const MODULE_CANCEL_GRACE_MS = 2_000;

export function createModuleJobHandler(env: NodeJS.ProcessEnv = { ...process.env }) {
	return async (value: unknown, context: ToolChildJobContext): Promise<unknown> => {
		const job = parseModuleJobArgs(value);
		const modulePath = containedModulePath(job.modulePath, parseModuleRoots(env));
		const worker = startGatedWorker(
			context.gate,
			siblingWorkerUrl("./module-job-worker.ts", import.meta.url),
			context.jobId,
			{
				workerData: { modulePath, exportName: job.export, args: job.args },
			},
		);
		// A cancel reaches the body as an aborted signal; a body that has not settled within the grace is ended with its
		// worker. Either way the job fails tool_child_cancelled and the owned groups it still runs are ended.
		let cancelled = false;
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		const locks = new JobFileLocks(context);
		const abort = () => {
			cancelled = true;
			worker.postMessage({ kind: "cancel" });
			graceTimer = setTimeout(() => void worker.terminate(), MODULE_CANCEL_GRACE_MS);
		};
		context.signal.addEventListener("abort", abort, { once: true });
		try {
			const outcome = new Promise((resolve, reject) => {
				worker.on("message", (message: unknown) => {
					if (typeof message !== "object" || message === null) return;
					const kind = Reflect.get(message, "kind");
					if (kind === "host_call") {
						forwardHostCall(worker, context, locks, message);
						return;
					}
					if (kind === "module_result") resolve(Reflect.get(message, "value"));
					else if (kind === "module_error")
						reject(
							new ToolChildJobError(
								String(Reflect.get(message, "code")),
								String(Reflect.get(message, "message")),
							),
						);
				});
				worker.once("error", (error: unknown) =>
					reject(
						new ToolChildJobError("module_job_failed", error instanceof Error ? error.message : String(error)),
					),
				);
				worker.once("exit", (code) =>
					reject(new ToolChildJobError("module_job_failed", `worker exited (${code})`)),
				);
			});
			try {
				return await outcome;
			} catch (error) {
				if (!cancelled) throw error;
				throw new ToolChildJobError("tool_child_cancelled", "the job was cancelled");
			}
		} finally {
			context.signal.removeEventListener("abort", abort);
			clearTimeout(graceTimer);
			// The worker is stopped before its locks are released: no write it started can still be running (drain first).
			await worker.terminate();
			if (cancelled) context.gate.endJobGroups(context.jobId);
			await locks.releaseAll();
		}
	};
}

/**
 * The file locks one module job holds on the server. Lock and unlock calls outlive the job's cancel (the server cancels
 * a still-waiting lock when the job ends); a lock granted after the job closed is released at once, so none is held
 * by a job that can no longer release it.
 */
class JobFileLocks {
	readonly #context: ToolChildJobContext;
	readonly #held = new Set<string>();
	#closed = false;

	constructor(context: ToolChildJobContext) {
		this.#context = context;
	}

	/** Records a granted lock; false when the job has closed and the lock was released instead. */
	granted(lockId: string): boolean {
		if (!this.#closed) {
			this.#held.add(lockId);
			return true;
		}
		void this.#unlock(lockId);
		return false;
	}

	released(lockId: string): void {
		this.#held.delete(lockId);
	}

	/** After the worker has stopped: releases every lock it still holds. */
	async releaseAll(): Promise<void> {
		this.#closed = true;
		const held = [...this.#held];
		this.#held.clear();
		// A release the server cannot take (the channel closed) is covered by its release on the child's exit.
		await Promise.allSettled(held.map((lockId) => this.#unlock(lockId)));
	}

	#unlock(lockId: string): Promise<unknown> {
		return this.#context.hostCall({ kind: "unlock_file", args: { lockId } }, { survivesCancel: true });
	}
}

/** A host call from the module's worker, forwarded over the reverse bridge; the reply goes back to that worker. */
function forwardHostCall(worker: Worker, context: ToolChildJobContext, locks: JobFileLocks, message: object): void {
	const callId = Reflect.get(message, "callId");
	const kind = Reflect.get(message, "hostKind");
	const name = Reflect.get(message, "name");
	if (typeof callId !== "string" || !isHostCallKind(kind)) return;
	const args: unknown = Reflect.get(message, "args");
	const lockCall = kind === "lock_file" || kind === "unlock_file";
	context
		.hostCall(
			{ kind, ...(typeof name === "string" ? { name } : {}), ...(args === undefined ? {} : { args }) },
			{ survivesCancel: lockCall },
		)
		.then(
			(value) => {
				const lockId: unknown =
					typeof value === "object" && value !== null ? Reflect.get(value, "lockId") : undefined;
				if (kind === "lock_file" && typeof lockId === "string" && !locks.granted(lockId)) return;
				if (kind === "unlock_file") {
					const released: unknown =
						typeof args === "object" && args !== null ? Reflect.get(args, "lockId") : undefined;
					if (typeof released === "string") locks.released(released);
				}
				worker.postMessage({ kind: "host_reply", callId, value });
			},
			(error: unknown) =>
				worker.postMessage({
					kind: "host_reply",
					callId,
					error: error instanceof Error ? error.message : String(error),
					code: error instanceof ToolChildJobError ? error.code : "host_call_failed",
				}),
		);
}

function isHostCallKind(value: unknown): value is HostCallKind {
	return typeof value === "string" && HOST_CALL_KINDS.some((kind) => kind === value);
}
