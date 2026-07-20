import { afterEach, describe, expect, it } from "vitest";
import type { MethodRegistry, RegistryConnection, RpcResponse } from "../../src/modes/app-server/rpc/registry.ts";
import type { TurnLog, WireItem } from "../../src/modes/app-server/threads/turn-log.ts";
import {
	cleanupRoots,
	createHarness,
	dataArray,
	objectAt,
	responseResult,
	stringAt,
} from "./app-server-thread-handlers-harness.ts";

afterEach(async () => {
	await cleanupRoots();
});

describe("app-server thread/searchOccurrences", () => {
	it("returns visible occurrences chronologically with scoped cursors and UTF-16 ranges", async () => {
		// Given: an archived thread with user, commentary, final-assistant, and later user matches.
		const { connection, registry, root, threads, turnLog } = await createHarness();
		const entry = await threads.createThread({ cwd: root });
		recordTurn(turnLog, entry.id, "turn-1", [
			userMessage("user-1", "Needle first needle"),
			userMessage("steer-1", "steer toward needle"),
			{ id: "commentary-1", type: "agentMessage", text: "commentary needle" },
			{ id: "final-1", type: "agentMessage", text: "😀 **Final**  \nNeedle" },
		]);
		recordTurn(turnLog, entry.id, "turn-2", [userMessage("user-2", "later NEEDLE")]);
		await registry.dispatch(connection, {
			id: 1,
			method: "thread/archive",
			params: { threadId: entry.id },
		});

		// When: occurrence pagination, continuation, and turn-cursor replay run.
		const first = await registry.dispatch(connection, {
			id: 2,
			method: "thread/searchOccurrences",
			params: { threadId: entry.id, searchTerm: "needle", limit: 3 },
		});
		const firstResult = responseResult(first);
		const firstPage = dataArray(firstResult);
		const nextCursor = requiredString(firstResult.nextCursor, "nextCursor");
		const second = await registry.dispatch(connection, {
			id: 3,
			method: "thread/searchOccurrences",
			params: { threadId: entry.id, searchTerm: "needle", cursor: nextCursor, limit: 3 },
		});
		const allOccurrences = [...firstPage, ...dataArray(responseResult(second))];
		const finalOccurrence = allOccurrences.find((value) => stringAt(value, "itemId") === "final-1");
		if (!finalOccurrence) throw new Error("missing final assistant occurrence");
		const turnReplay = await registry.dispatch(connection, {
			id: 4,
			method: "thread/turns/list",
			params: { threadId: entry.id, cursor: stringAt(finalOccurrence, "turnCursor"), itemsView: "full" },
		});

		// Then: commentary is excluded, ordering is chronological, and cursors preserve the matching turn.
		expect(allOccurrences.map((value) => stringAt(value, "itemId"))).toEqual([
			"user-1",
			"user-1",
			"steer-1",
			"final-1",
			"user-2",
		]);
		expect(stringAt(finalOccurrence, "snippet")).toBe("😀 Final Needle");
		expect(objectAt(finalOccurrence, "snippetMatchRange")).toEqual({ start: 9, end: 15 });
		expect(turnIds(turnReplay)).toContain(stringAt(finalOccurrence, "turnId"));
		expect(responseResult(second).nextCursor).toBeNull();
	});

	it("matches identical Greek uppercase sigma with a UTF-16 range", async () => {
		// Given: a visible user message and search term containing Greek uppercase omicron-sigma.
		const { connection, registry, root, threads, turnLog } = await createHarness();
		const entry = await threads.createThread({ cwd: root });
		recordTurn(turnLog, entry.id, "turn-greek", [userMessage("greek", "ΟΣ")]);

		// When: the identical Greek uppercase term is searched.
		const response = await search(registry, connection, entry.id, { searchTerm: "ΟΣ" });
		const occurrences = dataArray(responseResult(response));
		const occurrence = occurrences[0];
		if (occurrence === undefined) throw new Error("missing Greek uppercase occurrence");

		// Then: the identical text matches once and its range covers both UTF-16 code units.
		expect(occurrences).toHaveLength(1);
		expect(objectAt(occurrence, "snippetMatchRange")).toEqual({ start: 0, end: 2 });
	});

	it("matches metacharacters literally", async () => {
		// Given: visible messages containing one literal metacharacter sequence and one non-literal match candidate.
		const { connection, registry, root, threads, turnLog } = await createHarness();
		const entry = await threads.createThread({ cwd: root });
		recordTurn(turnLog, entry.id, "turn-literal", [
			userMessage("literal", "prefix .* suffix"),
			userMessage("regular", "prefix anything suffix"),
		]);

		// When: occurrences are searched with a term that would be a wildcard in a regular expression.
		const response = await search(registry, connection, entry.id, { searchTerm: ".*" });
		const occurrences = dataArray(responseResult(response));
		if (occurrences.length !== 1) throw new Error("expected one literal metacharacter occurrence");
		const occurrence = occurrences[0];
		if (occurrence === undefined) throw new Error("missing literal metacharacter occurrence");

		// Then: only the message containing the exact literal term is returned with its literal range.
		expect(stringAt(occurrence, "itemId")).toBe("literal");
		expect(stringAt(occurrence, "snippet")).toBe("prefix .* suffix");
		expect(objectAt(occurrence, "snippetMatchRange")).toEqual({ start: 7, end: 9 });
	});

	it("rejects a cursor used with a different thread", async () => {
		// Given: two threads with the same search term and a continuation cursor from the first thread.
		const { connection, registry, root, threads, turnLog } = await createHarness();
		const firstThread = await threads.createThread({ cwd: root });
		const secondThread = await threads.createThread({ cwd: root });
		recordTurn(turnLog, firstThread.id, "turn-first", [userMessage("first", "needle needle")]);
		recordTurn(turnLog, secondThread.id, "turn-second", [userMessage("second", "needle")]);
		const firstPage = await search(registry, connection, firstThread.id, { searchTerm: "needle", limit: 1 });
		const cursor = requiredString(responseResult(firstPage).nextCursor, "nextCursor");

		// When: the cursor from thread A is replayed against thread B.
		const crossThread = await search(registry, connection, secondThread.id, {
			searchTerm: "needle",
			cursor,
		});

		// Then: the request is rejected as an invalid cursor scope.
		expect(crossThread).toMatchObject({ error: { code: -32600 } });
	});

	it("applies Codex limits and rejects invalid requests or cursor scope", async () => {
		// Given: one thread containing more occurrences than either supported page size.
		const { connection, registry, root, threads, turnLog } = await createHarness();
		const entry = await threads.createThread({ cwd: root });
		recordTurn(turnLog, entry.id, "turn-volume", [userMessage("user-volume", "needle ".repeat(260))]);

		// When: default/clamped limits and invalid requests are dispatched.
		const defaultPage = await search(registry, connection, entry.id, { searchTerm: "needle" });
		const lowPage = await search(registry, connection, entry.id, { searchTerm: "needle", limit: 0 });
		const highPage = await search(registry, connection, entry.id, { searchTerm: "needle", limit: 1000 });
		const cursor = requiredString(responseResult(defaultPage).nextCursor, "nextCursor");
		const wrongTerm = await search(registry, connection, entry.id, {
			searchTerm: "NEEDLE",
			cursor,
		});
		const empty = await search(registry, connection, entry.id, { searchTerm: "   " });
		const unknown = await search(registry, connection, "missing-thread", { searchTerm: "needle" });
		const invalidLimits = await Promise.all(
			[-1, 1.5, 0x1_0000_0000].map((limit) =>
				search(registry, connection, entry.id, { searchTerm: "needle", limit }),
			),
		);
		const gated = await registry.dispatch(
			{ initialized: true, capabilities: { experimentalApi: false } },
			{
				id: 99,
				method: "thread/searchOccurrences",
				params: { threadId: entry.id, searchTerm: "needle" },
			},
		);

		// Then: valid integer limits clamp to 1..250 and every invalid boundary is explicit.
		expect(dataArray(responseResult(defaultPage))).toHaveLength(50);
		expect(dataArray(responseResult(lowPage))).toHaveLength(1);
		expect(dataArray(responseResult(highPage))).toHaveLength(250);
		expect(wrongTerm).toMatchObject({ error: { code: -32600 } });
		expect(empty).toMatchObject({ error: { code: -32600 } });
		expect(unknown).toMatchObject({ error: { code: -32600 } });
		expect(invalidLimits.every((response) => "error" in response && response.error.code === -32600)).toBe(true);
		expect(gated).toMatchObject({ error: { code: -32600, message: expect.stringContaining("experimentalApi") } });
	});
});

function userMessage(id: string, text: string): WireItem {
	return { id, type: "userMessage", content: [{ type: "text", text, text_elements: [] }] };
}

function recordTurn(turnLog: TurnLog, threadId: string, turnId: string, items: readonly WireItem[]): void {
	turnLog.recordTurn(threadId, { turnId, startedAt: "2026-07-02T00:00:01.000Z", status: "completed" });
	for (const item of items) turnLog.appendItem(threadId, turnId, item);
}

function turnIds(response: RpcResponse): string[] {
	return dataArray(responseResult(response)).map((turn) => stringAt(turn, "id"));
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`expected ${label}`);
	return value;
}

function search(
	registry: MethodRegistry,
	connection: RegistryConnection,
	threadId: string,
	params: Readonly<Record<string, unknown>>,
): Promise<RpcResponse> {
	return registry.dispatch(connection, {
		id: "search-occurrences",
		method: "thread/searchOccurrences",
		params: { threadId, ...params },
	});
}
