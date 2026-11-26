import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { createRpcConnectionHandler } from "../../../src/modes/rpc/connection-handler.ts";
import {
	ENTRY_WALK_HOLD_MS,
	entryPageBounds,
	pageEntries,
	RPC_RESPONSE_BYTE_BUDGET,
	setResponseByteBudgetForTesting,
} from "../../../src/modes/rpc/get-entries-page.ts";
import { createHarness, type Harness } from "../harness.ts";

type Answer = {
	id?: string;
	success?: boolean;
	errorCode?: string;
	data?: { entries: { id: string }[]; leafId: string | null; hasMore?: boolean; nextSince?: string };
};

describe("#3534 get_entries in bounded pages", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.useRealTimers();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function connectedSession(turns: number) {
		const harness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses(Array.from({ length: turns }, (_, turn) => fauxAssistantMessage(`answer ${turn}`)));
		for (let turn = 0; turn < turns; turn++) await harness.session.prompt(`request ${turn}`);
		const runtime = new AgentSessionRuntime(
			harness.session,
			{
				cwd: harness.tempDir,
				agentDir: harness.session.agentDir,
				authStorage: harness.authStorage,
				modelRegistry: harness.modelRegistry,
				modelRuntime: harness.session.modelRuntime,
				settingsManager: harness.settingsManager,
				resourceLoader: harness.session.resourceLoader,
				diagnostics: [],
			},
			async () => {
				throw new Error("This fixture does not replace sessions");
			},
		);
		const records: Answer[] = [];
		const handler = createRpcConnectionHandler(runtime, {
			writeRaw(chunk) {
				for (const line of chunk.split("\n").filter(Boolean)) records.push(JSON.parse(line));
			},
			waitForBackpressure: async () => {},
		});
		await handler.ready;
		let next = 0;
		const ask = async (command: Record<string, unknown>): Promise<Answer> => {
			const id = `q${next++}`;
			await handler.handleInputLine(JSON.stringify({ ...command, id }));
			const answer = records.find((record) => record.id === id);
			if (answer === undefined) throw new Error(`no answer to ${id}`);
			return answer;
		};
		return { harness, handler, ask };
	}

	it("walks the whole history with limit and since, ending with hasMore false", async () => {
		// given a session with several turns
		const { harness, handler, ask } = await connectedSession(4);
		try {
			const all = harness.sessionManager.getEntries().map((entry) => entry.id);

			// when the client pages three entries at a time
			const seen: string[] = [];
			let since: string | undefined;
			for (;;) {
				const answer = await ask({ type: "get_entries", limit: 3, ...(since === undefined ? {} : { since }) });
				expect(answer.success).toBe(true);
				const page = answer.data!;
				expect(page.entries.length).toBeLessThanOrEqual(3);
				seen.push(...page.entries.map((entry) => entry.id));
				if (!page.hasMore) break;
				since = page.nextSince;
			}

			// then every entry arrives once, in order
			expect(seen).toEqual(all);
		} finally {
			await handler.dispose();
		}
	});

	it("keeps the unpaged answer unchanged for a history within the budget", async () => {
		const { harness, handler, ask } = await connectedSession(2);
		try {
			const answer = await ask({ type: "get_entries" });

			expect(answer.success).toBe(true);
			expect(answer.data!.entries.map((entry) => entry.id)).toEqual(
				harness.sessionManager.getEntries().map((entry) => entry.id),
			);
			expect(answer.data).not.toHaveProperty("hasMore");
			expect(answer.data).not.toHaveProperty("nextSince");
		} finally {
			await handler.dispose();
		}
	});

	it("lets a walk the client abandons go after the hold expires on an idle session", async () => {
		// given an idle session and a page walk that stops after its first page
		const { harness, handler, ask } = await connectedSession(4);
		const release = vi.spyOn(harness.session, "releaseFullHistoryView");
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const first = await ask({ type: "get_entries", limit: 2 });
			expect(first.data?.hasMore).toBe(true);
			expect(release).not.toHaveBeenCalled();

			// when no next page arrives before the hold expires
			vi.advanceTimersByTime(ENTRY_WALK_HOLD_MS);

			// then the session lets the full-history view go
			expect(release).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
			await handler.dispose();
		}
	});

	it("refuses an unpaged read past the budget with response_too_large and keeps the connection", async () => {
		const { harness, handler, ask } = await connectedSession(4);
		const entryCount = harness.sessionManager.getEntries().length;
		const restore = setResponseByteBudgetForTesting(1024);
		try {
			const refused = await ask({ type: "get_entries" });
			expect(refused).toMatchObject({ success: false, errorCode: "response_too_large" });

			const paged = await ask({ type: "get_entries", limit: entryCount });
			expect(paged.success).toBe(true);
		} finally {
			restore();
			await handler.dispose();
		}
	});

	it("refuses a page whose first entry alone is larger than the budget instead of sending it", async () => {
		const { handler, ask } = await connectedSession(1);
		const restore = setResponseByteBudgetForTesting(16);
		try {
			const answer = await ask({ type: "get_entries", limit: 1 });

			expect(answer).toMatchObject({ success: false, errorCode: "response_too_large" });
		} finally {
			restore();
			await handler.dispose();
		}
	});

	it("refuses bounds that are not positive integers", async () => {
		const { handler, ask } = await connectedSession(1);
		try {
			for (const bounds of [{ limit: 0 }, { limit: 1.5 }, { maxBytes: -1 }]) {
				const answer = await ask({ type: "get_entries", ...bounds });
				expect(answer).toMatchObject({ success: false, errorCode: "invalid_argument" });
			}
		} finally {
			await handler.dispose();
		}
	});
});

describe("#3534 page bounds", () => {
	const entries = Array.from({ length: 5 }, (_, index) => ({ id: `e${index}`, text: "x".repeat(100) }));
	const entryBytes = Buffer.byteLength(JSON.stringify(entries[0])) + 1;

	it("stops before the byte budget and names the cursor for the rest", () => {
		const page = pageEntries(entries, (entry) => entry, { maxBytes: entryBytes * 2 });

		expect(page.entries.map((entry) => entry.id)).toEqual(["e0", "e1"]);
		expect(page).toMatchObject({ hasMore: true, nextSince: "e1" });
	});

	it("always takes the first entry so a page larger than the budget still moves forward", () => {
		const page = pageEntries(entries, (entry) => entry, { maxBytes: 1 });

		expect(page.entries.map((entry) => entry.id)).toEqual(["e0"]);
		expect(page.nextSince).toBe("e0");
	});

	it("marks the last page without a cursor", () => {
		const page = pageEntries(entries, (entry) => entry, { limit: 10, maxBytes: entryBytes * 10 });

		expect(page).toEqual({ entries, hasMore: false, firstEntryBytes: entryBytes });
	});

	it("gives an unpaged read the response budget and a paged read at most that", () => {
		expect(entryPageBounds({})).toEqual({ ok: true, paged: false, maxBytes: RPC_RESPONSE_BYTE_BUDGET });
		expect(entryPageBounds({ maxBytes: RPC_RESPONSE_BYTE_BUDGET * 4 })).toMatchObject({
			ok: true,
			paged: true,
			maxBytes: RPC_RESPONSE_BYTE_BUDGET,
		});
	});
});
