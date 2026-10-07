import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { KernelToHostMessage } from "../../bridge/protocol.ts";
import { isKernelToHostMessage, parseBridgeJsonLine, validateBridgeMessage } from "../../bridge/protocol.ts";
import type { EvalRuntimeInfo } from "../../tool/types.ts";
import { type CodemodeRuntimeAssetEnvironment, requireCodemodeRuntimeAsset } from "../shared/runtime-asset.ts";
import { type SubprocessLike, SubprocessProcess, spawnSubprocess } from "../shared/subprocess-process.ts";
import type { WorkerLike } from "./inline-worker.ts";
import { JavaScriptWorkerExitedError } from "./worker-host.ts";

const PROCESS_CLOSE_GRACE_MS = 2_000;

export interface JavaScriptProcessEntryUrlOptions extends CodemodeRuntimeAssetEnvironment {
	readonly localPath?: string;
}

export function resolveJsProcessEntryUrl(options: JavaScriptProcessEntryUrlOptions = {}): URL {
	const localPath = options.localPath ?? join(dirname(fileURLToPath(import.meta.url)), "process-entry.js");
	return pathToFileURL(requireCodemodeRuntimeAsset(localPath, join("kernels", "js", "process-entry.js"), options));
}

export class JavaScriptProcessRuntimeUnavailableError extends Error {
	readonly name = "JavaScriptProcessRuntimeUnavailableError";
	readonly runtime: string;
	readonly searchPath: string;

	constructor(runtime: string, searchPath: string) {
		super(
			`JavaScript runtime is unavailable: no ${runtime} executable found on PATH${searchPath.length === 0 ? " (empty)" : ""}. Install bun or node, or use isolation.js: "worker".`,
		);
		this.runtime = runtime;
		this.searchPath = searchPath;
	}
}

export interface JavaScriptProcessWorkerOptions {
	readonly cwd: string;
	readonly parallelPoolWidth: number;
	readonly searchPath?: string;
	readonly execPath?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly spawn?: (
		command: string,
		args: readonly string[],
		options: { cwd?: string; env?: NodeJS.ProcessEnv },
	) => SubprocessLike;
}

export interface JavaScriptProcessWorker extends WorkerLike {
	readonly pid?: number;
}

/**
 * The runtime that runs the kernel child: the host's own runtime (bun when senpi runs on Bun, node otherwise), taken
 * from the host's executable when that is the runtime itself, else found on PATH, the host's runtime first.
 */
export function resolveJavaScriptProcessCommand(
	searchPath: string | undefined,
	platform: NodeJS.Platform = process.platform,
	hostRuntime: string = process.versions.bun === undefined ? "node" : "bun",
	execPath: string = process.execPath,
): string {
	const candidates = hostRuntime === "bun" ? ["bun", "node"] : ["node", "bun"];
	const extensions = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
	if (runtimeNameOf(execPath) !== undefined && isExecutable(execPath)) return execPath;
	const pathValue = searchPath ?? process.env.PATH ?? "";
	if (pathValue.trim().length === 0) throw new JavaScriptProcessRuntimeUnavailableError(hostRuntime, "");
	const directories = pathValue.split(platform === "win32" ? ";" : ":").filter((directory) => directory.length > 0);
	for (const name of candidates) {
		for (const directory of directories) {
			for (const extension of extensions) {
				const candidate = join(directory, `${name}${extension}`);
				if (isExecutable(candidate)) return candidate;
			}
		}
	}
	throw new JavaScriptProcessRuntimeUnavailableError(hostRuntime, pathValue);
}

/**
 * The badge identity of the child a process-mode kernel runs: the host's own identity when the child is the host's
 * executable, else the resolved runtime with the version it reports. Undefined when no runtime resolves (the kernel
 * then reports the capability gap on its first cell).
 */
export function processRuntimeInfo(searchPath: string | undefined): EvalRuntimeInfo | undefined {
	let command: string;
	try {
		command = resolveJavaScriptProcessCommand(searchPath);
	} catch (error) {
		if (error instanceof JavaScriptProcessRuntimeUnavailableError) return undefined;
		throw error;
	}
	const name = runtimeNameOf(command);
	if (command === process.execPath || name === undefined) return undefined;
	const version = execFileSync(command, ["--version"], { encoding: "utf8", timeout: 5_000 }).trim().replace(/^v/, "");
	return { name, version, path: command, isolation: "process" };
}

