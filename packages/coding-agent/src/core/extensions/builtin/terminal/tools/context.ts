import type { TerminalManager } from "../manager.ts";
import type { TerminalRuntimeSession } from "../runtime-session.ts";

/** Shared dependencies handed to every terminal tool factory. */
export interface TerminalToolContext {
	readonly manager: TerminalManager;
	readonly cwd: string;
	/** Explicit shell path from settings (settings-manager `shellPath`), if any. */
	readonly shellPath?: string;
	readonly defaultCols: number;
	readonly defaultRows: number;
	/** Resolve the environment for spawned sessions (mirrors core bash `getShellEnv`). */
	readonly getEnv: () => NodeJS.ProcessEnv;
	/** Notified when a background session exits, so the notify layer can wake the agent. */
	readonly onBackgroundExit?: (id: string, runtime: TerminalRuntimeSession) => void;
}

/** Minimal tool-result shape returned by the terminal tools. */
export interface TerminalToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown> | undefined;
	isError?: boolean;
}

export function textResult(
	text: string,
	extra?: { details?: Record<string, unknown>; isError?: boolean },
): TerminalToolResult {
	return { content: [{ type: "text", text }], details: extra?.details, isError: extra?.isError };
}

export function errorResult(text: string): TerminalToolResult {
	return { content: [{ type: "text", text }], details: undefined, isError: true };
}
