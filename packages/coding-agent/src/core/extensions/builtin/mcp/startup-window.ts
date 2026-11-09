/**
 * Startup windows for the RPC MCP inventory (senpi#4828).
 *
 * While a session's MCP attach is running, and until every connect that attach backgrounded has settled (connected,
 * failed, or timed out by its own `connectTimeoutMs`), inventory changes for that session are held instead of being
 * announced one by one. How many intermediate inventories a capture happens to see depends on how parallel connects
 * interleave and on how often a client reads the inventory, so announcing them made the startup event count depend on
 * timing. When the session's last open window closes it releases what it held exactly once: a `startup-settled`
 * announcement when any of its attaches started a connect, otherwise the plain change it withheld, if any.
 */

export type StartupWindowRelease = "startup-settled" | "withheld";

interface WindowState {
	open: number;
	connects: number;
	withheld: boolean;
}

export interface McpStartupWindow {
	/** Close after `connects` settle; `release` runs once, for the session's last open window, when it held anything. */
	close(connects: readonly Promise<void>[], release: (kind: StartupWindowRelease) => Promise<unknown>): Promise<void>;
}

export class McpStartupWindows {
	readonly #windows = new Map<string, WindowState>();

	open(sessionId: string): McpStartupWindow {
		const state = this.#windows.get(sessionId) ?? { open: 0, connects: 0, withheld: false };
		state.open += 1;
		this.#windows.set(sessionId, state);
		return {
			close: async (connects, release) => {
				state.connects += connects.length;
				await Promise.allSettled(connects);
				state.open -= 1;
				if (state.open > 0 || this.#windows.get(sessionId) !== state) return;
				this.#windows.delete(sessionId);
				if (state.connects > 0) await release("startup-settled");
				else if (state.withheld) await release("withheld");
			},
		};
	}

	/** True while `sessionId` has an open window; the change it was asked about is then held for the release. */
	hold(sessionId: string | undefined): boolean {
		const state = sessionId === undefined ? undefined : this.#windows.get(sessionId);
		if (state === undefined) return false;
		state.withheld = true;
		return true;
	}

	clear(): void {
		this.#windows.clear();
	}
}
