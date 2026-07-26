import { type Static, Type } from "typebox";
import { MonitorRegistry } from "../monitor-registry.ts";
import { DEFAULT_COLS, DEFAULT_ROWS, TERMINAL_MONITOR_TOOL } from "../shared.ts";
import { errorResult, type TerminalToolContext, type TerminalToolResult, textResult } from "./context.ts";
import { renderMonitorCall } from "./render.ts";
import { spawnCommandSession } from "./spawn.ts";

export const DEFAULT_MONITOR_TIMEOUT_MS = 300_000;
export const MAX_MONITOR_TIMEOUT_MS = 3_600_000;

const createMonitorSchema = Type.Object({
	action: Type.Optional(Type.Literal("create")),
	description: Type.String({
		minLength: 1,
		maxLength: 200,
		description: "Short label for the watcher and its decision-relevant events.",
	}),
	command: Type.String({ description: "Shell command to run and watch in a PTY-backed monitor session." }),
	filter: Type.Optional(Type.String({ description: "Only stdout lines matching this regex become monitor events." })),
	timeout_ms: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: MAX_MONITOR_TIMEOUT_MS,
			description: "Watcher deadline in milliseconds (default 300000; ignored by persistent monitors).",
		}),
	),
	persistent: Type.Optional(
		Type.Boolean({ description: "Keep watching until the command exits or kill_bash stops its bash_id." }),
	),
});

const rearmMonitorSchema = Type.Object({
	action: Type.Literal("rearm"),
	bash_id: Type.String({ description: "Paused monitor bash_id to resume after a wake-budget pause." }),
});

export const monitorSchema = Type.Union([createMonitorSchema, rearmMonitorSchema]);
export type MonitorInput = Static<typeof monitorSchema>;

type MonitorCreateInput = Static<typeof createMonitorSchema>;

function resolveDimension(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
	return Math.trunc(value);
}

function resolveTimeoutMs(value: number | undefined): number {
	const timeout = value ?? DEFAULT_MONITOR_TIMEOUT_MS;
	return Math.min(Math.max(Math.trunc(timeout), 1), MAX_MONITOR_TIMEOUT_MS);
}

function compileFilter(filter: string | undefined): RegExp | undefined {
	if (filter === undefined) return undefined;
	return new RegExp(filter);
}

async function createMonitor(
	ctx: TerminalToolContext,
	registry: MonitorRegistry,
	input: MonitorCreateInput,
	execCtx: { cwd?: string } | undefined,
): Promise<TerminalToolResult> {
	let filter: RegExp | undefined;
	try {
		filter = compileFilter(input.filter);
	} catch {
		return errorResult(`Invalid monitor filter regex: ${input.filter}`);
	}

	const { id, runtime } = await spawnCommandSession(ctx, {
		command: input.command,
		cols: resolveDimension(undefined, ctx.defaultCols || DEFAULT_COLS),
		rows: resolveDimension(undefined, ctx.defaultRows || DEFAULT_ROWS),
		cwd: execCtx?.cwd,
		...(input.persistent ? {} : { timeoutMs: resolveTimeoutMs(input.timeout_ms) }),
	});
	registry.register({ id, description: input.description, runtime, filter });
	return textResult(`Monitor started with ID: ${id}`, { details: { bash_id: id, monitor: true } });
}

/** Build the PTY-backed monitor tool. Monitor handles share TerminalManager's bash_N namespace. */
export function createMonitorTool(ctx: TerminalToolContext) {
	let fallbackRegistry: MonitorRegistry | undefined;
	const getRegistry = (): MonitorRegistry => {
		const sessionRegistry = ctx.monitorRegistry;
		if (sessionRegistry) return sessionRegistry;
		fallbackRegistry ??= new MonitorRegistry((event) => ctx.onMonitorEvent?.(event));
		return fallbackRegistry;
	};
	return {
		name: TERMINAL_MONITOR_TOOL,
		label: "monitor",
		description:
			"Watch a background shell command and emit decision-relevant stdout-line events. Returns a bash_id immediately; peek with bash_output or stop with kill_bash.",
		promptSnippet: "Watch a long-running command; monitor emits matching stdout lines as events",
		promptGuidelines: [
			"Use monitor only for decision-relevant lines; filter noisy output at the source when possible.",
		],
		parameters: monitorSchema,
		renderCall: renderMonitorCall,
		async execute(
			_toolCallId: string,
			input: MonitorInput,
			_signal?: AbortSignal,
			_onUpdate?: undefined,
			execCtx?: { cwd?: string },
		): Promise<TerminalToolResult> {
			const registry = getRegistry();
			if (input.action === "rearm") {
				const outcome = registry.rearm(input.bash_id);
				if (outcome === "not_found") return errorResult(`No active monitor found with id: ${input.bash_id}`);
				if (outcome === "not_paused") return textResult(`Monitor ${input.bash_id} is not paused; no action taken.`);
				ctx.onMonitorRearmed?.(input.bash_id);
				return textResult(`Monitor ${input.bash_id} re-armed.`);
			}
			return createMonitor(ctx, registry, input, execCtx);
		},
	};
}
