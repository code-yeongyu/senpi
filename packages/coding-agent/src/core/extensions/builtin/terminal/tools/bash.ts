import { type Static, Type } from "typebox";
import { BACKGROUND_START_GRACE_MS, DEFAULT_COLS, DEFAULT_ROWS, TERMINAL_BASH_TOOL } from "../shared.ts";
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

async function runForeground(
	ctx: TerminalToolContext,
	input: PtyBashInput,
	cols: number,
	rows: number,
	signal: AbortSignal | undefined,
	cwd: string | undefined,
): Promise<TerminalToolResult> {
	const timeoutMs = input.timeout !== undefined ? Math.trunc(input.timeout * 1000) : undefined;
	const { runtime } = await spawnCommandSession(ctx, { command: input.command, cols, rows, timeoutMs, cwd });
	const onAbort = () => runtime.session.kill();
	if (signal) {
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	try {
		await runtime.session.waitExit();
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}

	const output = runtime.fullOutput().trimEnd();
	const status = describeExit(runtime);
	const exit = runtime.exitResult;
	if (exit?.timedOut) {
		return errorResult(`${output ? `${output}\n\n` : ""}Command timed out after ${input.timeout} seconds`);
	}
	if (exit && exit.exitCode !== 0 && exit.exitCode !== null) {
		return errorResult(`${output ? `${output}\n\n` : ""}Command exited with code ${exit.exitCode}`);
	}
	return textResult(output || "(no output)", { details: { status } });
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
	const early = runtime.readDelta().text.trimEnd();
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
			_onUpdate?: unknown,
			execCtx?: { cwd?: string },
		): Promise<TerminalToolResult> {
			const cols = resolveDimension(input.cols, ctx.defaultCols || DEFAULT_COLS);
			const rows = resolveDimension(input.rows, ctx.defaultRows || DEFAULT_ROWS);
			const cwd = execCtx?.cwd;
			if (input.run_in_background) return runBackground(ctx, input, cols, rows, cwd);
			return runForeground(ctx, input, cols, rows, signal, cwd);
		},
	};
}
