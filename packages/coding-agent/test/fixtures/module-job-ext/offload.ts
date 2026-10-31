// A file-backed module the tool child's `module` job runs (senpi#3566 todo 4): plain named imports, no barrier code.
import { execFileSync as runOnce, spawn as spawnOwned, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync as appendLine,
	existsSync as markerExists,
	readFileSync as readText,
	watch as watchDir,
	writeFileSync as writeMarker,
} from "node:fs";
import { dirname } from "node:path";
import { Worker as NestedWorker } from "node:worker_threads";

export function whoAmI(args: { readonly code: number }): { pid: number; status: number | null } {
	return { pid: process.pid, status: spawnSync("sh", ["-c", `exit ${args.code}`]).status };
}

export const notAFunction = 1;

export async function sleepFor(args: { readonly ms: number }): Promise<{ slept: number }> {
	await new Promise((resolveSleep) => setTimeout(resolveSleep, args.ms));
	return { slept: args.ms };
}

/** Kills its tool child the first time (marker absent), succeeds after: a job lost to a child exit. */
export function dieOnce(args: { readonly marker: string }): { pid: number } {
	if (!markerExists(args.marker)) {
		writeMarker(args.marker, "died");
		process.kill(process.pid, "SIGKILL");
	}
	return { pid: process.pid };
}

/** Kills its tool child every time. */
export function dieAlways(): never {
	process.kill(process.pid, "SIGKILL");
	throw new Error("unreachable");
}

/** Launches `true` once through the gated child_process: one ledger entry per call. */
export function launchTrue(): { ok: true } {
	runOnce("true");
	return { ok: true };
}

interface FixtureHost {
	call(tool: string, args: unknown): Promise<unknown>;
}

/** One reverse-bridge call: returns what the server answered. */
export function askHost(
	args: { readonly tool: string; readonly payload: unknown },
	host: FixtureHost,
): Promise<unknown> {
	return host.call(args.tool, args.payload);
}

/** `n` concurrent reverse-bridge calls: how many succeeded and the codes of those that failed. */
export async function fanOut(
	args: { readonly n: number },
	host: FixtureHost,
): Promise<{ ok: number; failed: string[] }> {
	const settled = await Promise.allSettled(
		Array.from({ length: args.n }, (_unused, index) => host.call("count", { index })),
	);
	const failed = settled.flatMap((outcome) =>
		outcome.status === "rejected" ? [String(Reflect.get(Object(outcome.reason), "code") ?? outcome.reason)] : [],
	);
	return { ok: settled.length - failed.length, failed };
}

/** Sends `bytes` of arguments to the server: what the server received, and this side's own sha256 to compare. */
export async function sinkLarge(args: { readonly bytes: number }, host: FixtureHost): Promise<unknown> {
	const payload = "s".repeat(args.bytes);
	const reply = await host.call("sink", { payload });
	return { reply, sent: createHash("sha256").update(payload).digest("hex") };
}

/** Asks the server for a `bytes`-long reply and reports what arrived. */
export async function blobLarge(args: { readonly bytes: number }, host: FixtureHost): Promise<{ length: number }> {
	const reply = await host.call("blob", { bytes: args.bytes });
	return { length: typeof reply === "string" ? reply.length : -1 };
}

/** Settles only when the job is cancelled: proves the cancel reaches the body as an aborted signal. */
export function waitForCancel(_args: unknown, context: { readonly signal: AbortSignal }): Promise<{ aborted: true }> {
	return new Promise((resolveCancel) =>
		context.signal.addEventListener("abort", () => resolveCancel({ aborted: true }), { once: true }),
	);
}

/** Starts an owned own-group sleep (reporting its pid through a marker file), then never settles. */
export function ownedSleepThenHang(args: { readonly marker: string }): Promise<never> {
	const child = spawnOwned("/bin/sleep", ["300"], { stdio: "ignore" });
	writeMarker(args.marker, String(child.pid));
	return new Promise(() => {});
}

/** Tries to start a worker thread from a module job: returns the refusal code, or "started" if it was allowed. */
export async function startNestedWorker(): Promise<string> {
	try {
		const worker = new NestedWorker("export {}", { eval: true });
		await worker.terminate();
		return "started";
	} catch (error) {
		return String(Reflect.get(Object(error), "code") ?? error);
	}
}

interface LockingHost {
	withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T>;
	authorize(request: {
		operation: "read" | "enumerate" | "write";
		path: string;
		toolName: string;
	}): Promise<{ allow: true } | { allow: false; reason: string }>;
}

/** Resolves once `path` exists (watching its directory; no polling). */
function fileAppears(path: string): Promise<void> {
	return new Promise((resolveFile) => {
		const watcher = watchDir(dirname(path), () => {
			if (!markerExists(path)) return;
			watcher.close();
			resolveFile();
		});
		if (markerExists(path)) {
			watcher.close();
			resolveFile();
		}
	});
}

/**
 * Takes the file's lock, reports it holds it (`held` marker), then waits for `gate` before appending its line: a write
 * still in flight when the job is cancelled.
 */
export async function appendWhenGated(
	args: { readonly file: string; readonly line: string; readonly held: string; readonly gate: string },
	host: LockingHost,
): Promise<string> {
	return host.withFileLock(args.file, async () => {
		writeMarker(args.held, "");
		await fileAppears(args.gate);
		appendLine(args.file, `${args.line}\n`);
		return readText(args.file, "utf8");
	});
}

/** Appends its line under the file's lock and returns the file as it then reads. */
export async function appendLocked(
	args: { readonly file: string; readonly line: string },
	host: LockingHost,
): Promise<string> {
	return host.withFileLock(args.file, async () => {
		appendLine(args.file, `${args.line}\n`);
		return readText(args.file, "utf8");
	});
}

/** Asks the session's filesystem policy before a write; a denial fails the job with the policy's own reason. */
export async function writeIfAllowed(args: { readonly path: string }, host: LockingHost): Promise<string> {
	const decision = await host.authorize({ operation: "write", path: args.path, toolName: "write" });
	if (!decision.allow) throw new Error(decision.reason);
	return "allowed";
}

/** `n` concurrent large-argument calls at once (more than run at a time): settles only if every call does. */
export async function sinkMany(
	args: { readonly bytes: number; readonly n: number },
	host: FixtureHost,
): Promise<number> {
	const payload = "m".repeat(args.bytes);
	const replies = await Promise.all(Array.from({ length: args.n }, () => host.call("sink", { payload })));
	return replies.length;
}

/** The sha256 and size of a job's own `payload` argument (a large one arrives by reference). */
export function digestArgs(args: { readonly payload: string }): { sha256: string; bytes: number } {
	return { sha256: createHash("sha256").update(args.payload).digest("hex"), bytes: Buffer.byteLength(args.payload) };
}
