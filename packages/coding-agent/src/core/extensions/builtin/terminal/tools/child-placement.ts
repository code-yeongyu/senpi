/**
 * Places a terminal tool on the session's tool child (senpi#3566 todo 9): `placement: "child"` plus the job that runs
 * the same body there (`terminal-jobs.ts`). The job's arguments are built on the server from what the body would read
 * in-process - the shell environment with the session's PI_* overrides, the shell path, the default size, the cwd - so
 * the command sees the same environment wherever it runs. Under `--tool-runtime in-process` the placement is ignored and
 * `execute` runs here, unchanged.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionToolContext, ToolChildJob } from "../../../types.ts";
import { sessionEnvOverrides } from "./bash.ts";
import type { TerminalExitView, TerminalToolContext } from "./context.ts";

export const TERMINAL_CHILD_JOB_KINDS = {
	bash: "terminal.bash",
	output: "terminal.output",
	input: "terminal.input",
	resize: "terminal.resize",
	kill: "terminal.kill",
} as const;

/**
 * A tool child's terminal manager scopes its ids by generation (`bash_c<generation>_<n>`, `idScope`), so they never
 * match the server's own (a monitor's `bash_N`, `mon_*`, `watch_*`, `rpc_*`): the id alone says who owns the session.
 */
export function childTerminalIdScope(generation: number): string {
	return `c${generation}`;
}

const CHILD_SESSION_ID = /_c(\d+)_\d+$/;

export function isChildSessionId(id: string): boolean {
	return CHILD_SESSION_ID.test(id);
}

/**
 * The child generation a child session was started on, read from its id. A session lives in its child's manager, so
 * once that generation exits the id is gone: a call reaching a later child turns "unknown id" into "lost".
 */
function childGenerationOf(id: string): number | undefined {
	const generation = CHILD_SESSION_ID.exec(id)?.[1];
	return generation === undefined ? undefined : Number(generation);
}

/** What a child reports about a background session after the job that started it ended (`wake`). */
export type TerminalBackgroundWake =
	| {
			readonly event: "background_start";
			readonly id: string;
			readonly description: string;
			readonly startedAtMs: number;
	  }
	| {
			readonly event: "background_exit";
			readonly id: string;
			readonly exit: TerminalExitView["exitResult"];
			readonly output: string;
	  };

function parseBackgroundWake(value: unknown): TerminalBackgroundWake | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const event: unknown = Reflect.get(value, "event");
	const id: unknown = Reflect.get(value, "id");
	if (typeof id !== "string" || !isChildSessionId(id)) return undefined;
	if (event === "background_start") {
		const description: unknown = Reflect.get(value, "description");
		const startedAtMs: unknown = Reflect.get(value, "startedAtMs");
		if (typeof description !== "string" || typeof startedAtMs !== "number") return undefined;
		return { event, id, description, startedAtMs };
	}
	if (event === "background_exit") {
		const output: unknown = Reflect.get(value, "output");
		const exit: unknown = Reflect.get(value, "exit");
		if (typeof output !== "string" || (exit !== null && typeof exit !== "object")) return undefined;
		return { event, id, exit: exit as TerminalExitView["exitResult"], output };
	}
	return undefined;
}

function exitView(exit: TerminalExitView["exitResult"], output: string): TerminalExitView {
	return { exitResult: exit, fullOutput: () => output };
}

function bashIdOf(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const id = (value as { bash_id?: unknown }).bash_id;
	return typeof id === "string" ? id : undefined;
}

export function lostSessionResult(id: string, generation: number): AgentToolResult<unknown> {
	return {
		content: [
			{
				type: "text",
				text: `bash_id ${id} is lost: the session's tool child (generation ${generation}) exited, which ended this session and every process it started. Start a new session with bash.`,
			},
		],
		details: { bash_id: id, lost: true, generation },
	};
}

export function terminalChildJob(
	ctx: TerminalToolContext,
	kind: (typeof TERMINAL_CHILD_JOB_KINDS)[keyof typeof TERMINAL_CHILD_JOB_KINDS],
): ToolChildJob {
	return {
		kind,
		...(kind === TERMINAL_CHILD_JOB_KINDS.bash ? backgroundRelay(ctx) : {}),
		...(kind === TERMINAL_CHILD_JOB_KINDS.bash
			? {}
			: {
					placement: (params: unknown) => {
						const id = bashIdOf(params);
						if (id === undefined) return kind === TERMINAL_CHILD_JOB_KINDS.kill ? "both" : "child";
						return isChildSessionId(id) ? "child" : "server";
					},
				}),
		result: (params, value, generation) => {
			if (kind === TERMINAL_CHILD_JOB_KINDS.bash) return value;
			const id = bashIdOf(params);
			const startedOn = id === undefined ? undefined : childGenerationOf(id);
			if (id === undefined || startedOn === undefined || startedOn === generation) return value;
			return lostSessionResult(id, startedOn);
		},
		args: (params: unknown, toolCallId: string, execCtx: ExtensionToolContext) => {
			const env: Record<string, string> = {};
			for (const [name, value] of Object.entries(ctx.getEnv())) if (typeof value === "string") env[name] = value;
			return {
				params,
				toolCallId,
				cwd: execCtx.cwd ?? ctx.cwd,
				env: { ...env, ...sessionEnvOverrides(ctx, execCtx) },
				...(ctx.shellPath === undefined ? {} : { shellPath: ctx.shellPath }),
				defaultCols: ctx.defaultCols,
				defaultRows: ctx.defaultRows,
				redactSecretsInOutput: ctx.redactSecretsInOutput === true,
				...(ctx.timeoutAction === undefined ? {} : { timeoutAction: ctx.timeoutAction }),
			};
		},
	};
}

/**
 * The server's half of a background session that lives on the child: the child's start and exit arrive as wakes and go
 * to the same hooks the in-process tools call (liveness snapshot, manifest, the completion notice). A generation that
 * exits takes its sessions with it; each one still running gets its exit notice then.
 */
function backgroundRelay(ctx: TerminalToolContext): Pick<ToolChildJob, "wake" | "childExited"> {
	const running = new Map<string, number>();
	return {
		wake: (value, generation) => {
			const wake = parseBackgroundWake(value);
			if (wake === undefined) return;
			if (wake.event === "background_start") {
				running.set(wake.id, generation);
				ctx.onBackgroundStart?.(wake.id, wake.description, wake.startedAtMs);
				return;
			}
			running.delete(wake.id);
			ctx.onBackgroundExit?.(wake.id, exitView(wake.exit, wake.output));
		},
		childExited: (generation) => {
			for (const [id, startedOn] of running) {
				if (startedOn !== generation) continue;
				running.delete(id);
				ctx.onBackgroundExit?.(
					id,
					exitView(
						{ exitCode: null, signal: null, timedOut: false, cancelled: true },
						`The session's tool child (generation ${generation}) exited, which ended this session and every process it started.`,
					),
				);
			}
		},
	};
}