/** "bun" or "node" from an executable path; undefined for anything else (a compiled senpi binary, for one). */
export function runtimeNameOf(command: string): "bun" | "node" | undefined {
	const name = basename(command).replace(/\.(exe|cmd|bat)$/i, "");
	return name === "bun" || name === "node" ? name : undefined;
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error.code === "ENOENT" || error.code === "EACCES" || error.code === "ENOTDIR")
		) {
			return false;
		}
		throw error;
	}
}

export function spawnProcessWorker(url: URL, options: JavaScriptProcessWorkerOptions): JavaScriptProcessWorker {
	const command = resolveJavaScriptProcessCommand(options.searchPath, process.platform, undefined, options.execPath);
	const isBun = runtimeNameOf(command) === "bun";
	const args = isBun ? [fileURLToPath(url)] : ["--experimental-strip-types", fileURLToPath(url)];
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...options.env,
		SENPI_CODEMODE_PROCESS_CWD: options.cwd,
		SENPI_CODEMODE_PROCESS_POOL_WIDTH: String(options.parallelPoolWidth),
	};
	const child =
		options.spawn === undefined
			? spawnSubprocess(undefined, { command, args, cwd: options.cwd, env })
			: options.spawn(command, args, { cwd: options.cwd, env });
	const messageHandlers = new Set<(message: KernelToHostMessage) => void>();
	const errorHandlers = new Set<(error: Error) => void>();
	const frameToken = randomBytes(16).toString("hex");
	const framePrefix = `${frameToken} `;
	let crashCause: Error | undefined;
	let stderrTail = "";
	// A line that fails to parse may be the end of a frame a dying child was writing; it is reported only once the
	// channel carries on, so the crash cause or the exit itself, not "invalid frame", settles the cell.
	let pendingInvalidFrame: Error | undefined;
	const reportPendingInvalidFrame = () => {
		const error = pendingInvalidFrame;
		pendingInvalidFrame = undefined;
		if (error !== undefined) for (const handler of [...errorHandlers]) handler(error);
	};
	// Attached directly, not through SubprocessProcess, which stops reading stderr as soon as the exit is observed.
	child.stderr.on("data", (chunk: string | Buffer) => {
		stderrTail = `${stderrTail}${String(chunk)}`.slice(-STDERR_TAIL_CHARS);
		const crash = crashCauseFrom(stderrTail, frameToken);
		if (crash !== undefined) crashCause = crash;
	});
	const subprocess = new SubprocessProcess(child, {
		onLine: (_process, line) => {
			// Only a line carrying this process's token is a frame; any other line is output that
			// reached the channel (a raw fd write, a child process) and is delivered as text.
			if (!line.startsWith(framePrefix)) {
				if (line.trim().length === 0) return;
				reportPendingInvalidFrame();
				for (const handler of [...messageHandlers]) handler({ type: "text", stream: "stdout", data: line });
				return;
			}
			const parsed = decodeProcessFrame(line.slice(framePrefix.length), frameToken);
			if (!parsed.ok) {
				reportPendingInvalidFrame();
				pendingInvalidFrame = new Error(
					`JavaScript kernel process emitted an invalid frame: ${parsed.error.message}`,
				);
				return;
			}
			reportPendingInvalidFrame();
			const message = parsed.message;
			if (!isKernelToHostMessage(message)) return;
			for (const handler of [...messageHandlers]) handler(message);
		},
		// Crash causes are read by the listener below, which stays attached until stderr ends.
		onStderr: () => {},
		onExit: (_process, code, signal) => {
			pendingInvalidFrame = undefined;
			// A dead child's last stderr bytes can still be in flight when its exit is observed: settle once stderr has
			// ended (bounded), so the cause it reported is not replaced by the bare exit.
			void stderrEnded(child.stderr, STDERR_DRAIN_GRACE_MS).then(() => {
				// The child's own report of what killed it, as worker mode reports a thread's error; else the exit itself.
				const error = crashCause ?? new JavaScriptWorkerExitedError(code ?? -1, signal);
				for (const handler of [...errorHandlers]) handler(error);
			});
		},
		onError: (_process, error) => {
			for (const handler of [...errorHandlers]) handler(error);
		},
	});
	// The token is the first line the entry reads, before any cell can run.
	subprocess.send(`${frameToken}\n`);
	return {
		mode: "process",
		get pid() {
			return child.pid;
		},
		postMessage(message) {
			subprocess.send(`${JSON.stringify(message)}\n`);
		},
		onMessage(handler) {
			messageHandlers.add(handler);
			return () => {
				messageHandlers.delete(handler);
			};
		},
		onError(handler) {
			errorHandlers.add(handler);
			return () => {
				errorHandlers.delete(handler);
			};
		},
		async terminate() {
			const exited = await subprocess.shutdown(`${JSON.stringify({ type: "close" })}\n`);
			if (!exited) await subprocess.terminate("SIGKILL", PROCESS_CLOSE_GRACE_MS);
		},
	};
}

