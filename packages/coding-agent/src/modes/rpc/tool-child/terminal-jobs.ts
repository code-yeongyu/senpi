/**
 * The terminal's tool bodies as tool-child job kinds (senpi#3566 todo 9): the child owns one TerminalManager - its PTYs
 * and background sessions - for the life of the child, and runs the same bash / bash_output / bash_input / bash_resize
 * / kill_bash bodies the in-process extension runs. Every command starts behind the execution barrier: the go-line
 * shim runs inside the PTY (echo off around the read), the server records the started session's group, and only then
 * is the go-line written. Foreground output streams back as job updates.
 */
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { TerminalManager } from "../../../core/extensions/builtin/terminal/manager.ts";
import { NOTICE_TAIL_MAX_CHARS } from "../../../core/extensions/builtin/terminal/notify.ts";
import { sanitizeTerminalOutput } from "../../../core/extensions/builtin/terminal/output-format.ts";
import type { TimeoutAction } from "../../../core/extensions/builtin/terminal/settings.ts";
import { createPtyBashTool } from "../../../core/extensions/builtin/terminal/tools/bash.ts";
import { createBashInputTool } from "../../../core/extensions/builtin/terminal/tools/bash-input.ts";
import { createBashOutputTool } from "../../../core/extensions/builtin/terminal/tools/bash-output.ts";
import { createBashResizeTool } from "../../../core/extensions/builtin/terminal/tools/bash-resize.ts";
import type {
	TerminalExitView,
	TerminalLaunchBarrier,
	TerminalToolContext,
} from "../../../core/extensions/builtin/terminal/tools/context.ts";
import { createKillBashTool } from "../../../core/extensions/builtin/terminal/tools/kill-bash.ts";
import type { ToolChildJobContext, ToolChildJobHandler } from "./entry.ts";
import { ToolChildJobError } from "./entry-error.ts";

/** Inside the PTY: no echo while it waits for the go-line, then the real command keeps the PTY's pid and group. */
const PTY_GO_SHIM = 'stty -echo 2>/dev/null; IFS= read -r _go || exit 127; stty echo 2>/dev/null; exec "$0" "$@"';

import {
	childTerminalIdScope,
	TERMINAL_CHILD_JOB_KINDS as TERMINAL_JOB_KINDS,
	type TerminalBackgroundWake,
} from "../../../core/extensions/builtin/terminal/tools/child-placement.ts";

export { TERMINAL_JOB_KINDS };

/** What a terminal tool needs to run here: its schema (to check the params) and its body. */
interface ChildRunnableTool<P extends TSchema> {
	readonly parameters: P;
	execute(
		toolCallId: string,
		input: Static<P>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		execCtx?: { readonly cwd?: string },
	): Promise<unknown>;
}

/** What the server sends with every terminal job: the tool's params and the session facts its body reads. */
export interface TerminalJobArgs {
	readonly params: unknown;
	readonly toolCallId: string;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly shellPath?: string;
	readonly defaultCols: number;
	readonly defaultRows: number;
	readonly timeoutAction?: TimeoutAction;
	readonly redactSecretsInOutput?: boolean;
}

function parseArgs(value: unknown): TerminalJobArgs {
	const field = (name: string): unknown =>
		typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
	const cwd = field("cwd");
	const toolCallId = field("toolCallId");
	const env = field("env");
	if (typeof cwd !== "string" || typeof toolCallId !== "string" || typeof env !== "object" || env === null)
		throw new ToolChildJobError("terminal_job_bad_args", "a terminal job needs cwd, toolCallId and env");
	const shellPath = field("shellPath");
	const timeoutAction = field("timeoutAction");
	return {
		params: field("params"),
		toolCallId,
		cwd,
		env: Object.fromEntries(
			Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
		),
		...(typeof shellPath === "string" ? { shellPath } : {}),
		defaultCols: Number(field("defaultCols")) || 0,
		defaultRows: Number(field("defaultRows")) || 0,
		redactSecretsInOutput: field("redactSecretsInOutput") === true,
		...(timeoutAction === "background" || timeoutAction === "kill" ? { timeoutAction } : {}),
	};
}

