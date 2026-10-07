import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../../config.ts";
import type { TerminalTheme } from "./theme.ts";

interface TerminalThemeHint {
	readonly terminalTheme: TerminalTheme;
}

function hintPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "cache", "terminal-theme.json");
}

/**
 * The terminal's background is only knowable by asking it, and the answer arrives one OSC round
 * trip after the first frame is already on screen. Remembering the last answer lets the next launch
 * paint the right theme immediately; `COLORFGBG` is the only environment signal and most terminals
 * do not set it, so without this an `auto` user is repainted on every start.
 */
export function readTerminalThemeHint(agentDir?: string): TerminalTheme | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(hintPath(agentDir), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const value = (parsed as Partial<TerminalThemeHint>).terminalTheme;
		return value === "light" || value === "dark" ? value : undefined;
	} catch {
		return undefined;
	}
}

export function writeTerminalThemeHint(terminalTheme: TerminalTheme, agentDir?: string): void {
	try {
		const path = hintPath(agentDir);
		mkdirSync(dirname(path), { recursive: true });
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({ terminalTheme } satisfies TerminalThemeHint)}\n`);
		renameSync(temporary, path);
	} catch {
		// A cache that cannot be written must never break a launch.
	}
}
