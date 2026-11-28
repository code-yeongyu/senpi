import { afterEach, describe, expect, it, vi } from "vitest";
import {
	TERMINAL_MONITOR_STATE_EVENT,
	WAKE_SOURCE_STATE_EVENT,
} from "../../../src/core/extensions/builtin/monitor-state-event.ts";
import { cleanupLoaderSessions, loaderSession } from "../liveness-loader-harness.ts";

// senpi#1146 review: the session liveness watcher is an internal dependency of the pane report and the todo
// widget. A builtin allowlist or denylist written before it existed must not lose it.

afterEach(() => {
	cleanupLoaderSessions();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("liveness watcher under builtin selection (senpi#1146)", () => {
	it("follows a turn in the pane report when the allowlist names only herdr", async () => {
		const session = await loaderSession({ enabledBuiltinExtensions: ["herdr"] });
		await session.emit("session_start");

		await session.emit("agent_start");
		expect(session.pane()).toBe("working");
		await session.emit("agent_settled");
		expect(session.pane()).toBe("idle");
	});

	it("draws the paused list when idle and the active mark in a turn when the allowlist names only the todo widget", async () => {
		const session = await loaderSession({ enabledBuiltinExtensions: ["todowrite"] });

		await session.emit("session_start");
		expect(session.todo()).not.toContain("[•]");
		await session.emit("agent_start");
		expect(session.todo()).toContain("[•] Open the pull request");
	});

	it.each([[["herdr", "todowrite"]], [["todowrite", "herdr"]]])(
		"loads one watcher with one poll and one subscriber per input for both consumers (allowlist %j)",
		async (enabledBuiltinExtensions) => {
			// The host session subscribes to some inputs itself; count what the extensions add over a consumer-free one.
			const hostOnly = await loaderSession({ enabledBuiltinExtensions: ["ask-user"] });
			await hostOnly.emit("session_start");
			const session = await loaderSession({ enabledBuiltinExtensions });
			await session.emit("session_start");

			expect(session.watchers()).toBe(1);
			expect(session.polls()).toBe(1);
			for (const channel of ["herdr:blocked", TERMINAL_MONITOR_STATE_EVENT, WAKE_SOURCE_STATE_EVENT]) {
				const added = session.subscribers(channel) - hostOnly.subscribers(channel);
				expect({ channel, added }).toEqual({ channel, added: 1 });
			}
		},
	);

	it("loads no watcher and starts no poll when neither consumer is selected", async () => {
		const session = await loaderSession({ enabledBuiltinExtensions: ["ask-user"] });
		await session.emit("session_start");

		expect(session.loaded()).not.toContain("<builtin:session-liveness>");
		expect(session.watchers()).toBe(0);
		expect(session.polls()).toBe(0);
	});

	it("loads the watcher after the guards and policy and ahead of every builtin that publishes liveness", async () => {
		const session = await loaderSession({
			enabledBuiltinExtensions: ["loop-guard", "hooks", "permission-system", "ask-user", "herdr", "todowrite"],
		});
		await session.emit("session_start");

		const order = session.loaded().filter((path) => path.startsWith("<builtin:"));
		expect(order).toEqual([
			"<builtin:loop-guard>",
			"<builtin:hooks>",
			"<builtin:permission-system>",
			"<builtin:session-liveness>",
			"<builtin:ask-user>",
			"<builtin:herdr>",
			"<builtin:todowrite>",
		]);
	});

	it("keeps both consumers working when a denylist names the watcher's id", async () => {
		const session = await loaderSession({ disabledBuiltinExtensions: ["session-liveness"] });
		await session.emit("session_start");
		expect(session.todo()).not.toContain("[•]");

		await session.emit("agent_start");
		expect(session.pane()).toBe("working");
		expect(session.todo()).toContain("[•] Open the pull request");
	});
});
