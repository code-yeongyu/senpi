import { afterEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_MONITOR_STATE_EVENT } from "../../../src/core/extensions/builtin/monitor-state-event.ts";
import { cleanupLoaderSessions, loaderSession } from "../liveness-loader-harness.ts";

// senpi#1146 review: a consumer selected only by an explicit `builtin:<name>` path still gets the session's one
// watcher, in both final-assembly branches (plain reload and the project-trust bootstrap), bound ahead of every
// owner that re-publishes liveness state in its own session_start.

type Consumer = "herdr" | "todowrite";

afterEach(() => {
	cleanupLoaderSessions();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function explicitOnly(consumer: Consumer, options: { trust?: boolean; startupMonitorOwner?: boolean } = {}) {
	return loaderSession({ enabledBuiltinExtensions: ["ask-user"], explicitPaths: [`builtin:${consumer}`], ...options });
}

function expectWorking(session: Awaited<ReturnType<typeof loaderSession>>, consumer: Consumer, working: boolean): void {
	if (consumer === "herdr") expect(session.pane()).toBe(working ? "working" : "idle");
	else if (working) expect(session.todo()).toContain("[•] Open the pull request");
	else expect(session.todo()).not.toContain("[•]");
}

describe.each<Consumer>(["herdr", "todowrite"])(
	"liveness watcher for an explicit builtin:%s (senpi#1146)",
	(consumer) => {
		it.each([false, true])(
			"binds one watcher ahead of ask-user that hears an owner's startup re-publish (trust bootstrap: %s)",
			async (trust) => {
				const session = await explicitOnly(consumer, { trust, startupMonitorOwner: true });
				await session.emit("session_start");

				expect(session.watchers()).toBe(1);
				const loaded = session.loaded();
				expect(loaded.indexOf("<builtin:session-liveness>")).toBeGreaterThanOrEqual(0);
				expect(loaded.indexOf("<builtin:session-liveness>")).toBeLessThan(loaded.indexOf("<builtin:ask-user>"));
				// The owner's bounded monitor, published in its own session_start, keeps the session working.
				expectWorking(session, consumer, true);

				session.harness
					.getExtensionRunner()
					.emitBusEvent(TERMINAL_MONITOR_STATE_EVENT, { activeCount: 0, monitors: [] });
				expectWorking(session, consumer, false);
				await session.emit("agent_start");
				expectWorking(session, consumer, true);
				await session.emit("agent_settled");
				expectWorking(session, consumer, false);
			},
		);

		it.each([false, true])(
			"loads one watcher when settings and an explicit path both select the consumer (trust bootstrap: %s)",
			async (trust) => {
				const session = await loaderSession({
					enabledBuiltinExtensions: [consumer],
					explicitPaths: [`builtin:${consumer}`],
					trust,
				});
				await session.emit("session_start");

				expect(session.watchers()).toBe(1);
			},
		);
	},
);
