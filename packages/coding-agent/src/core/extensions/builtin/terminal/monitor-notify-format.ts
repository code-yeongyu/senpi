/**
 * Rendering of monitor wakes: one event body, a monitor's group header, and the size of a
 * monitor's share of a wake, so the notifier can fill a wake by whole monitors without clipping.
 */
import type { MonitorEvent } from "./monitor-registry.ts";
import { sanitizeTerminalOutput } from "./output-format.ts";

export const SYSTEM_REMINDER_OPEN = "<system-reminder>";
export const SYSTEM_REMINDER_CLOSE = "</system-reminder>";
export const WAKE_BUDGET_PAUSE_NOTICE =
	"Monitor paused after repeated updates. Completion still wakes this session; peek bash_output or re-arm only for intermediate events.";

export function eventBody(event: MonitorEvent): string {
	const value = event.type === "line" ? event.line : event.summary;
	return sanitizeTerminalOutput(value)
		.replace(/[\r\n]+/g, " ")
		.trimEnd();
}

export function renderedLength(event: MonitorEvent): number {
	return `Monitor event(${event.description}): ${eventBody(event)}`.length;
}

function groupHeader(description: string): string {
	return `Monitor event(${description}): `;
}

/** Characters one monitor adds to a wake: its group, its overflow notice, and their separators. */
export function monitorShareChars(events: readonly MonitorEvent[], notice: string): number {
	const first = events[0];
	const group =
		first === undefined
			? 0
			: groupHeader(first.description).length +
				events.reduce((total, event) => total + eventBody(event).length + 1, 0);
	return group + (notice.length > 0 ? notice.length + 1 : 0);
}

function formatEvents(events: readonly MonitorEvent[]): string {
	const groups = new Map<string, { description: string; bodies: string[] }>();
	for (const event of events) {
		const group = groups.get(event.id) ?? { description: event.description, bodies: [] };
		group.bodies.push(eventBody(event));
		groups.set(event.id, group);
	}
	return [...groups.values()].map((group) => `${groupHeader(group.description)}${group.bodies.join("\n")}`).join("\n");
}

/**
 * A single summary or overflow notice can exceed a whole wake. Preserve that text in the
 * session message details and keep any pause instruction visible within the same budget.
 */
export function buildWakeMessage(
	events: readonly MonitorEvent[],
	notices: readonly string[],
	pauseNotice: string,
	maxChars: number,
): { content: string; fullWakeText?: string } {
	const fullWakeText = [formatEvents(events), ...notices].filter(Boolean).join("\n");
	const pause = pauseNotice && fullWakeText ? `\n${pauseNotice}` : pauseNotice;
	const available = maxChars - SYSTEM_REMINDER_OPEN.length - SYSTEM_REMINDER_CLOSE.length - pause.length;
	if (fullWakeText.length <= available) {
		return { content: `${SYSTEM_REMINDER_OPEN}${fullWakeText}${pause}${SYSTEM_REMINDER_CLOSE}` };
	}
	const marker = "\n[Shortened; full text in session message details.fullWakeText.]";
	const prefix = fullWakeText.slice(0, Math.max(0, available - marker.length));
	return { content: `${SYSTEM_REMINDER_OPEN}${prefix}${marker}${pause}${SYSTEM_REMINDER_CLOSE}`, fullWakeText };
}
