import type { TerminalManager } from "../manager.ts";
import type { MonitorEvent, MonitorRegistry } from "../monitor-registry.ts";
import type { TerminalRuntimeSession } from "../runtime-session.ts";
import type { TimeoutAction } from "../settings.ts";

/** Shared dependencies handed to every terminal tool factory. */
export interface TerminalToolContext {
	readonly manager: TerminalManager;
	readonly cwd: string;
	/** Explicit shell path from settings (settings-manager `shellPath`), if any. */
	readonly shellPath?: string;
	readonly defaultCols: number;
	readonly defaultRows: number;
	/** Configured foreground deadline behavior; omitted direct contexts default to background. */
	readonly timeoutAction?: TimeoutAction;
	/** Resolve the environment for spawned sessions (mirrors core bash `getShellEnv`). */
	readonly getEnv: () => NodeJS.ProcessEnv;
	/**
	 * Current extension session context (set on session_start/model_select), used to
	 * expose PI_* session metadata to spawned commands like the core bash tool does.
	 */
	readonly getSessionContext?: () => import("../../../types.ts").ExtensionContext | undefined;
	/** Registers a session when it transitions to background liveness. */
	readonly onBackgroundStart?: (id: string, description: string, startedAtMs: number) => void;
	/** Notified when a background session exits, so the notify layer can wake the agent. */
	readonly onBackgroundExit?: (id: string, runtime: TerminalRuntimeSession) => void;
	/** Session-scoped monitor state, sharing the terminal manager's bash-id namespace. */
	readonly monitorRegistry?: MonitorRegistry;
	/** Receives filtered monitor line and terminal-summary events. */
	readonly onMonitorEvent?: (event: MonitorEvent) => void;
	/** Resets session-global wake-budget delivery for a fresh or explicitly rearmed monitor. */
	readonly onMonitorRearmed?: (id: string) => void;
	/** Clears notifier bookkeeping when multiple paused monitors are resumed. */
	readonly onMonitorsResumed?: (ids: readonly string[]) => void;
}

/** Minimal tool-result shape returned by the terminal tools. */
export interface TerminalToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown> | undefined;
	isError?: boolean;
}

/**
 * Resolve a stable "mon_" monitor id to its current runtime id (bash_N/watch_N), passing a
 * runtime id through unchanged. Companion tools may run against a manager that does not
 * implement `resolveId` (narrower embedder/test managers expose `get` only); such managers
 * have never seen a `mon_` id, so falling back to the id verbatim preserves the lookup they
 * already supported. This is the single choke point for that rule — do not inline it.
 */
export function resolveTerminalId(
	manager: Pick<TerminalManager, "get"> & Partial<Pick<TerminalManager, "resolveId">>,
	id: string,
): string {
	return manager.resolveId?.(id) ?? id;
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
