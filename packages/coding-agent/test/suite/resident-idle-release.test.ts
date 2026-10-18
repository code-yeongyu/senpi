import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

/**
 * The idle path tokenizes `agent.state.messages` in place so the resident store
 * can drop its hydrated copies. Two contracts follow from that:
 *
 * 1. Every reader that runs between two turns (`session.messages` and the
 *    estimators behind it) must still read text, never a resident sentinel.
 * 2. The release only frees memory for strings the store already spilled to its
 *    blob backing, so an idle on a session that never evicted must keep the
 *    memoized materialized views instead of forcing the next read to rebuild.
 */

const LARGE_ENTRY_PAYLOAD = "x".repeat(1024 * 1024);
/** 70 MiB of custom entries: past the store's 64 MiB budget, so eviction runs. */
const OVER_BUDGET_ENTRY_COUNT = 70;
const RESIDENT_BUDGET_BYTES = 64 * 1024 * 1024;
/** `RESIDENT_STRING_PREFIX` from session-resident-store.ts, as it survives JSON.stringify. */
const RESIDENT_TOKEN_MARKER = "senpi-resident-string";

function fillResidentStorePastBudget(harness: Harness): void {
	for (let index = 0; index < OVER_BUDGET_ENTRY_COUNT; index++) {
		harness.sessionManager.appendCustomEntry("large-metadata", { payload: `${index}:${LARGE_ENTRY_PAYLOAD}` });
	}
}

/** Subscribes to `agent_idle` before the turn starts, so nothing here polls or sleeps. */
async function promptUntilIdle(harness: Harness, text: string): Promise<void> {
	const idle = new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "agent_idle") return;
			unsubscribe();
			resolve();
		});
	});
	harness.setResponses([fauxAssistantMessage("ack")]);
	await harness.session.prompt(text);
	await idle;
}

describe("resident store idle release", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("session.messages holds real text after agent_idle", async () => {
		// Given: a persisted session whose store has spilled past its budget.
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		fillResidentStorePastBudget(harness);
		const large = "u".repeat(40 * 1024);

		// When: a turn runs to completion and the session settles.
		await promptUntilIdle(harness, large);

		// Then: the settled transcript reads as text for every consumer.
		expect(harness.events.at(-1)?.type).toBe("agent_idle");
		expect(getUserTexts(harness)).toContain(large);
		expect(JSON.stringify(harness.session.messages)).not.toContain(RESIDENT_TOKEN_MARKER);
	});

	it("idle keeps the materialized views when nothing was evicted", async () => {
		// Given: a persisted session small enough that the store never spilled.
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const dropMaterializedCaches = vi.spyOn(harness.sessionManager, "dropMaterializedCaches");

		// When: a turn runs to completion and the session settles.
		await promptUntilIdle(harness, "hello");

		// Then: nothing was released, because nothing would have been freed.
		expect(harness.sessionManager.getResidentStoreStats().evictedCount ?? 0).toBe(0);
		expect(dropMaterializedCaches).not.toHaveBeenCalled();
	});

	it("idle releases the views once the store has evicted", async () => {
		// Given: a persisted session whose store has spilled past its budget.
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		fillResidentStorePastBudget(harness);
		const dropMaterializedCaches = vi.spyOn(harness.sessionManager, "dropMaterializedCaches");

		// When: a turn runs to completion and the session settles.
		await promptUntilIdle(harness, "hello");

		// Then: the views are released and the store stays inside its budget.
		expect(dropMaterializedCaches.mock.calls.length).toBeGreaterThan(0);
		expect(harness.sessionManager.getResidentStoreStats().blobBytes).toBeLessThanOrEqual(RESIDENT_BUDGET_BYTES);
	});
});
