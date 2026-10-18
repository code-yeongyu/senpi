// A newline-less stream must not grow the retained tail without bound; an over-cap line is
// truncated to its last MONITOR_LINE_BUFFER_MAX_CHARS characters.
export const MONITOR_LINE_BUFFER_MAX_CHARS = 65_536;

export class MonitorLineBuffer {
	#tail = "";

	append(chunk: string): string[] {
		let remaining = this.#tail + chunk;
		const lines: string[] = [];
		for (;;) {
			const newline = remaining.indexOf("\n");
			if (newline < 0) break;
			const rawLine = remaining.slice(0, newline);
			remaining = remaining.slice(newline + 1);
			lines.push(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
		}
		this.#tail =
			remaining.length > MONITOR_LINE_BUFFER_MAX_CHARS ? remaining.slice(-MONITOR_LINE_BUFFER_MAX_CHARS) : remaining;
		return lines;
	}
}
