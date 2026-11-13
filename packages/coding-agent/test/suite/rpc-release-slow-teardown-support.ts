/**
 * A session whose runtime is still stopping after its release has answered. The real host closes a session within
 * its close grace; a `session_shutdown` handler that has not returned keeps the runtime, and with it the session's
 * file hold, alive past that grace. The handler here is held until the test lets it go.
 */
import { vi } from "vitest";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";

export interface HeldShutdown {
	readonly extension: ExtensionFactory;
	/** Whether the handler was entered, which is what makes the runtime outlive the grace. */
	readonly ran: () => boolean;
	readonly letGo: () => void;
}

export function heldShutdown(): HeldShutdown {
	let letGo = () => {};
	const gate = new Promise<void>((resolve) => {
		letGo = resolve;
	});
	let ran = false;
	return {
		extension: (pi) => {
			pi.on("session_shutdown", async () => {
				ran = true;
				await gate;
			});
		},
		ran: () => ran,
		letGo: () => letGo(),
	};
}

/**
 * Resolves when a runtime lets go of its session file, which is the last step of its dispose. The call goes
 * through. Subscribe before the release, so the moment cannot be missed; the caller restores the spy.
 */
export function fileHoldLetGo(): Promise<void> {
	return new Promise((resolve) => {
		const letGo = AgentSessionRuntime.prototype.releaseSessionHold;
		vi.spyOn(AgentSessionRuntime.prototype, "releaseSessionHold").mockImplementation(function (
			this: AgentSessionRuntime,
		) {
			letGo.call(this);
			resolve();
		});
	});
}
