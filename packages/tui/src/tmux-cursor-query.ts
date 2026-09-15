import { execFileSync } from "node:child_process";
import type { CursorPosition } from "./terminal.ts";
import type { TmuxExecFile } from "./tmux-image-probe.ts";

/** tmux swallows private DECXCPR. Sample its pane cursor out of band instead. */
export function queryTmuxCursorPosition(
	pane: string,
	deadline: number,
	execFile?: TmuxExecFile,
): Promise<CursorPosition | undefined> {
	const read = (): CursorPosition | undefined => {
		const remaining = deadline - Date.now();
		if (remaining <= 0) return undefined;
		try {
			const args = ["display-message", "-p", "-t", pane, "#{cursor_y} #{cursor_x}"];
			const output = execFile
				? execFile("tmux", args)
				: execFileSync("tmux", args, {
						encoding: "utf8",
						timeout: remaining,
						stdio: ["ignore", "pipe", "ignore"],
					});
			const match = /^(\d+) (\d+)$/.exec(output.trim());
			if (!match || Date.now() >= deadline) return undefined;
			const row = Number(match[1]) + 1;
			const column = Number(match[2]) + 1;
			return Number.isSafeInteger(row) && Number.isSafeInteger(column) ? { row, column } : undefined;
		} catch {
			// Missing tmux, detached panes and command timeouts all leave placement unknown.
			return undefined;
		}
	};
	const first = read();
	if (!first || deadline - Date.now() <= 10) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		setTimeout(() => {
			const second = read();
			resolve(second?.row === first.row && second.column === first.column ? second : undefined);
		}, 10);
	});
}
