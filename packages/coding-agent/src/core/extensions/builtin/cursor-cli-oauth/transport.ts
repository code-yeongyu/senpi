import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import {
	type CursorAgentExecutableDeps,
	defaultCursorAgentExecutableDeps,
	resolveCursorAgentExecutable,
} from "./executable.ts";
import { buildCursorCliArgs, type CursorCliArgsInput } from "./spawn-args.ts";
import { type CursorCliStreamEvent, CursorCliStreamParser } from "./stream-parser.ts";

// The prompt rides as ONE argv element, so Linux MAX_ARG_STRLEN (131072 bytes
// per single argv string) is the binding constraint on every platform; the
// ~467 KB darwin probe ceiling is not portable.
export const MAX_CURSOR_CLI_PROMPT_BYTES = 130_000;
export const CURSOR_CLI_ABORT_GRACE_MS = 5_000;
const MAX_STDERR_BYTES = 64 * 1024;

export class CursorCliPromptTooLargeError extends Error {
	readonly kind = "context_overflow";
	readonly limitBytes: number;
	readonly actualBytes: number;

	constructor(actualBytes: number, limitBytes = MAX_CURSOR_CLI_PROMPT_BYTES) {
		super(`Cursor CLI prompt is ${actualBytes} bytes; the limit is ${limitBytes} bytes`);
		this.name = "CursorCliPromptTooLargeError";
		this.actualBytes = actualBytes;
		this.limitBytes = limitBytes;
	}
}

export class CursorCliAbortError extends Error {
	readonly type = "aborted";
	readonly kind = "aborted";

	constructor() {
		super("Cursor CLI invocation aborted");
		this.name = "CursorCliAbortError";
	}
}

export type CursorCliTransportEvent = CursorCliStreamEvent | CursorCliAbortError;

export type CursorCliTransportCompletedOutcome = {
	readonly type: "completed";
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stderr: string;
};

export type CursorCliTransportAbortedOutcome = {
	readonly type: "aborted";
	readonly error: CursorCliAbortError;
};

export type CursorCliTransportOutcome = CursorCliTransportCompletedOutcome | CursorCliTransportAbortedOutcome;

export type CursorCliTransportInput = CursorCliArgsInput & {
	readonly accountHome: string;
	readonly cwd: string;
	readonly signal?: AbortSignal;
	readonly executableDeps?: CursorAgentExecutableDeps;
};

export type CursorCliTransportHandle = {
	readonly pid: number;
	readonly events: AsyncIterable<CursorCliTransportEvent>;
	readonly completed: Promise<CursorCliTransportOutcome>;
	abort(): void;
};

type QueueWaiter<T> = {
	resolve(result: IteratorResult<T>): void;
	reject(error: unknown): void;
};

class AsyncEventQueue<T> implements AsyncIterableIterator<T> {
	private readonly values: T[] = [];
	private readonly waiters: QueueWaiter<T>[] = [];
	private ended = false;
	private failure: unknown;

	[Symbol.asyncIterator](): AsyncIterableIterator<T> {
		return this;
	}

	next(): Promise<IteratorResult<T>> {
		const value = this.values.shift();
		if (value !== undefined) return Promise.resolve({ done: false, value });
		if (this.failure !== undefined) return Promise.reject(this.failure);
		if (this.ended) return Promise.resolve({ done: true, value: undefined });
		return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
	}

	push(value: T): void {
		if (this.ended || this.failure !== undefined) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter.resolve({ done: false, value });
		else this.values.push(value);
	}

	close(): void {
		if (this.ended || this.failure !== undefined) return;
		this.ended = true;
		for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
	}

	fail(error: unknown): void {
		if (this.ended || this.failure !== undefined) return;
		this.failure = error;
		for (const waiter of this.waiters.splice(0)) waiter.reject(error);
	}
}

function explicitEnvironment(accountHome: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		HOME: accountHome,
		AGENT_CLI_CREDENTIAL_STORE: "file",
	};
	for (const name of ["PATH", "TERM", "LANG", "LC_ALL", "FORCE_COLOR"] as const) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	return env;
}

