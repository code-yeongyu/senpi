import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MethodRegistry } from "../../../src/modes/app-server/rpc/registry.ts";
import type { WireItem } from "../../../src/modes/app-server/threads/turn-log.ts";
import {
	createHarnessForRoot,
	dataArray,
	objectValue,
	responseResult,
	stringAt,
	writePersistedSession,
} from "../../suite/app-server-thread-handlers-harness.ts";

type DispatchResponse = Awaited<ReturnType<MethodRegistry["dispatch"]>>;

async function main(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "senpi-task10-history-"));
	try {
		const { connection, registry, threads, turnLog } = createHarnessForRoot(root);
		const entry = await threads.createThread({ cwd: root });
		for (let index = 1; index <= 5; index += 1) {
			recordTurn(turnLog, entry.id, index);
		}

		const firstForward = await registry.dispatch(connection, {
			id: 1,
			method: "thread/turns/list",
			params: { threadId: entry.id, limit: 2 },
		});
		const forwardPages = await collectPages(firstForward, (cursor) =>
			registry.dispatch(connection, {
				id: 2,
				method: "thread/turns/list",
				params: { threadId: entry.id, cursor, limit: 2 },
			}),
		);
		assertEqual(turnIds(forwardPages), ["turn-5", "turn-4", "turn-3", "turn-2", "turn-1"], "forward turn order");

		const secondForward = forwardPages[1];
		if (!secondForward) throw new Error("missing second forward page");
		const backwardsCursor = requiredCursor(secondForward, "backwardsCursor");
		const anchorReplay = await registry.dispatch(connection, {
			id: 3,
			method: "thread/turns/list",
			params: { threadId: entry.id, cursor: backwardsCursor, sortDirection: "asc", limit: 10 },
		});
		const anchorReplayed = turnIds([anchorReplay])[0] === "turn-3" ? 1 : 0;

		const firstReverse = await registry.dispatch(connection, {
			id: 4,
			method: "thread/turns/list",
			params: { threadId: entry.id, sortDirection: "asc", limit: 2 },
		});
		const reversePages = await collectPages(firstReverse, (cursor) =>
			registry.dispatch(connection, {
				id: 5,
				method: "thread/turns/list",
				params: { threadId: entry.id, cursor, sortDirection: "asc", limit: 2 },
			}),
		);
		assertEqual(turnIds(reversePages), ["turn-1", "turn-2", "turn-3", "turn-4", "turn-5"], "reverse turn order");

		const firstItems = await registry.dispatch(connection, {
			id: 6,
			method: "thread/items/list",
			params: { threadId: entry.id, limit: 2 },
		});
		const itemPages = await collectPages(firstItems, (cursor) =>
			registry.dispatch(connection, {
				id: 7,
				method: "thread/items/list",
				params: { threadId: entry.id, cursor, limit: 2 },
			}),
		);
		assertEqual(itemIds(itemPages), ["item-1", "item-2", "item-3", "item-4", "item-5"], "forward item order");

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
		assertEqual(itemIds(reverseItemPages), ["item-5", "item-4", "item-3", "item-2", "item-1"], "reverse item order");
		const newestTurn = objectValue(dataArray(responseResult(firstForward))[0]);
		const lifecyclePreserved =
			typeof newestTurn.completedAt === "number" && newestTurn.durationMs === 500 && newestTurn.error === null
				? 1
				: 0;
		const compactionVariantPreserved = itemTypes([firstReverseItems])[0] === "contextCompaction" ? 1 : 0;

		const invalidCursor = await registry.dispatch(connection, {
			id: 10,
			method: "thread/turns/list",
			params: { threadId: entry.id, cursor: "not-json", limit: 2 },
		});
		const invalidCursorError = "error" in invalidCursor && invalidCursor.error.code === -32600 ? 1 : 0;
		const invalidLimits = await Promise.all(
			(["thread/turns/list", "thread/items/list"] as const).flatMap((method, methodIndex) =>
				[-1, 1.5, 0x1_0000_0000].map((limit, limitIndex) =>
					registry.dispatch(connection, {
						id: 20 + methodIndex * 3 + limitIndex,
						method,
						params: { threadId: entry.id, limit },
					}),
				),
			),
		);
		const invalidLimitsRejected = invalidLimits.every(
			(response) => "error" in response && response.error.code === -32600,
		)
			? 1
			: 0;

		const coldThreadId = "56565656-5656-4565-8565-565656565656";
		await writePersistedSession(root, coldThreadId);
		await threads.resumeThread(coldThreadId);
		recordTurn(turnLog, coldThreadId, 6);
		threads.unloadThread(coldThreadId);
		const loadedBefore = threads.listLoaded().map((thread) => thread.id);
		const coldHistory = await registry.dispatch(connection, {
			id: 30,
			method: "thread/turns/list",
			params: { threadId: coldThreadId },
		});
		const loadedAfter = threads.listLoaded().map((thread) => thread.id);
		const coldReadNonMutating =
			turnIds([coldHistory])[0] === "turn-6" &&
			loadedBefore.join("\u0000") === loadedAfter.join("\u0000") &&
			!loadedAfter.includes(coldThreadId)
				? 1
				: 0;

		console.log(`PAGES_FWD=${forwardPages.length}`);
		console.log(`PAGES_REV=${reversePages.length}`);
		console.log(`ANCHOR_REPLAYED=${anchorReplayed}`);
		console.log(`INVALID_CURSOR_ERROR=${invalidCursorError}`);
		console.log(`INVALID_LIMITS_REJECTED=${invalidLimitsRejected}`);
		console.log(`LIFECYCLE_PRESERVED=${lifecyclePreserved}`);
		console.log(`COMPACTION_VARIANT_PRESERVED=${compactionVariantPreserved}`);
		console.log(`COLD_READ_NON_MUTATING=${coldReadNonMutating}`);
		if (
			forwardPages.length !== 3 ||
			reversePages.length !== 3 ||
			anchorReplayed !== 1 ||
			invalidCursorError !== 1 ||
			invalidLimitsRejected !== 1 ||
			lifecyclePreserved !== 1 ||
			compactionVariantPreserved !== 1 ||
			coldReadNonMutating !== 1
		) {
			throw new Error("task10 history pagination assertions failed");
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function recordTurn(
	turnLog: ReturnType<typeof createHarnessForRoot>["turnLog"],
	threadId: string,
	index: number,
): void {
	const turnId = `turn-${index}`;
	turnLog.recordTurn(threadId, {
		turnId,
		startedAt: `2026-07-02T00:00:0${index}.000Z`,
	});
	const item: WireItem =
		index === 5
			? { id: `item-${index}`, type: "contextCompaction" }
			: { id: `item-${index}`, type: "userMessage", content: [] };
	turnLog.appendItem(threadId, turnId, item);
	turnLog.completeTurn(threadId, turnId, {
		status: "completed",
		completedAt: `2026-07-02T00:00:0${index}.500Z`,
	});
}

async function collectPages(
	first: DispatchResponse,
	fetch: (cursor: string) => Promise<DispatchResponse>,
): Promise<DispatchResponse[]> {
	const pages = [first];
	let cursor = cursorValue(first, "nextCursor");
	while (cursor !== null) {
		const page = await fetch(cursor);
		pages.push(page);
		cursor = cursorValue(page, "nextCursor");
	}
	return pages;
}

function cursorValue(response: DispatchResponse, key: string): string | null {
	const value = responseResult(response)[key];
	if (value === null) return null;
	if (typeof value !== "string") throw new Error(`expected ${key} cursor`);
	return value;
}

function requiredCursor(response: DispatchResponse, key: string): string {
	const cursor = cursorValue(response, key);
	if (cursor === null) throw new Error(`expected ${key} cursor`);
	return cursor;
}

function turnIds(pages: readonly DispatchResponse[]): string[] {
	return pages.flatMap((page) => dataArray(responseResult(page)).map((turn) => stringAt(turn, "id")));
}

function itemIds(pages: readonly DispatchResponse[]): string[] {
	return pages.flatMap((page) =>
		dataArray(responseResult(page)).map((item) => stringAt(objectValue(item).item, "id")),
	);
}

function itemTypes(pages: readonly DispatchResponse[]): string[] {
	return pages.flatMap((page) =>
		dataArray(responseResult(page)).map((item) => stringAt(objectValue(item).item, "type")),
	);
}

function assertEqual<T>(actual: readonly T[], expected: readonly T[], label: string): void {
	if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
		throw new Error(`${label}: expected ${expected.join(",")}, got ${actual.join(",")}`);
	}
}

await main();
