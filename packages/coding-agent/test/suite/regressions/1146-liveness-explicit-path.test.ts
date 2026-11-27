import { afterEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_MONITOR_STATE_EVENT } from "../../../src/core/extensions/builtin/monitor-state-event.ts";
import { cleanupLoaderSessions, loadedOrder, loaderSession } from "../liveness-loader-harness.ts";

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
			"binds the watcher ahead of a startup publisher outside the registry when no later builtin is selected (trust bootstrap: %s)",
			async (trust) => {
				const session = await loaderSession({
					enabledBuiltinExtensions: ["loop-guard"],
					explicitPaths: [`builtin:${consumer}`],
					trust,
					startupMonitorOwner: true,
				});
				await session.emit("session_start");

				expect(session.watchers()).toBe(1);
				const loaded = session.loaded();
				const watcher = loaded.indexOf("<builtin:session-liveness>");
				expect(loaded.indexOf("<builtin:loop-guard>")).toBeLessThan(watcher);
				expect(watcher).toBeLessThan(loaded.findIndex((path) => path.endsWith("owner.ts")));
				// The owner's monitor, published in its own session_start, is heard: the session reads working.
				expectWorking(session, consumer, true);
			},
		);

		it.each([false, true])(
			"binds the watcher ahead of an inline startup publisher when no later builtin is selected (trust bootstrap: %s)",
			async (trust) => {
				const session = await loaderSession({
					enabledBuiltinExtensions: ["loop-guard"],
					explicitPaths: [`builtin:${consumer}`],
					trust,
					startupMonitorOwner: "inline",
				});
				await session.emit("session_start");

				expect(session.watchers()).toBe(1);
				const loaded = session.loaded();
				expect(loaded.indexOf("<builtin:session-liveness>")).toBeLessThan(
					loaded.findIndex((path) => path.startsWith("<inline:")),
				);
				expectWorking(session, consumer, true);
			},
		);

		it.each([false, true])(
			"loads the watcher ahead of the bundled codemode extension when no later builtin is selected (trust bootstrap: %s)",
			async (trust) => {
				const loaded = await loadedOrder({
					enabledBuiltinExtensions: ["loop-guard", "codemode"],
					explicitPaths: [`builtin:${consumer}`],
					trust,
					bundledCodemode: true,
				});

				const watcher = loaded.indexOf("<builtin:session-liveness>");
				const codemode = loaded.findIndex((path) => path.includes("senpi-codemode"));
				expect(codemode).toBeGreaterThanOrEqual(0);
				expect(loaded.indexOf("<builtin:loop-guard>")).toBeLessThan(watcher);
				expect(watcher).toBeLessThan(codemode);
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
