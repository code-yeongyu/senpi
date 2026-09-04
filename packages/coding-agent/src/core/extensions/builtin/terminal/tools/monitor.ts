import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { APPROVED_MONITOR_PARENT } from "../monitor-permission.ts";
import { MonitorRegistry } from "../monitor-registry.ts";
import { DEFAULT_COLS, DEFAULT_ROWS, TERMINAL_MONITOR_TOOL } from "../shared.ts";
import {
	errorResult,
	resolveTerminalId,
	type TerminalToolContext,
	type TerminalToolResult,
	textResult,
} from "./context.ts";
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
			description:
				"Create, command branch (XOR path): shell command to run and watch in a PTY-backed monitor session.",
		}),
	),
	path: Type.Optional(
		Type.String({
			minLength: 1,
			description:
				"Create, file branch (XOR command): one regular file to watch natively, whose parent directory must already exist; takes no filter and no persistent.",
		}),
	),
	event: Type.Optional(
		StringEnum(["create", "modify"] as const, {
			description: "File branch only: which file event fires the watch (defaults to create).",
		}),
	),
	filter: Type.Optional(
		Type.String({ description: "Only PTY output lines matching this regex become monitor events." }),
	),
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
	bash_id: Type.Optional(
		Type.String({ description: "Rearm: paused monitor id (mon_ or bash_id) to resume; omit for all paused." }),
	),
});
export type MonitorInput = Static<typeof monitorSchema>;

type MonitorCreateInput = MonitorInput & { description: string; command: string };
type FileMonitorCreateInput = MonitorInput & { description: string; path: string };

function isFileCreateInput(input: MonitorInput): input is FileMonitorCreateInput {
	return (
		typeof input.description === "string" &&
		input.description.length > 0 &&
		typeof input.path === "string" &&
		input.path.length > 0
	);
}

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
	ctx.onMonitorRearmed?.(id);
	const monitorId = registry.register({ id, description: input.description, runtime, filter });
	ctx.manager.bindMonitorId(monitorId, id);
	return textResult(`Monitor started with ID: ${monitorId}`, {
		details: { monitor_id: monitorId, bash_id: id, monitor: true },
	});
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
			"Subscribe to a change instead of polling. Pass command XOR path, never both: command watches a PTY session, where newline-terminated output lines (stderr merged) that match filter arrive as injected events while you keep working and command exit always delivers a summary event; path natively watches one file and fires once: create (the default) fires only when the file appears after registration, so watch a file that already exists with event modify. The path branch takes no filter and no persistent. Identical consecutive line-only update batches are deduped, so a watcher reprinting unchanged status does not re-wake the session. Returns a bash_id immediately; peek with bash_output, stop with kill_bash.",
		promptSnippet:
			"Subscribe to a command's output or a file's create/modify event as injected events instead of polling",
		promptGuidelines: [
			"Waiting on observable state (CI checks, builds, log patterns, deploys, a file landing) means a monitor, never a foreground sleep/poll loop.",
			'Waiting for one file to appear or change is the path branch: `monitor({ description, path, event? })` beats wrapping `test -f` in a shell poll loop; a file that already exists needs `event: "modify"`, since `create` only fires on appearance, and registration needs the parent directory to exist already — when the run creates that directory too, use the `command` branch instead.',
			"Shape the command for the events you need: one-shot gate = `until <cond>; do sleep 1; done; printf 'READY\\n'` with filter ^READY$; stream = `tail -n 0 -F <log> | grep --line-buffered <pat>` with persistent: true, then kill_bash.",
			"Sleep loops belong INSIDE the monitor command, never in your turn: about to sleep, re-poll bash_output, or foreground-block on a long command means register a monitor and keep working.",
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
				if (input.bash_id === undefined || input.bash_id.length === 0) {
					const resumed = registry.resume();
					if (resumed.length === 0) return textResult("No paused monitors to re-arm.");
					ctx.onMonitorsResumed?.(resumed.map((monitor) => monitor.id));
					const total = resumed.reduce((sum, monitor) => sum + monitor.mutedDropped, 0);
					return textResult(
						total > 0
							? `Re-armed ${resumed.length} paused monitor(s) (${total} line(s) dropped while muted).`
							: `Re-armed ${resumed.length} paused monitor(s).`,
					);
				}
				const bashId = resolveTerminalId(ctx.manager, input.bash_id);
				const dropped = registry.mutedDropped(bashId);
				const outcome = registry.rearm(bashId);
				if (outcome === "not_found") return errorResult(`No active monitor found with id: ${bashId}`);
				if (outcome === "not_paused") return textResult(`Monitor ${bashId} is not paused; no action taken.`);
				ctx.onMonitorRearmed?.(bashId);
				return textResult(
					dropped > 0
						? `Monitor ${bashId} re-armed (${dropped} line(s) dropped while muted).`
						: `Monitor ${bashId} re-armed.`,
				);
			}
			const fileInput = isFileCreateInput(input);
			const commandInput = isCreateInput(input);
			if (fileInput && commandInput) return errorResult("monitor accepts either command or path, not both.");
			if (fileInput) {
				if (input.filter !== undefined || input.persistent)
					return errorResult("Native file monitors do not support filter or persistent.");
				if (!ctx.monitorRegistry)
					return errorResult("Native file monitors require a lifecycle-owned monitor registry.");
				try {
					const { id, monitorId } = await ctx.monitorRegistry.registerFile({
						description: input.description,
						path: input.path,
						event: input.event ?? "create",
						timeoutMs: resolveTimeoutMs(input.timeout_ms),
						cwd: execCtx?.cwd ?? ctx.cwd,
						...((input as Record<string | symbol, unknown>)[APPROVED_MONITOR_PARENT] !== undefined
							? {
									approvedParent: (input as Record<string | symbol, unknown>)[
										APPROVED_MONITOR_PARENT
									] as string,
								}
							: {}),
					});
					ctx.manager.bindMonitorId(monitorId, id);
					return textResult(`Monitor started with ID: ${monitorId}`, {
						details: { monitor_id: monitorId, bash_id: id, monitor: true },
					});
				} catch (error) {
					return errorResult(error instanceof Error ? error.message : String(error));
				}
			}
			if (!commandInput) return errorResult("monitor requires description and command or path to start a watcher.");
			return createMonitor(ctx, registry, input, execCtx);
		},
	};
}
