import { type Static, Type } from "typebox";
import type { AgentToolUpdateCallback } from "../../../types.ts";
import { formatTerminalToolOutput } from "../output-format.ts";
import type { TerminalRuntimeSession } from "../runtime-session.ts";
import {
	BACKGROUND_START_GRACE_MS,
	DEFAULT_COLS,
	DEFAULT_ROWS,
	FOREGROUND_ENV_OVERRIDES,
	KILLED_SESSION_EXIT_GRACE_MS,
	TERMINAL_BASH_TOOL,
} from "../shared.ts";
import { errorResult, type TerminalToolContext, type TerminalToolResult, textResult } from "./context.ts";
import { describeExit, spawnCommandSession } from "./spawn.ts";

export const ptyBashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute in a PTY-backed session." }),
	timeout: Type.Optional(
		Type.Number({
			description:
				"Foreground kill deadline in seconds. Ignored for run_in_background sessions (they live until exit or kill_bash).",
		}),
	),
	description: Type.Optional(Type.String({ description: "Short human-readable label for this command." })),
	run_in_background: Type.Optional(
		Type.Boolean({
			description:
				"Run as a persistent background session. Returns a bash_id immediately; query it with bash_output, steer with bash_input, tear down with kill_bash.",
		}),
	),
	cols: Type.Optional(Type.Number({ description: "PTY width in columns (default 120)." })),
	rows: Type.Optional(Type.Number({ description: "PTY height in rows (default 40)." })),
});

export type PtyBashInput = Static<typeof ptyBashSchema>;

function resolveDimension(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
	return Math.trunc(value);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_TIMEOUT_MS = 2_147_483_647;
const BASH_UPDATE_THROTTLE_MS = 100;

export interface ThrottledEmitter {
	schedule(): void;
	flush(): void;
	dispose(): void;
}

/**
 * Emit immediately, then coalesce subsequent schedules into one trailing update.
 * `dispose` intentionally discards a pending update so callers can stop cleanly.
 */
export function createThrottledEmitter(emit: () => void, throttleMs = BASH_UPDATE_THROTTLE_MS): ThrottledEmitter {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let dirty = false;
	let lastEmissionAt: number | undefined;

	const emitIfDirty = () => {
		if (!dirty) return;
		dirty = false;
		lastEmissionAt = Date.now();
		emit();
	};

	const clearTimer = () => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	};

	return {
		schedule() {
			dirty = true;
			if (timer !== undefined) return;
			const elapsed = lastEmissionAt === undefined ? throttleMs : Date.now() - lastEmissionAt;
			if (elapsed >= throttleMs) {
				emitIfDirty();
				return;
			}
			timer = setTimeout(() => {
				timer = undefined;
				emitIfDirty();
			}, throttleMs - elapsed);
		},
		flush() {
			clearTimer();
			emitIfDirty();
		},
		dispose() {
			clearTimer();
			dirty = false;
			lastEmissionAt = undefined;
		},
	};
}

type ForegroundWaitOutcome = "exited" | "abort_grace" | "timeout_grace";

/**
 * Wait for the session's exit to settle, but stop waiting a bounded grace after
 * the session has been killed. The native wait joins the PTY reader thread,
 * which blocks while any surviving descendant holds the PTY open — without the
 * grace, an aborted or timed-out command can pin the agent forever.
 */
function raceExitWithKillGrace(
	runtime: TerminalRuntimeSession,
	signal: AbortSignal | undefined,
	timeoutMs: number | undefined,
): Promise<ForegroundWaitOutcome> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let abortGraceTimer: ReturnType<typeof setTimeout> | undefined;
		let timeoutGraceTimer: ReturnType<typeof setTimeout> | undefined;
		let armAbortGrace: (() => void) | undefined;
		const settle = (finish: () => void) => {
			if (settled) return;
			settled = true;
			if (abortGraceTimer) clearTimeout(abortGraceTimer);
			if (timeoutGraceTimer) clearTimeout(timeoutGraceTimer);
			if (signal && armAbortGrace) signal.removeEventListener("abort", armAbortGrace);
			finish();
		};
		runtime.session.waitExit().then(
			() => settle(() => resolve("exited")),
			(error: unknown) => settle(() => reject(error instanceof Error ? error : new Error(String(error)))),
		);
		if (timeoutMs !== undefined) {
			const timeoutGraceDeadlineMs = timeoutMs + KILLED_SESSION_EXIT_GRACE_MS;
			// Beyond the 32-bit setTimeout range the deadline cannot be represented;
			// keep the unbounded wait rather than firing a false early timeout.
			if (timeoutGraceDeadlineMs <= MAX_TIMEOUT_MS) {
				timeoutGraceTimer = setTimeout(() => settle(() => resolve("timeout_grace")), timeoutGraceDeadlineMs);
			}
		}
		if (signal) {
			armAbortGrace = () => {
				abortGraceTimer ??= setTimeout(() => settle(() => resolve("abort_grace")), KILLED_SESSION_EXIT_GRACE_MS);
			};
			if (signal.aborted) armAbortGrace();
			else signal.addEventListener("abort", armAbortGrace, { once: true });
		}
	});
}

