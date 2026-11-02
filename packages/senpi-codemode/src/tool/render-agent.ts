import {
	appendLines,
	assertNever,
	type RenderEnvironment,
	renderPrefixed,
	type StatusPresentation,
	spinner,
	style,
} from "./render-blocks.ts";
import { eventString } from "./render-status.ts";
import { formatDuration } from "./tool-widgets.ts";
import type { EvalStatusEvent } from "./types.ts";

type AgentStatus = "pending" | "running" | "completed" | "failed" | "aborted";

function eventNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function agentStatus(value: unknown): AgentStatus {
	switch (value) {
		case "pending":
		case "running":
		case "completed":
		case "failed":
		case "aborted":
			return value;
		default:
			return "running";
	}
}

function coalesceAgentEvents(events: readonly EvalStatusEvent[]): EvalStatusEvent[] {
	const rows: EvalStatusEvent[] = [];
	const indexes = new Map<string, number>();
	for (const event of events) {
		const id = eventString(event.id);
		if (id === undefined) {
			rows.push(event);
			continue;
		}
		const index = indexes.get(id);
		if (index === undefined) {
			indexes.set(id, rows.length);
			rows.push(event);
		} else rows[index] = event;
	}
	return rows;
}

function agentPresentation(status: AgentStatus, spinnerFrame: number | undefined): StatusPresentation {
	switch (status) {
		case "pending":
			return { label: "pending", icon: "○", color: "muted" };
		case "running":
			return { label: "running", icon: spinner(spinnerFrame), color: "warning" };
		case "completed":
			return { label: "done", icon: "✓", color: "success" };
		case "failed":
			return { label: "failed", icon: "✗", color: "error" };
		case "aborted":
			return { label: "aborted", icon: "×", color: "error" };
		default:
			return assertNever(status);
	}
}

export function renderAgentProgressEvents(
	events: readonly EvalStatusEvent[],
	environment: RenderEnvironment,
): string[] {
	const rows = coalesceAgentEvents(events);
	const lines: string[] = [];
	// Senpi Theme has no tree-token API; fixed ├/└/│ glyphs intentionally mirror omp.
	for (const [index, event] of rows.entries()) {
		const isLast = index === rows.length - 1;
		const status = agentStatus(event.status);
		const presentation = agentPresentation(status, environment.spinnerFrame);
		const id = eventString(event.id) ?? "agent";
		const styledId = environment.theme === undefined ? id : environment.theme.bold(id);
		let body = `${style(environment.theme, presentation.color, presentation.icon)} ${styledId} ${presentation.label}`;
		if (status === "completed" || status === "failed" || status === "aborted") {
			const duration = eventNumber(event.durationMs);
			if (duration > 0) body += ` · ${style(environment.theme, "dim", formatDuration(duration))}`;
		}
		const branch = isLast ? "└ " : "├ ";
		const continuation = isLast ? "  " : "│ ";
		appendLines(
			lines,
			renderPrefixed(body, environment, { prefix: branch, continuation: continuation, color: "dim" }),
		);
		if (status !== "running") continue;
		const currentTool = eventString(event.currentTool);
		const lastIntent = eventString(event.lastIntent);
		if (currentTool === undefined && lastIntent === undefined) continue;
		const detail =
			currentTool === undefined
				? (lastIntent ?? "")
				: `${currentTool}${lastIntent === undefined ? "" : `: ${lastIntent}`}`;
		appendLines(
			lines,
			renderPrefixed(detail, environment, {
				prefix: `${continuation}└ `,
				continuation: `${continuation}  `,
				color: "dim",
			}),
		);
	}
	return lines;
}