const STDERR_TAIL_CHARS = 16 * 1024;
const STDERR_DRAIN_GRACE_MS = 1_000;

/** Resolves when the stream has ended or closed, or after the grace period, whichever comes first. */
function stderrEnded(stream: NodeJS.ReadableStream, graceMs: number): Promise<void> {
	if (("readableEnded" in stream && stream.readableEnded === true) || ("closed" in stream && stream.closed === true)) {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			stream.removeListener("end", done);
			stream.removeListener("close", done);
			resolve();
		};
		const timer = setTimeout(done, graceMs);
		stream.once("end", done);
		stream.once("close", done);
	});
}
const BIGINT_MARKER = "\u0000senpi:bigint:";
const UNDEFINED_MARKER = "\u0000senpi:undefined:";
const BIGINT_DIGITS = /^-?\d+$/;

/**
 * A frame's `BigInt` and `undefined` values travel as markers (see process-entry.js `replacer`). They are revived
 * before the frame is checked against the bridge schema: an optional field the child left `undefined` (a cell whose
 * value is `undefined` has no `valueRepr`) arrives as a marker, and checked as-is it would fail the schema.
 */
function decodeProcessFrame(line: string, token: string): ReturnType<typeof validateBridgeMessage> {
	const parsed = parseBridgeJsonLine(line);
	if (!parsed.ok) return parsed;
	const value = parsed.value;
	if (typeof value === "object" && value !== null) reviveFrameValues(value, token);
	return validateBridgeMessage(value);
}

/** The cause the child reported on stderr just before exiting (see process-entry.js `reportCrash`). */
function crashCauseFrom(stderr: string, token: string): Error | undefined {
	const prefix = `senpi-kernel-crash ${token} `;
	const line = stderr.split("\n").find((candidate) => candidate.startsWith(prefix));
	if (line === undefined) return undefined;
	try {
		const cause: unknown = JSON.parse(line.slice(prefix.length));
		if (typeof cause !== "object" || cause === null || !("message" in cause) || typeof cause.message !== "string") {
			return undefined;
		}
		const error = new Error(cause.message);
		if ("name" in cause && typeof cause.name === "string") error.name = cause.name;
		return error;
	} catch {
		return undefined;
	}
}

/**
 * Turns the child's markers back, in place, into the values JSON cannot carry (a BigInt, an `undefined` property or
 * element), so a frame matches what worker mode's structured clone delivers. A marker carries this child's frame
 * token, so a cell's own data that merely looks like one is delivered as it is.
 */
function reviveFrameValues(container: object, token: string): void {
	const bigintKey = `${BIGINT_MARKER}${token}`;
	const undefinedKey = `${UNDEFINED_MARKER}${token}`;
	for (const key of Object.keys(container)) {
		const value: unknown = Reflect.get(container, key);
		if (typeof value !== "object" || value === null) continue;
		const keys = Object.keys(value);
		const digits: unknown = keys.length === 1 && keys[0] === bigintKey ? Reflect.get(value, bigintKey) : undefined;
		if (typeof digits === "string" && BIGINT_DIGITS.test(digits)) Reflect.set(container, key, BigInt(digits));
		else if (keys.length === 1 && keys[0] === undefinedKey) Reflect.set(container, key, undefined);
		else reviveFrameValues(value, token);
	}
}
