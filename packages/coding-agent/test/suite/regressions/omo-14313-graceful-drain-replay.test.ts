import { expect, it } from "vitest";
import type { AgentSessionEvent, AgentSessionEventListener } from "../../../src/core/agent-session.ts";
import { drainUntilQuiet } from "../../../src/modes/rpc/session-graceful-close.ts";

// oh-my-openagent#14313: `subscribe` replays standing events (here a selected settings source, which every daemon
// session with a settings file has) to a new listener at once. A drain that took a fresh listener on every pass read
// each replay as a change and spun the host's loop until its deadline, so the turn it waited for never got to stream
// and a graceful close of a busy session always timed out.

const SETTINGS_SOURCE: AgentSessionEvent = {
	type: "settings_source_selected",
	path: "/x/settings.json",
	format: "json",
	reason: "json-only",
	scope: "global",
};

it("a drain over a session that replays standing events on subscribe waits instead of spinning", async () => {
	const listeners = new Set<AgentSessionEventListener>();
	let subscriptions = 0;
	let busy = true;
	const session = {
		subscribe(listener: AgentSessionEventListener) {
			subscriptions++;
			listeners.add(listener);
			listener(SETTINGS_SOURCE);
			return () => listeners.delete(listener);
		},
		waitForIdle: () => Promise.resolve(),
	};
	// The turn ends on the next macrotask, as a streamed provider answer does; a spinning drain never lets it run.
	setTimeout(() => {
		busy = false;
		for (const listener of listeners) listener(SETTINGS_SOURCE);
	}, 0);
	const quiet = await drainUntilQuiet(
		session,
		{ busy: () => (busy ? ["an agent run"] : []), settling: () => [] },
		5_000,
	);
	expect({ quiet, subscriptions, listenersLeft: listeners.size }).toEqual({
		quiet: true,
		subscriptions: 1,
		listenersLeft: 0,
	});
});
