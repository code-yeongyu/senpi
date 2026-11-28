// omo#12108: a `ps` stand-in for the start-time readers. It renders one fixed instant as `ps -o lstart=` does (C
// locale: `Sun Nov  1 01:30:00 2026`) in the timezone of the environment it is started with, falling back to this
// process's TZ like a child that inherits it. Its default instant is in the repeated hour of a daylight-saving
// fall-back: New York reads 01:30 twice on 2026-11-01, and only a UTC rendering names one instant.
export const REPEATED_HOUR_START_MS = Date.parse("2026-11-01T06:30:00Z");

export function renderLstart(epochMs: number, timeZone: string): string {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone,
			weekday: "short",
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			year: "numeric",
			hourCycle: "h23",
		})
			.formatToParts(new Date(epochMs))
			.map((part) => [part.type, part.value]),
	);
	return `${parts.weekday} ${parts.month} ${String(parts.day).padStart(2, " ")} ${parts.hour}:${parts.minute}:${parts.second} ${parts.year}`;
}

export interface PsCall {
	readonly command: string;
	readonly args: readonly string[];
}

/** A `ps` that answers every query with `startedAtMs`, between `prefix` (a pid column) and `suffix` (a command). */
export function fakePs(startedAtMs = REPEATED_HOUR_START_MS, prefix = "", suffix = "") {
	const calls: PsCall[] = [];
	const run = async (command: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string> => {
		calls.push({ command, args });
		const timeZone = env?.TZ ?? process.env.TZ ?? "UTC";
		return `${prefix}${renderLstart(startedAtMs, timeZone)}${suffix}\n`;
	};
	return { run, calls };
}
