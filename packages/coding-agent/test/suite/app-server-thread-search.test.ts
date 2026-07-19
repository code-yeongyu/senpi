import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { ThreadSearchCache } from "../../src/modes/app-server/threads/search-cache.ts";
import {
	cleanupRoots,
	createHarness,
	dataArray,
	objectAt,
	responseResult,
	stringAt,
} from "./app-server-thread-handlers-harness.ts";

describe("app-server thread/search", () => {
	afterEach(async () => {
		await cleanupRoots();
	});

	it("returns filtered literal matches with Codex search defaults and scoped cursors", async () => {
		// Given: active and archived persisted sessions with a case-varied literal match.
		const { connection, registry, root } = await createHarness();
		const activeIds = await Promise.all(
			Array.from({ length: 104 }, (_, index) => {
				const threadId = `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
				return writeSearchSession(root, threadId, `Active NEEDLE ${index}`);
			}),
		);
		const archivedId = "20000000-0000-4000-8000-000000000001";
		await writeSearchSession(root, archivedId, "Archived needle");
		await registry.dispatch(connection, {
			id: 1,
			method: "thread/archive",
			params: { threadId: archivedId },
		});

		// When: the default search, clamped searches, and a cursor continuation run.
		const first = await registry.dispatch(connection, {
			id: 2,
			method: "thread/search",
			params: { searchTerm: "  needle  " },
		});
		const firstResult = responseResult(first);
		const firstPage = dataArray(firstResult);
		const firstMatch = stringAt(firstPage[0], "snippet");
		const nextCursor = firstResult.nextCursor;
		const second = await registry.dispatch(connection, {
			id: 3,
			method: "thread/search",
			params: { searchTerm: "needle", cursor: nextCursor, limit: 2 },
		});
		const backwards = await registry.dispatch(connection, {
			id: 12,
			method: "thread/search",
			params: { searchTerm: "needle", cursor: firstResult.backwardsCursor, sortDirection: "asc", limit: 2 },
		});
		const backwardsWrongDirection = await registry.dispatch(connection, {
			id: 13,
			method: "thread/search",
			params: { searchTerm: "needle", cursor: firstResult.backwardsCursor, limit: 2 },
		});
		const lowLimit = await registry.dispatch(connection, {
			id: 4,
			method: "thread/search",
			params: { searchTerm: "needle", limit: 0 },
		});
		const highLimit = await registry.dispatch(connection, {
			id: 5,
			method: "thread/search",
			params: { searchTerm: "needle", limit: 1000 },
		});
		const archived = await registry.dispatch(connection, {
			id: 10,
			method: "thread/search",
			params: { searchTerm: "needle", archived: true },
		});
		const wrongSource = await registry.dispatch(connection, {
			id: 11,
			method: "thread/search",
			params: { searchTerm: "needle", sourceKinds: ["cli"] },
		});

		// Then: defaults/clamps, literal snippets, filtering, and cursor scoping are observable on the wire.
		expect(firstPage).toHaveLength(25);
		expect(firstMatch).toContain("NEEDLE");
		expect(firstResult).toHaveProperty("backwardsCursor");
		expect(typeof nextCursor).toBe("string");
		expect(dataArray(responseResult(second))).toHaveLength(2);
		expect(dataArray(responseResult(backwards))).toHaveLength(1);
		expect(stringAt(objectAt(dataArray(responseResult(backwards))[0], "thread"), "id")).toBe(activeIds[103]);
		expect(backwardsWrongDirection).toMatchObject({ id: 13, error: { code: -32600 } });
		expect(dataArray(responseResult(lowLimit))).toHaveLength(1);
		expect(dataArray(responseResult(highLimit))).toHaveLength(100);
		expect(dataArray(responseResult(archived))).toHaveLength(1);
		expect(stringAt(objectAt(dataArray(responseResult(archived))[0], "thread"), "id")).toBe(archivedId);
		expect(dataArray(responseResult(wrongSource))).toHaveLength(0);
		expect(dataArray(firstResult).every((item) => stringAt(objectAt(item, "thread"), "id") !== archivedId)).toBe(
			true,
		);
		expect(activeIds).toContain(stringAt(objectAt(firstPage[0], "thread"), "id"));
	});

	it("rejects empty terms and enforces the experimental capability gate", async () => {
		// Given: an initialized connection without experimentalApi and one with it.
		const { connection, registry } = await createHarness();
		const gateOff = { initialized: true, capabilities: { experimentalApi: false } };

		// When: search is requested with an empty term or without the capability.
		const empty = await registry.dispatch(connection, {
			id: 6,
			method: "thread/search",
			params: { searchTerm: "   " },
		});
		const gated = await registry.dispatch(gateOff, {
			id: 7,
			method: "thread/search",
			params: { searchTerm: "needle" },
		});

		// Then: both failures use invalid-request semantics, with an explicit gate diagnostic.
		expect(empty).toMatchObject({ id: 6, error: { code: -32600 } });
		expect(gated).toMatchObject({
			id: 7,
			error: { code: -32600, message: expect.stringContaining("experimentalApi") },
		});
	});

	it("keeps a bounded searchable-text cache across a 200-session volume", async () => {
		// Given: a large fixture set and a spy that detects the full SessionInfo scan path.
		const { connection, registry, root } = await createHarness();
		const listAllSpy = vi.spyOn(SessionManager, "listAll");
		for (let index = 0; index < 200; index += 1) {
			const threadId = `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
			await writeSearchSession(root, threadId, `volume needle ${index}`);
		}

		// When: two identical searches run against the same server lifetime cache.
		const first = await registry.dispatch(connection, {
			id: 8,
			method: "thread/search",
			params: { searchTerm: "needle", limit: 100 },
		});
		const second = await registry.dispatch(connection, {
			id: 9,
			method: "thread/search",
			params: { searchTerm: "needle", limit: 100 },
		});

		// Then: both pages are stable and search never delegates to the full allMessagesText scan.
		expect(dataArray(responseResult(first))).toHaveLength(100);
		expect(dataArray(responseResult(second))).toHaveLength(100);
		expect(listAllSpy).not.toHaveBeenCalled();

		const cache = new ThreadSearchCache(200);
		await cache.load(join(root, "sessions"));
		const firstStats = cache.stats();
		await cache.load(join(root, "sessions"));
		const secondStats = cache.stats();
		expect(firstStats).toEqual({ hits: 0, misses: 200, entries: 200 });
		expect(secondStats).toEqual({ hits: 200, misses: 200, entries: 200 });
	});
});

async function writeSearchSession(root: string, threadId: string, text: string): Promise<string> {
	const sessionDir = join(root, "sessions");
	await mkdir(sessionDir, { recursive: true });
	const sessionFile = join(sessionDir, `2026-07-02T00-00-00-000Z_${threadId}.jsonl`);
	await writeFile(
		sessionFile,
		[
			JSON.stringify({
				type: "session",
				version: 3,
				id: threadId,
				timestamp: "2026-07-02T00:00:00.000Z",
				cwd: root,
			}),
			JSON.stringify({
				type: "message",
				id: `message-${threadId}`,
				parentId: threadId,
				timestamp: "2026-07-02T00:00:01.000Z",
				message: { role: "user", content: [{ type: "text", text }] },
			}),
			"",
		].join("\n"),
	);
	return threadId;
}
