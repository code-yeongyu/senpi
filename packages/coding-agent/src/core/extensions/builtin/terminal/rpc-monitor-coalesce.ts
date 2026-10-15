/**
 * Keeps `events: "all"` readable: streaming records collapse per session into one line per 2 s window
 * (`streaming +<n> deltas (last: "...")`), and surface churn (`loaded_surfaces_changed`,
 * `commands_changed`) into one line per session per 5 s with its count. A window opens on its first
 * record and flushes when it closes; nothing is delayed beyond its window.
 */
import type { RpcRecord } from "./rpc-monitor-observer.ts";

export const DELTA_WINDOW_MS = 2_000;
export const SURFACE_WINDOW_MS = 5_000;
const DELTA_KINDS = new Set(["message_update", "tool_execution_update", "bash_execution_update"]);
const SURFACE_KINDS = new Set(["loaded_surfaces_changed", "commands_changed"]);
const LAST_TEXT_LIMIT = 60;

interface Window {
	count: number;
	last: string;
	readonly timer: ReturnType<typeof setTimeout>;
}

export class RpcMonitorCoalescer {
	readonly #windows = new Map<string, Window>();
	readonly #flush: (line: string) => void;

	constructor(flush: (line: string) => void) {
		this.#flush = flush;
	}

	/** Takes a coalesced kind into its window; false for every other kind (the caller renders it). */
	accept(sessionKey: string, label: () => string, record: RpcRecord): boolean {
		const type = String(record.type);
		const delta = DELTA_KINDS.has(type);
		if (!delta && !SURFACE_KINDS.has(type)) return false;
		const key = delta ? `${sessionKey}#deltas` : `${sessionKey}#${type}`;
		const open = this.#windows.get(key);
		const last = delta ? lastText(record) : "";
		if (open !== undefined) {
			open.count += 1;
			if (last !== "") open.last = last;
			return true;
		}
		const window: Window = {
			count: 1,
			last,
			timer: setTimeout(
				() => {
					this.#windows.delete(key);
					this.#flush(
						delta
							? `rpc ${label()} streaming +${window.count} deltas${window.last === "" ? "" : ` (last: "${window.last}")`}`
							: `rpc ${label()} ${type} x${window.count}`,
					);
				},
				delta ? DELTA_WINDOW_MS : SURFACE_WINDOW_MS,
			),
		};
		this.#windows.set(key, window);
		return true;
	}

	dispose(): void {
		for (const window of this.#windows.values()) clearTimeout(window.timer);
		this.#windows.clear();
	}
}

function lastText(record: RpcRecord): string {
	const event = record.assistantMessageEvent as Record<string, unknown> | undefined;
	// Only answer text: a thinking delta is not what the session is saying.
	const text =
		event?.type === "text_delta" && typeof event.delta === "string"
			? event.delta
			: typeof record.output === "string"
				? record.output
				: "";
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > LAST_TEXT_LIMIT ? flat.slice(-LAST_TEXT_LIMIT) : flat;
}
