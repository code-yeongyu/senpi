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

function clip(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	if (maxChars <= 3) return text.slice(0, maxChars);
	return `${text.slice(0, maxChars - 3)}...`;
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
 * One wake message. The notifier fills a wake by whole monitors within `maxChars`, so the clip is a
 * last-resort guard that a correctly sized wake never reaches.
 */
export function buildWakeMessage(
	events: readonly MonitorEvent[],
	notices: readonly string[],
	pauseNotice: string,
	maxChars: number,
): string {
	const suffix = [...notices, pauseNotice].filter(Boolean).join("\n");
	const fixedChars = SYSTEM_REMINDER_OPEN.length + SYSTEM_REMINDER_CLOSE.length + (suffix ? suffix.length + 1 : 0);
	const body = clip(formatEvents(events), Math.max(0, maxChars - fixedChars));
	return `${SYSTEM_REMINDER_OPEN}${body}${body && suffix ? "\n" : ""}${suffix}${SYSTEM_REMINDER_CLOSE}`;
}
