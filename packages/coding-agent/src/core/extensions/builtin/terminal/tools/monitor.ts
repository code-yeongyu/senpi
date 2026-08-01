import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { MonitorRegistry } from "../monitor-registry.ts";
import { DEFAULT_COLS, DEFAULT_ROWS, TERMINAL_MONITOR_TOOL } from "../shared.ts";
import { errorResult, type TerminalToolContext, type TerminalToolResult, textResult } from "./context.ts";
import { renderMonitorCall } from "./render.ts";
import { spawnCommandSession } from "./spawn.ts";

export const DEFAULT_MONITOR_TIMEOUT_MS = 300_000;
export const MAX_MONITOR_TIMEOUT_MS = 3_600_000;

/**
 * One flat object schema, no top-level union: several provider payload paths
 * (e.g. Anthropic's legacy input_schema conversion) rebuild tool schemas from
 * top-level `properties` only, so a root anyOf would reach the model as an
 * empty schema. Branch requirements are enforced at runtime in `execute`.
 */
export const monitorSchema = Type.Object({
	action: Type.Optional(
		StringEnum(["create", "rearm"] as const, {
			description: "Defaults to create. rearm resumes a monitor paused by the wake budget.",
		}),
	),
	description: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: 200,
			description: "Create (required): specific label shown with every event, e.g. 'errors in deploy.log'.",
		}),
	),
	command: Type.Optional(
		Type.String({
			description: "Create (required): shell command to run and watch in a PTY-backed monitor session.",
		}),
	),
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
	bash_id: Type.Optional(Type.String({ description: "Rearm (required): paused monitor bash_id to resume." })),
});
export type MonitorInput = Static<typeof monitorSchema>;

type MonitorCreateInput = MonitorInput & { description: string; command: string };

function isCreateInput(input: MonitorInput): input is MonitorCreateInput {
	return (
		typeof input.description === "string" &&
		input.description.length > 0 &&
		typeof input.command === "string" &&
		input.command.length > 0
	);
}

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
			"Subscribe to events from a command instead of polling for them: each stdout line arrives as an injected event while you keep working. Updates identical to a monitor's previous batch are dropped, so a watcher reprinting unchanged status does not re-wake the session. Returns a bash_id immediately; peek with bash_output, stop with kill_bash.",
		promptSnippet: "Subscribe to a command's stdout lines as injected events instead of polling",
		promptGuidelines: [
			"Waiting on observable state (CI checks, builds, log patterns, deploys) means a monitor, never a foreground sleep/poll loop.",
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
				const bashId = input.bash_id;
				if (bashId === undefined || bashId.length === 0) return errorResult("monitor rearm requires bash_id.");
				const outcome = registry.rearm(bashId);
				if (outcome === "not_found") return errorResult(`No active monitor found with id: ${bashId}`);
				if (outcome === "not_paused") return textResult(`Monitor ${bashId} is not paused; no action taken.`);
				ctx.onMonitorRearmed?.(bashId);
				return textResult(`Monitor ${bashId} re-armed.`);
			}
			if (!isCreateInput(input)) {
				return errorResult("monitor requires description and command to start a watcher.");
			}
			return createMonitor(ctx, registry, input, execCtx);
		},
	};
}
