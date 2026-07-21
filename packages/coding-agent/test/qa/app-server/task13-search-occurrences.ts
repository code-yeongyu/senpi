import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RpcResponse } from "../../../src/modes/app-server/rpc/registry.ts";
import type { TurnLog, WireItem } from "../../../src/modes/app-server/threads/turn-log.ts";
import {
	createHarnessForRoot,
	dataArray,
	objectAt,
	responseResult,
	stringAt,
} from "../../suite/app-server-thread-handlers-harness.ts";

type DispatchResponse = RpcResponse;

async function main(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "senpi-task13-search-occurrences-"));
	try {
		const { connection, registry, threads, turnLog } = createHarnessForRoot(root);
		const entry = await threads.createThread({ cwd: root });
		recordTurn(turnLog, entry.id, "turn-1", [
			userMessage("user-1", "Needle first needle"),
			userMessage("steer-1", "steer toward needle"),
			{ id: "commentary-1", type: "agentMessage", text: "commentary needle" },
			{ id: "final-1", type: "agentMessage", text: "😀 **Final**  \nNeedle" },
		]);
		recordTurn(turnLog, entry.id, "turn-2", [userMessage("user-2", "later NEEDLE")]);
		const archived = await registry.dispatch(connection, {
			id: 1,
			method: "thread/archive",
			params: { threadId: entry.id },
		});
		assertSuccess(archived, "thread/archive");

		const first = await registry.dispatch(connection, {
			id: 2,
			method: "thread/searchOccurrences",
			params: { threadId: entry.id, searchTerm: "needle", limit: 3 },
		});
		const firstResult = responseResult(first);
		const pages = [first];
		let nextCursor = cursorValue(firstResult, "nextCursor");
		while (nextCursor !== null) {
			const page = await registry.dispatch(connection, {
				id: pages.length + 2,
				method: "thread/searchOccurrences",
				params: { threadId: entry.id, searchTerm: "needle", cursor: nextCursor, limit: 3 },
			});
			pages.push(page);
			nextCursor = cursorValue(responseResult(page), "nextCursor");
		}

		const occurrences = pages.flatMap((page) => dataArray(responseResult(page)));
		const finalOccurrence = occurrences.find((value) => stringAt(value, "itemId") === "final-1");
		if (finalOccurrence === undefined) throw new Error("final assistant occurrence was not returned");
		const turnReplay = await registry.dispatch(connection, {
			id: 10,
			method: "thread/turns/list",
			params: { threadId: entry.id, cursor: stringAt(finalOccurrence, "turnCursor"), itemsView: "full" },
		});
		const emptyTerm = await registry.dispatch(connection, {
			id: 11,
			method: "thread/searchOccurrences",
			params: { threadId: entry.id, searchTerm: "   " },
		});

		const range = objectAt(finalOccurrence, "snippetMatchRange");
		const utf16Range = range.start === 9 && range.end === 15 ? 1 : 0;
		const turnCursorInterop = turnIds(turnReplay).includes(stringAt(finalOccurrence, "turnId")) ? 1 : 0;
		const emptyTermError = "error" in emptyTerm && emptyTerm.error.code === -32600 ? 1 : 0;
		console.log(`OCCURRENCES=${occurrences.length}`);
		console.log(`UTF16_RANGE_OK=${utf16Range}`);
		console.log(`TURNCURSOR_INTEROP=${turnCursorInterop}`);
		console.log(`EMPTY_TERM_ERROR=${emptyTermError}`);
		if (occurrences.length < 2 || utf16Range !== 1 || turnCursorInterop !== 1 || emptyTermError !== 1) {
			throw new Error("task13 searchOccurrences assertions failed");
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function recordTurn(turnLog: TurnLog, threadId: string, turnId: string, items: readonly WireItem[]): void {
	turnLog.recordTurn(threadId, { turnId, startedAt: "2026-07-02T00:00:01.000Z", status: "completed" });
	for (const item of items) turnLog.appendItem(threadId, turnId, item);
}

function userMessage(id: string, text: string): WireItem {
	return { id, type: "userMessage", content: [{ type: "text", text, text_elements: [] }] };
}

function cursorValue(value: Record<string, unknown>, key: string): string | null {
	const cursor = value[key];
	if (cursor === null) return null;
	if (typeof cursor !== "string") throw new Error(`expected ${key} cursor`);
	return cursor;
}

function turnIds(response: DispatchResponse): string[] {
	return dataArray(responseResult(response)).map((turn) => stringAt(turn, "id"));
}

function assertSuccess(response: DispatchResponse, method: string): void {
	if ("error" in response) throw new Error(`${method} failed: ${response.error.message}`);
}

main()
	.then(() => process.exit(0))
	.catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
