import type { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

/**
 * The members every hand-built fake `AgentSession` in these tests must carry, because the runtime reads them on
 * real paths: `settingsManager` on every permission-preset change and runtime replacement (#3420, #3476). Every
 * fake session spreads this first and adds only what its test needs, so the fakes cannot drift from what the
 * runtime reads.
 */
export function fakeSessionBase(options: { cwd: string; agentDir: string; sessionManager: SessionManager }) {
	return {
		sessionManager: options.sessionManager,
		settingsManager: SettingsManager.create(options.cwd, options.agentDir),
		agentDir: options.agentDir,
		// list_sessions publishes this row for every entry (#3576); a fake session has no tool child.
		toolChildRow: () => ({ state: "none" as const }),
		// AgentSessionRuntime.dispose() awaits this before releasing the session hold (#3576); a fake has no child.
		whenToolChildClosed: () => Promise.resolve(),
	};
}
