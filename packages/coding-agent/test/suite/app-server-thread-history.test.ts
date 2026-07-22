import { afterEach, describe, expect, it } from "vitest";
import type { RpcResponse } from "../../src/modes/app-server/rpc/registry.ts";
import type { TurnLog, WireItem } from "../../src/modes/app-server/threads/turn-log.ts";
import {
	cleanupRoots,
	createHarness,
	dataArray,
	objectAt,
	objectValue,
	responseResult,
	stringAt,
} from "./app-server-thread-handlers-harness.ts";

type DispatchResponse = RpcResponse;

afterEach(async () => {
	await cleanupRoots();
});

describe("app-server thread history", () => {
	it("paginates turns and items in both directions with an inclusive backwards anchor", async () => {
		const { connection, registry, root, threads, turnLog } = await createHarness();
		const entry = await threads.createThread({ cwd: root });
		for (let index = 1; index <= 5; index += 1) {
			recordTurn(turnLog, entry.id, index);
		}

		const firstTurns = await registry.dispatch(connection, {
			id: 1,
			method: "thread/turns/list",
			params: { threadId: entry.id, limit: 2 },
		});
		expect(turnIds(firstTurns)).toEqual(["turn-5", "turn-4"]);
		expect(turnItemsView(firstTurns)).toEqual(["summary", "summary"]);

		const forwardTurnPages = await collectPages(firstTurns, (cursor) =>
			registry.dispatch(connection, {
				id: 2,
				method: "thread/turns/list",
				params: { threadId: entry.id, cursor, limit: 2 },
			}),
		);
		expect(forwardTurnPages).toHaveLength(3);
		expect(forwardTurnPages.flatMap(turnIds)).toEqual(["turn-5", "turn-4", "turn-3", "turn-2", "turn-1"]);

		const secondTurnPage = forwardTurnPages[1];
		if (!secondTurnPage) throw new Error("missing second turn page");
		const backwardsCursor = requiredCursorAt(secondTurnPage, "backwardsCursor");
		const anchorReplay = await registry.dispatch(connection, {
			id: 3,
			method: "thread/turns/list",
			params: { threadId: entry.id, cursor: backwardsCursor, sortDirection: "asc", limit: 10 },
		});
		expect(turnIds(anchorReplay)).toEqual(["turn-3", "turn-4", "turn-5"]);

		const firstReverseTurns = await registry.dispatch(connection, {
			id: 4,
			method: "thread/turns/list",
			params: { threadId: entry.id, sortDirection: "asc", limit: 2 },
		});
		const reverseTurnPages = await collectPages(firstReverseTurns, (cursor) =>
			registry.dispatch(connection, {
				id: 5,
				method: "thread/turns/list",
				params: { threadId: entry.id, cursor, sortDirection: "asc", limit: 2 },
			}),
		);
		expect(reverseTurnPages).toHaveLength(3);
		expect(reverseTurnPages.flatMap(turnIds)).toEqual(["turn-1", "turn-2", "turn-3", "turn-4", "turn-5"]);

		const firstItems = await registry.dispatch(connection, {
			id: 6,
			method: "thread/items/list",
			params: { threadId: entry.id, limit: 2 },
		});
		const forwardItemPages = await collectPages(firstItems, (cursor) =>
			registry.dispatch(connection, {
				id: 7,
				method: "thread/items/list",
				params: { threadId: entry.id, cursor, limit: 2 },
			}),
		);
		expect(forwardItemPages).toHaveLength(3);
		expect(forwardItemPages.flatMap(itemIds)).toEqual(["item-1", "item-2", "item-3", "item-4", "item-5"]);

		const firstReverseItems = await registry.dispatch(connection, {
			id: 8,
			method: "thread/items/list",
			params: { threadId: entry.id, sortDirection: "desc", limit: 2 },
		});
		const reverseItemPages = await collectPages(firstReverseItems, (cursor) =>
			registry.dispatch(connection, {
				id: 9,
				method: "thread/items/list",
				params: { threadId: entry.id, cursor, sortDirection: "desc", limit: 2 },
			}),
		);
		expect(reverseItemPages).toHaveLength(3);
		expect(reverseItemPages.flatMap(itemIds)).toEqual(["item-5", "item-4", "item-3", "item-2", "item-1"]);
	});

	it("honors defaults, clamps, item views, and an optional turn filter", async () => {
		const { connection, registry, root, threads, turnLog } = await createHarness();
		const entry = await threads.createThread({ cwd: root });
		recordTurn(turnLog, entry.id, 1, [
			{ id: "user-1", type: "userMessage", content: [] },
			{ id: "agent-draft", type: "agentMessage", text: "draft" },
			{ id: "agent-final", type: "agentMessage", text: "final" },
		]);
		recordTurn(turnLog, entry.id, 2, [{ id: "user-2", type: "userMessage", content: [] }]);

		const defaultView = await registry.dispatch(connection, {
			id: 10,
			method: "thread/turns/list",
			params: { threadId: entry.id },
		});
		expect(turnItemsView(defaultView)).toEqual(["summary", "summary"]);
		expect(turnItemIds(defaultView)).toEqual(["user-2", "user-1", "agent-final"]);

		const notLoaded = await registry.dispatch(connection, {
			id: 11,
			method: "thread/turns/list",
			params: { threadId: entry.id, itemsView: "notLoaded" },
		});
		expect(turnItemsView(notLoaded)).toEqual(["notLoaded", "notLoaded"]);
		expect(turnItems(notLoaded).every((items) => items.length === 0)).toBe(true);

		const full = await registry.dispatch(connection, {
			id: 12,
			method: "thread/turns/list",
			params: { threadId: entry.id, itemsView: "full", sortDirection: "asc" },
		});
		expect(turnItems(full)).toEqual([
			[
				{ id: "user-1", type: "userMessage", clientId: null, content: [] },
				{ id: "agent-draft", type: "agentMessage", text: "draft", phase: null, memoryCitation: null },
				{ id: "agent-final", type: "agentMessage", text: "final", phase: null, memoryCitation: null },
			],
			[{ id: "user-2", type: "userMessage", clientId: null, content: [] }],
		]);

		const clampedLow = await registry.dispatch(connection, {
			id: 13,
			method: "thread/turns/list",
			params: { threadId: entry.id, limit: 0 },
		});
		const clampedHigh = await registry.dispatch(connection, {
			id: 14,
			method: "thread/turns/list",
			params: { threadId: entry.id, limit: 1000 },
		});
		expect(dataArray(responseResult(clampedLow))).toHaveLength(1);
		expect(dataArray(responseResult(clampedHigh))).toHaveLength(2);

		const filteredItems = await registry.dispatch(connection, {
			id: 15,
			method: "thread/items/list",
			params: { threadId: entry.id, turnId: "turn-1", sortDirection: "asc" },
		});
		expect(itemIds(filteredItems)).toEqual(["user-1", "agent-draft", "agent-final"]);
	});

	it("rejects fractional, negative, and overflowing history limits before pagination", async () => {
		const { connection, registry, root, threads } = await createHarness();
		const entry = await threads.createThread({ cwd: root });
		const invalidLimits = [-1, 1.5, 0x1_0000_0000] as const;
		let id = 20;

		for (const method of ["thread/turns/list", "thread/items/list"] as const) {
			for (const limit of invalidLimits) {
				const response = await registry.dispatch(connection, {
					id,
					method,
					params: { threadId: entry.id, limit },
				});
				expect(response).toMatchObject({ id, error: { code: -32600, message: expect.stringContaining("limit") } });
				id += 1;
			}
		}

		await expect(
			registry.dispatch(connection, {
				id,
				method: "thread/turns/list",
				params: { threadId: entry.id, limit: 0xffff_ffff },
			}),
		).resolves.toMatchObject({ id, result: { data: [] } });
	});
});