function killProcessGroup(child: ChildProcessByStdio<null, Readable, Readable>, signal: NodeJS.Signals): void {
	const pid = child.pid;
	if (pid === undefined) return;
	try {
		if (process.platform === "win32") child.kill(signal);
		else process.kill(-pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

function appendBoundedStderr(current: Uint8Array, chunk: Uint8Array): Uint8Array {
	if (chunk.byteLength >= MAX_STDERR_BYTES) return chunk.subarray(chunk.byteLength - MAX_STDERR_BYTES);
	const combined = Buffer.concat([current, chunk]);
	return combined.byteLength <= MAX_STDERR_BYTES
		? combined
		: combined.subarray(combined.byteLength - MAX_STDERR_BYTES);
}

/** Spawn one cursor-agent print-mode invocation with strict environment and process-group ownership. */
export function spawnCursorCli(input: CursorCliTransportInput): CursorCliTransportHandle {
	const promptBytes = Buffer.byteLength(input.prompt, "utf8");
	if (promptBytes > MAX_CURSOR_CLI_PROMPT_BYTES) throw new CursorCliPromptTooLargeError(promptBytes);
	if (input.signal?.aborted) throw new CursorCliAbortError();

	const executable = resolveCursorAgentExecutable(input.executableDeps ?? defaultCursorAgentExecutableDeps());
	const child = spawn(executable, buildCursorCliArgs(input), {
		cwd: input.cwd,
		detached: true,
		env: explicitEnvironment(input.accountHome),
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	if (child.pid === undefined) {
		child.kill("SIGKILL");
		throw new Error("cursor-agent spawned without a process id");
	}

	const pid = child.pid;
	const parser = new CursorCliStreamParser();
	const events = new AsyncEventQueue<CursorCliTransportEvent>();
	let stderr: Uint8Array = Buffer.alloc(0);
	let abortRequested = false;
	let abortTimer: NodeJS.Timeout | undefined;
	let removeAbortListener = (): void => {};
	let resolveCompleted: (outcome: CursorCliTransportOutcome) => void = () => {};
	let rejectCompleted: (error: unknown) => void = () => {};
	const completed = new Promise<CursorCliTransportOutcome>((resolve, reject) => {
		resolveCompleted = resolve;
		rejectCompleted = reject;
	});

	const abort = (): void => {
		if (abortRequested || child.exitCode !== null || child.signalCode !== null) return;
		abortRequested = true;
		try {
			killProcessGroup(child, "SIGTERM");
		} catch (error) {
			events.fail(error);
			rejectCompleted(error);
			return;
		}
		abortTimer = setTimeout(() => {
			try {
				killProcessGroup(child, "SIGKILL");
			} catch (error) {
				events.fail(error);
				rejectCompleted(error);
			}
		}, CURSOR_CLI_ABORT_GRACE_MS);
	};

	child.stdout.on("data", (chunk: Buffer) => {
		for (const event of parser.push(chunk)) events.push(event);
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = appendBoundedStderr(stderr, chunk);
	});
	child.once("error", (error) => {
		if (abortTimer) clearTimeout(abortTimer);
		removeAbortListener();
		events.fail(error);
		rejectCompleted(error);
	});
	child.once("close", (exitCode, signal) => {
		if (abortTimer) clearTimeout(abortTimer);
		removeAbortListener();
		if (abortRequested) {
			const error = new CursorCliAbortError();
			events.push(error);
			events.close();
			resolveCompleted({ type: "aborted", error });
			return;
		}
		for (const event of parser.finish()) events.push(event);
		events.close();
		resolveCompleted({ type: "completed", exitCode, signal, stderr: Buffer.from(stderr).toString("utf8") });
	});

	if (input.signal) {
		input.signal.addEventListener("abort", abort, { once: true });
		removeAbortListener = () => input.signal?.removeEventListener("abort", abort);
	}

	return { pid, events, completed, abort };
}