async function runForeground(
	ctx: TerminalToolContext,
	input: PtyBashInput,
	cols: number,
	rows: number,
	signal: AbortSignal | undefined,
	cwd: string | undefined,
	onUpdate: AgentToolUpdateCallback | undefined,
): Promise<TerminalToolResult> {
	if (signal?.aborted) return errorResult("Command aborted");
	const timeoutMs = input.timeout !== undefined ? Math.trunc(input.timeout * 1000) : undefined;
	const { id, runtime } = await spawnCommandSession(ctx, {
		command: input.command,
		cols,
		rows,
		timeoutMs,
		cwd,
		envOverrides: FOREGROUND_ENV_OVERRIDES,
	});
	const startedAt = Date.now();
	const activity = `running ${input.command.slice(0, 80)}`;
	const emitOutputUpdate = () => {
		const text = formatTerminalToolOutput(runtime.fullOutput()).text.slice(-2000);
		onUpdate?.({ content: [{ type: "text", text }], details: { progress: { activity, startedAt } } });
	};
	const updateEmitter = onUpdate ? createThrottledEmitter(emitOutputUpdate) : undefined;
	onUpdate?.({ content: [], details: undefined });
	const unsubscribeOutput = onUpdate ? runtime.onOutput(() => updateEmitter?.schedule()) : undefined;

	// Interrupt means "stop now": SIGKILL the whole process group in one shot.
	// kill() is one-shot idempotent, so a gentle SIGTERM first would block any
	// escalation, and a SIGTERM-ignoring command would pin the agent forever.
	const onAbort = () => runtime.session.kill("SIGKILL");
	if (signal) {
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	let outcome: ForegroundWaitOutcome;
	try {
		outcome = await raceExitWithKillGrace(runtime, signal, timeoutMs);
	} finally {
		signal?.removeEventListener("abort", onAbort);
		unsubscribeOutput?.();
		updateEmitter?.flush();
		updateEmitter?.dispose();
	}

	if (outcome !== "exited") {
		// Sweep the never-settling session: the bounded registry stop marks it
		// `stopping`, so later /exit teardown cannot hang on its exit wait.
		void ctx.manager.stop(id).catch(() => {});
	}
	const formatted = formatTerminalToolOutput(runtime.fullOutput());
	const output = formatted.text;
	// Aborted runs report "Command aborted" (core bash parity) whether the exit
	// settled normally or the kill grace released the wait. `outcome` matters
	// beyond that only for the timeout grace, where exitResult is still null.
	if (signal?.aborted) {
		return errorResult(`${output ? `${output}\n\n` : ""}Command aborted`);
	}
	const exit = runtime.exitResult;
	if (outcome === "timeout_grace" || exit?.timedOut) {
		return errorResult(`${output ? `${output}\n\n` : ""}Command timed out after ${input.timeout} seconds`);
	}
	const status = describeExit(runtime);
	if (exit && exit.exitCode !== 0 && exit.exitCode !== null) {
		return errorResult(`${output ? `${output}\n\n` : ""}Command exited with code ${exit.exitCode}`);
	}
	return textResult(output || "(no output)", {
		details: {
			status,
			...(formatted.truncated ? { truncation: formatted.truncation } : {}),
		},
	});
}

async function runBackground(
	ctx: TerminalToolContext,
	input: PtyBashInput,
	cols: number,
	rows: number,
	cwd: string | undefined,
): Promise<TerminalToolResult> {
	// Background sessions are NEVER killed by `timeout` (bash-timeout injects a default into
	// every bash call); they live until exit or kill_bash, so no timeoutMs is passed.
	const { id, runtime } = await spawnCommandSession(ctx, { command: input.command, cols, rows, cwd });
	if (ctx.onBackgroundExit) runtime.session.onExit(() => ctx.onBackgroundExit?.(id, runtime));

	// Capture any output the command emits within a short grace window (or its exit).
	await Promise.race([delay(BACKGROUND_START_GRACE_MS), runtime.session.waitExit()]);
	const early = formatTerminalToolOutput(runtime.readDelta().text).text;
	const header = `Command running in background with ID: ${id}`;
	const backendNote =
		runtime.backend === "pipe-fallback"
			? "\n(native PTY unavailable — running via pipe fallback; bash_input/bash_resize are limited.)"
			: "";
	const earlyBlock = early ? `\n\n${early}` : "";
	return textResult(`${header}${backendNote}${earlyBlock}`, { details: { bash_id: id, background: true } });
}

/** Build the PTY-backed `bash` tool definition. */
export function createPtyBashTool(ctx: TerminalToolContext) {
	return {
		name: TERMINAL_BASH_TOOL,
		label: "bash",
		description:
			"Execute a shell command in a persistent PTY-backed session. Set run_in_background:true for long-lived or interactive sessions; steer them with bash_input, snapshot with bash_output, tear down with kill_bash. Foreground timeout is a kill deadline in seconds.",
		promptSnippet: "Run shell commands; run_in_background:true for long-lived/interactive PTY sessions",
		parameters: ptyBashSchema,
		async execute(
			_toolCallId: string,
			input: PtyBashInput,
			signal?: AbortSignal,
			onUpdate?: AgentToolUpdateCallback,
			execCtx?: { cwd?: string },
		): Promise<TerminalToolResult> {
			const cols = resolveDimension(input.cols, ctx.defaultCols || DEFAULT_COLS);
			const rows = resolveDimension(input.rows, ctx.defaultRows || DEFAULT_ROWS);
			const cwd = execCtx?.cwd;
			if (input.run_in_background) return runBackground(ctx, input, cols, rows, cwd);
			return runForeground(ctx, input, cols, rows, signal, cwd, onUpdate);
		},
	};
}
