import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

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
				"Create, file branch (XOR command): one regular file to watch natively, whose parent directory must already exist; takes no filter.",
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
			description: "Watcher deadline in milliseconds (default 300000; ignored when persistent).",
		}),
	),
	persistent: Type.Optional(
		Type.Boolean({
			description:
				"Standing watch: no deadline, and it survives a session restart (command re-run once, file rescanned and any detached change reported). Expires 7 days after creation; no per-session cap unless the terminal.maxDurableMonitors setting sets one; stop one with kill_bash.",
		}),
	),
	bash_id: Type.Optional(
		Type.String({ description: "Rearm: paused monitor id (mon_ or bash_id) to resume; omit for all paused." }),
	),
});
export type MonitorInput = Static<typeof monitorSchema>;

export type MonitorCreateInput = MonitorInput & { description: string; command: string };
export type FileMonitorCreateInput = MonitorInput & { description: string; path: string };

export function isFileCreateInput(input: MonitorInput): input is FileMonitorCreateInput {
	return (
		typeof input.description === "string" &&
		input.description.length > 0 &&
		typeof input.path === "string" &&
		input.path.length > 0
	);
}

export function isCreateInput(input: MonitorInput): input is MonitorCreateInput {
	return (
		typeof input.description === "string" &&
		input.description.length > 0 &&
		typeof input.command === "string" &&
		input.command.length > 0
	);
}

export function resolveDimension(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
	return Math.trunc(value);
}

export function resolveTimeoutMs(value: number | undefined): number {
	const timeout = value ?? DEFAULT_MONITOR_TIMEOUT_MS;
	return Math.min(Math.max(Math.trunc(timeout), 1), MAX_MONITOR_TIMEOUT_MS);
}

export function compileFilter(filter: string | undefined): RegExp | undefined {
	if (filter === undefined) return undefined;
	return new RegExp(filter);
}
