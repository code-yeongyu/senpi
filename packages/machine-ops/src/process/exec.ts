import { spawn } from "node:child_process";
import { MachineOpError } from "../errors.ts";
import type { ExecRequest, ExecResult, ExecShell, OpContext } from "../types.ts";
import { newScopeToken, RUNTIME_ENV, SCOPE_ENV, type ScopeRegistry } from "./scopes.ts";
import { waitForChildProcess } from "./wait-child.ts";

/** Variables the machine path passes through to a child; everything else is dropped. */
const CURATED_ENV_KEYS = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TERM",
	"TMPDIR",
	"TZ",
	"SystemRoot",
	"SYSTEMROOT",
	"ComSpec",
	"PATHEXT",
	"WINDIR",
	"TEMP",
	"TMP",
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"ProgramData",
	"ProgramFiles",
] as const;

export function curatedEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of CURATED_ENV_KEYS) {
		const value = source[key];
		if (value !== undefined) env[key] = value;
	}
	return env;
}

export function defaultShell(): ExecShell {
	if (process.platform === "win32") return { path: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c"] };
	return { path: "/bin/sh", args: ["-c"] };
}

/** Collects at most `cap` bytes of a stream; the rest is counted and dropped. */
class CappedBuffer {
	private readonly chunks: Buffer[] = [];
	private size = 0;
	private readonly cap: number;
	truncated = false;
	constructor(cap: number) {
		this.cap = cap;
	}
	push(chunk: Buffer): void {
		const room = this.cap - this.size;
		if (room <= 0) {
			if (chunk.length > 0) this.truncated = true;
			return;
		}
		const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
		if (kept.length < chunk.length) this.truncated = true;
		this.chunks.push(kept);
		this.size += kept.length;
	}
	bytes(): Uint8Array {
		return Buffer.concat(this.chunks);
	}
}

export interface ExecDependencies {
	/** Absent: no scope token is recorded, nothing is written to disk and the child environment gets no entry. */
	readonly scopes: ScopeRegistry | undefined;
	readonly killTree: (pid: number) => void;
}

/**
 * Run one command in its own process group (with a scope token when a registry is configured), capped capture, a
 * timeout and abort. Abort and timeout kill the whole group and settle the result (`aborted` / `timedOut`) instead of
 * rejecting.
 */
export async function runExec(req: ExecRequest, ctx: OpContext, deps: ExecDependencies): Promise<ExecResult> {
	const timeoutMs = req.timeoutMs ?? ctx.limits.execTimeoutDefaultMs;
	if (!(timeoutMs > 0)) throw new MachineOpError("invalid_argument", "timeoutMs must be positive");
	const shell = req.shell ?? defaultShell();
	const scopes = deps.scopes;
	const token = scopes === undefined ? undefined : newScopeToken();
	if (scopes !== undefined && token !== undefined) {
		await scopes.record(token, { principal: ctx.principal.id, command: req.command.slice(0, 64) });
	}

	const env: Record<string, string | undefined> = {
		...(req.envMode === "exact" ? {} : curatedEnv()),
		...req.env,
	};
	if (token !== undefined) {
		env[SCOPE_ENV] = token;
		// A child of the runtime is a sweep target, never runtime itself.
		delete env[RUNTIME_ENV];
	}
	const viaStdin = shell.commandTransport === "stdin";
	const startedAtMs = Date.now();
	const started = performance.now();
	let child: ReturnType<typeof spawn>;
	try {
		child = spawn(shell.path, viaStdin ? [...shell.args] : [...shell.args, req.command], {
			cwd: req.cwd,
			detached: process.platform !== "win32",
			env,
			stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"],
			windowsHide: true,
		});
	} catch (error) {
		if (token !== undefined) await scopes?.release(token);
		throw error;
	}
	if (viaStdin) {
		child.stdin?.on("error", () => {});
		child.stdin?.end(req.command);
	}
	const pid = child.pid;
	if (pid !== undefined) {
		if (token !== undefined) scopes?.attach(token, pid);
		req.onSpawn?.(pid);
		const onExit = req.onExit;
		if (onExit !== undefined) child.once("exit", () => onExit(pid));
	}

	const stdout = new CappedBuffer(ctx.limits.execStdoutMaxBytes);
	const stderr = new CappedBuffer(ctx.limits.execStderrMaxBytes);
	let timedOut = false;
	let aborted = false;
	let callbackError: { error: unknown } | undefined;
	// Fires once the group is killed so the wait stops preserving stdio tails held by survivors.
	const killed = new AbortController();
	const kill = () => {
		if (pid !== undefined) deps.killTree(pid);
		killed.abort();
	};
	const onData = (chunk: Buffer, stream: "stdout" | "stderr") => {
		(stream === "stdout" ? stdout : stderr).push(chunk);
		if (req.onOutput === undefined || callbackError !== undefined) return;
		try {
			req.onOutput(chunk, stream);
		} catch (error) {
			callbackError = { error };
			kill();
		}
	};
	child.stdout?.on("data", (chunk: Buffer) => onData(chunk, "stdout"));
	child.stderr?.on("data", (chunk: Buffer) => onData(chunk, "stderr"));
	const onAbort = () => {
		aborted = true;
		kill();
	};
	const timer = Number.isFinite(timeoutMs)
		? setTimeout(() => {
				timedOut = true;
				kill();
			}, timeoutMs)
		: undefined;
	if (ctx.signal.aborted) onAbort();
	else ctx.signal.addEventListener("abort", onAbort, { once: true });

	let exitCode: number | null;
	try {
		exitCode = await waitForChildProcess(child, { signal: killed.signal });
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		ctx.signal.removeEventListener("abort", onAbort);
		// The kill grace released the wait while the child is still alive: it must not pin the event loop.
		if (child.exitCode === null && child.signalCode === null) child.unref();
		if (token !== undefined) await scopes?.release(token);
	}
	if (callbackError !== undefined) throw callbackError.error;
	return {
		pid,
		exitCode,
		signal: child.signalCode,
		stdout: stdout.bytes(),
		stderr: stderr.bytes(),
		stdoutTruncated: stdout.truncated,
		stderrTruncated: stderr.truncated,
		timedOut,
		aborted,
		startedAtMs,
		durationMs: Math.round(performance.now() - started),
		scopeToken: token,
	};
}

/** POSIX: SIGKILL the group, falling back to the leader; Windows: terminate the process. */
export function defaultKillTree(pid: number): void {
	try {
		process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already dead.
		}
	}
}
