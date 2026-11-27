import { afterEach, describe, expect, it, vi } from "vitest";
import { type LiveHarness, liveHarness } from "../todo-liveness-harness.ts";

// senpi#1146 review: the todo widget reads every liveness input of the session's one watcher.

const harnesses: LiveHarness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.cleanup();
	vi.useRealTimers();
});

async function started(): Promise<LiveHarness> {
	const harness = await liveHarness();
	harnesses.push(harness);
	return harness;
}

describe("todo widget liveness inputs (senpi#1146)", () => {
	it("counts this session's running child-task record, not another session's, and drops it on the next refresh", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const harness = await started();
		harness.childRecord("running");
		harness.childRecord("running", "another-session", "other.json");

		expect(await harness.resynced(() => harness.emit("session_start"))).toContain("[•] Open the pull request");

		harness.childRecord("completed");
		expect(await harness.resynced(() => vi.advanceTimersByTimeAsync(4000))).not.toContain("[•]");
	});

	it("counts a monitor with a deadline as live work and a persistent one not", async () => {
		const harness = await started();
		await harness.emit("session_start");

		const bounded = harness.monitor({ persistent: false, deadlineMs: 60_000 });
		expect(await harness.resynced(bounded)).toContain("[•] Open the pull request");
		const openEnded = harness.monitor({ persistent: true, deadlineMs: null });
		expect(await harness.resynced(openEnded)).not.toContain("[•]");
	});

	it("lets a pending block win over live work and returns the mark when it settles", async () => {
		const harness = await started();
		await harness.emit("session_start");

		expect(await harness.resynced(harness.wake("senpi-task", 1))).toContain("[•] Open the pull request");
		expect(await harness.resynced(harness.blocked(true))).not.toContain("[•]");
		expect(await harness.resynced(harness.blocked(false))).toContain("[•] Open the pull request");
	});

	it("after a rebind, takes a live bounded monitor from the snapshot its owner re-publishes", async () => {
		const harness = await started();
		await harness.emit("session_start");
		await harness.emit("session_shutdown");
		await harness.emit("session_start");

		const replayed = harness.monitor({ persistent: false, deadlineMs: 60_000 });
		expect(await harness.resynced(replayed)).toContain("[•] Open the pull request");
	});
});