function recordTurn(
	turnLog: TurnLog,
	threadId: string,
	index: number,
	items: readonly WireItem[] = [{ id: `item-${index}`, type: "userMessage", content: [] }],
): void {
	const turnId = `turn-${index}`;
	turnLog.recordTurn(threadId, {
		turnId,
		startedAt: `2026-07-02T00:00:0${index}.000Z`,
		status: "completed",
	});
	for (const item of items) turnLog.appendItem(threadId, turnId, item);
}

async function collectPages(
	first: DispatchResponse,
	fetch: (cursor: string) => Promise<DispatchResponse>,
): Promise<DispatchResponse[]> {
	const pages = [first];
	let cursor = cursorAt(first, "nextCursor");
	while (cursor !== null) {
		const page = await fetch(cursor);
		pages.push(page);
		cursor = cursorAt(page, "nextCursor");
	}
	return pages;
}

function cursorAt(response: DispatchResponse, key: string): string | null {
	const value = responseResult(response)[key];
	if (value === null) return null;
	if (typeof value !== "string") throw new Error(`Expected ${key} cursor`);
	return value;
}

function requiredCursorAt(response: DispatchResponse, key: string): string {
	const cursor = cursorAt(response, key);
	if (cursor === null) throw new Error(`Expected ${key} cursor`);
	return cursor;
}

function turnIds(response: DispatchResponse): string[] {
	return dataArray(responseResult(response)).map((turn) => stringAt(turn, "id"));
}

function turnItemsView(response: DispatchResponse): string[] {
	return dataArray(responseResult(response)).map((turn) => stringAt(turn, "itemsView"));
}

function turnItems(response: DispatchResponse): unknown[][] {
	return dataArray(responseResult(response)).map((turn) => {
		const items = objectValue(turn).items;
		if (!Array.isArray(items)) throw new Error("Expected turn items");
		return items;
	});
}

function turnItemIds(response: DispatchResponse): string[] {
	return turnItems(response).flatMap((items) => items.map((item) => stringAt(item, "id")));
}

function itemIds(response: DispatchResponse): string[] {
	return dataArray(responseResult(response)).map((item) => stringAt(objectAt(item, "item"), "id"));
}
