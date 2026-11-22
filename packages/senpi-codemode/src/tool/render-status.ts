import type { Theme } from "@code-yeongyu/senpi";
import { type RenderEnvironment, STATUS_PREVIEW_COUNT, style } from "./render-blocks.ts";
import type { EvalStatusEvent } from "./types.ts";

export function eventString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function eventNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function plural(count: number, singular: string, pluralNoun: string): string {
	return `${count} ${count === 1 ? singular : pluralNoun}`;
}

function formatCallsPerSecond(calls: number, wallDurationMs: number | undefined): string {
	const seconds = typeof wallDurationMs === "number" && Number.isFinite(wallDurationMs) ? wallDurationMs / 1_000 : 0;
	if (seconds <= 0) return "n/a calls/s";
	return `${(calls / seconds).toFixed(2)} calls/s`;
}

// A cell that issued no tool calls has no throughput to report: emitting
// "0 calls · 0.00 calls/s" is noise, so the whole badge is dropped instead.
export function formatThroughputBadge(throughput: {
	readonly calls: number;
	readonly wallDurationMs: number | undefined;
}): string | undefined {
	if (throughput.calls <= 0) return undefined;
	return `${plural(throughput.calls, "call", "calls")} · ${formatCallsPerSecond(
		throughput.calls,
		throughput.wallDurationMs,
	)}`;
}

function statusIcon(op: string): string {
	if (op.startsWith("git_")) return "⌁";
	switch (op) {
		case "read":
		case "write":
		case "cat":
		case "touch":
			return "▣";
		case "ls":
		case "cd":
		case "pwd":
		case "mkdir":
			return "▤";
		case "run":
		case "sh":
			return "▶";
		case "completion":
			return "◇";
		case "phase":
			return "◆";
		default:
			return "•";
	}
}

function formatStatusEvent(event: EvalStatusEvent, theme: Theme | undefined): string {
	const op = event.op;
	const icon = style(theme, "muted", statusIcon(op));
	const error = eventString(event.error);
	if (error !== undefined) return `${icon} ${style(theme, "warning", op)}: ${style(theme, "dim", error)}`;
	const parts: string[] = [];
	switch (op) {
		case "read": {
			parts.push(`${eventNumber(event.chars ?? event.bytes)} chars`);
			const path = eventString(event.path);
			if (path !== undefined) parts.push(`from ${path}`);
			break;
		}
		case "write": {
			parts.push(`${eventNumber(event.chars ?? event.bytes)} chars`);
			const path = eventString(event.path);
			if (path !== undefined) parts.push(`to ${path}`);
			break;
		}
		case "cat":
			parts.push(plural(eventNumber(event.files), "file", "files"));
			parts.push(`${eventNumber(event.chars)} chars`);
			break;
		case "ls":
			parts.push(plural(eventNumber(event.count), "entry", "entries"));
			break;
		case "env": {
			const action = eventString(event.action);
			const key = eventString(event.key);
			const value = eventString(event.value) ?? "";
			if (action === "set" && key !== undefined) parts.push(`set ${key}=${value.slice(0, 30)}`);
			else if (action === "get" && key !== undefined) parts.push(`${key}=${value.slice(0, 30)}`);
			else parts.push(plural(eventNumber(event.count), "variable", "variables"));
			break;
		}
		case "git_status": {
			if (event.clean === true) parts.push("clean");
			else {
				const changes: string[] = [];
				for (const key of ["staged", "modified", "untracked"] as const) {
					const count = eventNumber(event[key]);
					if (count > 0) changes.push(`${count} ${key}`);
				}
				parts.push(changes.join(", ") || "unknown");
			}
			const branch = eventString(event.branch);
			if (branch !== undefined) parts.push(`on ${branch}`);
			break;
		}
		case "git_diff":
			parts.push(plural(eventNumber(event.lines), "line", "lines"));
			if (event.staged === true) parts.push("staged");
			break;
		case "git_log":
			parts.push(plural(eventNumber(event.commits), "commit", "commits"));
			break;
		case "run":
		case "sh": {
			const command = eventString(event.command ?? event.cmd);
			if (command !== undefined) parts.push(command);
			if (typeof event.exitCode === "number") parts.push(`exit ${event.exitCode}`);
			break;
		}
		case "completion": {
			const model = eventString(event.model);
			const tier = eventString(event.tier);
			if (model !== undefined) parts.push(model);
			if (tier !== undefined && tier !== model) parts.push(tier);
			parts.push(`${eventNumber(event.chars)} chars`);
			break;
		}
		case "log":
			parts.push(eventString(event.message) ?? "");
			break;
		case "phase":
			parts.push(eventString(event.title) ?? "");
			break;
		case "status-events-omitted":
			parts.push(`${eventNumber(event.count)} earlier events omitted`);
			break;
		default: {
			if (event.count !== undefined) parts.push(String(event.count));
			const path = eventString(event.path);
			if (path !== undefined) parts.push(path);
		}
	}
	const description = parts.filter((part) => part.length > 0).join(" · ");
	return `${icon} ${style(theme, "muted", op)}${description.length > 0 ? ` ${style(theme, "dim", description)}` : ""}`;
}

export function renderStatusEvents(events: readonly EvalStatusEvent[], environment: RenderEnvironment): string[] {
	// A bounded history stores its exact omission count in a leading marker event; fold that
	// count into the summary line so collapsing the preview can never understate omissions.
	const first = events[0];
	const omittedByBound = first?.op === "status-events-omitted" && typeof first.count === "number" ? first.count : 0;
	const visible = omittedByBound > 0 ? events.slice(1) : events;
	const retained = environment.expanded ? visible : visible.slice(-STATUS_PREVIEW_COUNT);
	const skipped = visible.length - retained.length + omittedByBound;
	const lines: string[] = [];
	if (skipped > 0) lines.push(style(environment.theme, "dim", `├ … ${skipped} earlier status events`));
	for (const [index, event] of retained.entries()) {
		const branch = index === retained.length - 1 ? "└" : "├";
		lines.push(`${style(environment.theme, "dim", branch)} ${formatStatusEvent(event, environment.theme)}`);
	}
	return lines;
}