function barrierFor(job: ToolChildJobContext): TerminalLaunchBarrier {
	return {
		wrap: (command, args) => ({ command: "/bin/sh", args: ["-c", PTY_GO_SHIM, command, ...args] }),
		async release(session) {
			if (session.pid === undefined) throw new ToolChildJobError("terminal_spawn_failed", "the PTY reported no pid");
			const gated = job.gate.request({
				jobId: job.jobId,
				origin: "terminal",
				api: "pty.spawn",
				containment: "own-group",
				lifetime: "owned",
				pid: session.pid,
				pgid: session.pid,
			});
			session.onExit((exitCode) => job.gate.done(gated.launchId, exitCode === null ? {} : { exitCode }));
			if (!job.gate.skipsAckWait) await gated.acked;
			job.gate.invokeNow(gated.launchId);
			session.write("go\n");
		},
	};
}

/** The tail a background exit notice shows, sanitized here so the wake carries only what the notice can use. */
function exitSummary(id: string, runtime: TerminalExitView): TerminalBackgroundWake {
	const output = sanitizeTerminalOutput(runtime.fullOutput()).trimEnd();
	const exit = runtime.exitResult;
	return {
		event: "background_exit",
		id,
		exit:
			exit === null
				? null
				: { exitCode: exit.exitCode, signal: exit.signal, cancelled: exit.cancelled, timedOut: exit.timedOut },
		output: output.length > NOTICE_TAIL_MAX_CHARS ? output.slice(output.length - NOTICE_TAIL_MAX_CHARS - 1) : output,
	};
}

/**
 * The handlers. The child's one terminal manager (shared by every terminal job of this child) is made on the first job,
 * its ids scoped by this child's generation so they never collide with the server's or an earlier child's.
 */
export function createTerminalJobHandlers(injected?: TerminalManager): Readonly<Record<string, ToolChildJobHandler>> {
	let manager = injected;
	const managerFor = (generation: number): TerminalManager => {
		manager ??= new TerminalManager({ idScope: childTerminalIdScope(generation) });
		return manager;
	};
	const tell = (job: ToolChildJobContext, wake: TerminalBackgroundWake): void => {
		job.wake(TERMINAL_JOB_KINDS.bash, wake).catch((error: unknown) => {
			process.stderr.write(
				`tool-child: terminal ${wake.event} for ${wake.id} not delivered: ${error instanceof Error ? error.message : String(error)}\n`,
			);
		});
	};
	const contextFor = (args: TerminalJobArgs, job: ToolChildJobContext): TerminalToolContext => ({
		manager: managerFor(job.generation),
		...(args.timeoutAction === undefined ? {} : { timeoutAction: args.timeoutAction }),
		onBackgroundStart: (id, description, startedAtMs) =>
			tell(job, { event: "background_start", id, description, startedAtMs }),
		onBackgroundExit: (id, runtime) => tell(job, exitSummary(id, runtime)),
		cwd: args.cwd,
		...(args.shellPath === undefined ? {} : { shellPath: args.shellPath }),
		defaultCols: args.defaultCols,
		defaultRows: args.defaultRows,
		redactSecretsInOutput: args.redactSecretsInOutput,
		getEnv: () => ({ ...args.env }),
		launchBarrier: barrierFor(job),
	});
	const run =
		<P extends TSchema>(create: (ctx: TerminalToolContext) => ChildRunnableTool<P>): ToolChildJobHandler =>
		async (value, job) => {
			const args = parseArgs(value);
			const tool = create(contextFor(args, job));
			if (!Value.Check(tool.parameters, args.params))
				throw new ToolChildJobError("terminal_job_bad_args", "the tool's parameters do not match its schema");
			const onUpdate: AgentToolUpdateCallback = (update) => {
				job.update(update).catch((error: unknown) => {
					process.stderr.write(
						`tool-child: ${args.toolCallId} update not sent: ${error instanceof Error ? error.message : String(error)}\n`,
					);
				});
			};
			return tool.execute(args.toolCallId, args.params, job.signal, onUpdate, { cwd: args.cwd });
		};
	return {
		[TERMINAL_JOB_KINDS.bash]: run(createPtyBashTool),
		[TERMINAL_JOB_KINDS.output]: run(createBashOutputTool),
		[TERMINAL_JOB_KINDS.input]: run(createBashInputTool),
		[TERMINAL_JOB_KINDS.resize]: run(createBashResizeTool),
		[TERMINAL_JOB_KINDS.kill]: run(createKillBashTool),
	};
}
