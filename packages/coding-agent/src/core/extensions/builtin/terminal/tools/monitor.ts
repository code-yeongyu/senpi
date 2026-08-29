import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { resolveMonitorFilePathForExecution } from "../../permission-system/monitor-file-path.ts";
import { FileMonitorRegistrationError } from "../file-monitor-registry.ts";
import { MonitorRegistry, MonitorRegistryCapacityError } from "../monitor-registry.ts";
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
			description:
				"Create: shell command to run and watch in a PTY-backed monitor session. Mutually exclusive with path.",
		}),
	),
	path: Type.Optional(
		Type.String({
			minLength: 1,
			description: "Create: file path to watch natively without shell polling. Mutually exclusive with command.",
		}),
	),
	event: Type.Optional(
		StringEnum(["create", "modify"] as const, {
			description: "Path watch event. Defaults to create.",
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
		Type.Boolean({ description: "Command watches only: keep watching until command exit or kill_bash." }),
	),
	bash_id: Type.Optional(
		Type.String({ description: "Rearm (required): paused monitor id (bash_N or watch_N) to resume." }),
	),
});
export type MonitorInput = Static<typeof monitorSchema>;

type MonitorCreateInput = MonitorInput & { description: string; command: string };
type FileMonitorCreateInput = MonitorInput & { description: string; path: string };

function isCreateInput(input: MonitorInput): input is MonitorCreateInput {
	return (
		typeof input.description === "string" &&
		input.description.length > 0 &&
		typeof input.command === "string" &&
		input.command.length > 0
	);
}

function isFileCreateInput(input: MonitorInput): input is FileMonitorCreateInput {
	return (
		typeof input.description === "string" &&
		input.description.length > 0 &&
		typeof input.path === "string" &&
		input.path.length > 0
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
	try {
		registry.assertCapacity();
	} catch (error) {
		if (error instanceof MonitorRegistryCapacityError) return errorResult(error.message);
		throw error;
	}
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
	try {
		registry.register({
			id,
			description: input.description,
			runtime,
			filter,
			onBeforeEvents: ctx.onMonitorRearmed,
		});
	} catch (error) {
		await ctx.manager.stop(id);
		if (error instanceof MonitorRegistryCapacityError) return errorResult(error.message);
		throw error;
	}
	return textResult(`Monitor started with ID: ${id}`, { details: { bash_id: id, monitor: true } });
}

async function createFileMonitor(
	ctx: TerminalToolContext,
	registry: MonitorRegistry,
	input: FileMonitorCreateInput,
	execCtx: { cwd?: string } | undefined,
): Promise<TerminalToolResult> {
	const resolution = resolveMonitorFilePathForExecution(input, input.path, execCtx?.cwd ?? ctx.cwd);
	if (!resolution.ok) return errorResult(resolution.message);
	try {
		const id = await registry.registerFile({
			description: input.description,
			path: resolution.value.canonicalPath,
			displayPath: resolution.value.logicalAbsolutePath,
			logicalParent: resolution.value.logicalParent,
			parentIdentity: {
				device: resolution.value.parentDevice,
				inode: resolution.value.parentInode,
			},
			event: input.event ?? "create",
			timeoutMs: resolveTimeoutMs(input.timeout_ms),
			onBeforeWatch: ctx.onMonitorRearmed,
		});
		return textResult(`Monitor started with ID: ${id}`, {
			details: { bash_id: id, monitor: true, watch_id: id },
		});
	} catch (error) {
		if (error instanceof FileMonitorRegistrationError || error instanceof MonitorRegistryCapacityError) {
			return errorResult(error.message);
		}
		throw error;
	}
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
			"Subscribe to command output or a native file create/modify event instead of polling. Command watches stream matching PTY lines and always summarize exit; path watches emit once and end. Identical consecutive line-only batches are deduped.",
		promptSnippet: "Subscribe to command output or native file events instead of polling",
		promptGuidelines: [
			"Waiting on observable state (CI checks, builds, log patterns, deploys) means a monitor, never a foreground sleep/poll loop.",
			"Artifact file creation or modification means `path` plus `event`; use this instead of `until test -f ...; do sleep ...`.",
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
			if (input.action === "rearm") {
				const createOnlyField = (
					["description", "command", "path", "event", "filter", "timeout_ms", "persistent"] as const
				).find((field) => input[field] !== undefined);
				if (createOnlyField) return errorResult(`monitor rearm does not accept ${createOnlyField}.`);
				const registry = getRegistry();
				const bashId = input.bash_id;
				if (bashId === undefined || bashId.length === 0) return errorResult("monitor rearm requires bash_id.");
				const outcome = registry.rearm(bashId);
				if (outcome === "not_found") return errorResult(`No active monitor found with id: ${bashId}`);
				if (outcome === "not_paused") return textResult(`Monitor ${bashId} is not paused; no action taken.`);
				ctx.onMonitorRearmed?.(bashId);
				return textResult(`Monitor ${bashId} re-armed.`);
			}
			const commandInput = isCreateInput(input);
			const fileInput = isFileCreateInput(input);
			if (commandInput && fileInput) {
				return errorResult("monitor accepts either command or path, not both.");
			}
			if (fileInput) {
				if (input.filter !== undefined) return errorResult("monitor filter is only supported with command.");
				if (input.persistent) return errorResult("persistent file monitors are not supported.");
				const registry = ctx.monitorRegistry;
				if (!registry) return errorResult("Native file monitors require a lifecycle-owned monitor registry.");
				return createFileMonitor(ctx, registry, input, execCtx);
			}
			if (commandInput) {
				if (input.event !== undefined) return errorResult("monitor event is only supported with path.");
				return createMonitor(ctx, getRegistry(), input, execCtx);
			}
			return errorResult("monitor requires description and command or path to start a watcher.");
		},
	};
}
