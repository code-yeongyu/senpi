import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	BTW_SIDE_ENTRY_TYPE,
	type BtwSessionListItem,
	type BtwSideMetadata,
	loadBtwSessionCatalog,
	readBtwSideMetadata,
} from "../../src/core/extensions/builtin/btw/session-catalog.ts";
import { type SessionEntry, SessionManager } from "../../src/core/session-manager.ts";

function metadata(input: Partial<BtwSideMetadata> = {}): BtwSideMetadata {
	return {
		version: 1,
		parentSessionPath: "/sessions/main.jsonl",
		parentSessionId: "main",
		ordinal: 1,
		summary: "first question",
		createdAt: "2026-08-23T00:00:00.000Z",
		...input,
	};
}

function customEntry(data: BtwSideMetadata): SessionEntry {
	return {
		type: "custom",
		id: `entry-${data.ordinal}`,
		parentId: null,
		timestamp: data.createdAt,
		customType: BTW_SIDE_ENTRY_TYPE,
		data,
	} as SessionEntry;
}

function session(
	path: string,
	name?: string,
	cwd = "/repo",
	id = path.endsWith("/main.jsonl") ? "main" : path,
): BtwSessionListItem {
	return {
		id,
		path,
		cwd,
		name,
		modified: new Date("2026-08-23T00:00:00.000Z"),
	};
}

describe("BTW retained session metadata", () => {
	it("reads only the newest valid versioned metadata entry", () => {
		// Given
		const expected = metadata({ ordinal: 2, summary: "newest" });
		const entries = [
			customEntry(metadata({ ordinal: 1, summary: "older" })),
			{
				...customEntry(expected),
				data: { ...expected, version: 99 },
			},
			customEntry(expected),
		] as SessionEntry[];

		// When
		const actual = readBtwSideMetadata(entries);

		// Then
		expect(actual).toEqual(expected);
	});
});

describe("loadBtwSessionCatalog", () => {
	it("seeds an external Main for both Main and side catalogs", async () => {
		// Given
		const main = session("/outside/main.jsonl", "External Main", "/original/repo", "external-main");
		const side = session("/configured/side.jsonl", "BTW #1: external", "/original/repo", "side");
		const sideMetadata = metadata({
			parentSessionPath: main.path,
			parentSessionId: main.id,
		});
		const readSessionInfo = async (path: string) =>
			path === main.path ? main : path === side.path ? side : undefined;

		// When
		const fromMain = await loadBtwSessionCatalog({
			cwd: "/recovered/repo",
			currentSessionPath: main.path,
			listSessions: async () => [],
			readMetadata: async () => undefined,
			readSessionInfo,
		});
		const fromSide = await loadBtwSessionCatalog({
			cwd: "/recovered/repo",
			currentSessionPath: side.path,
			listSessions: async () => [side],
			readMetadata: async (path) => (path === side.path ? sideMetadata : undefined),
			readSessionInfo,
		});

		// Then
		expect(fromMain.main?.id).toBe(main.id);
		expect(fromSide.main?.id).toBe(main.id);
		expect(fromSide.sides.map((item) => item.id)).toEqual([side.id]);
	});

	it("groups only same-cwd retained sides under their authoritative parent", async () => {
		// Given
		const entries = new Map<string, SessionEntry[]>([
			["/sessions/main.jsonl", []],
			["/sessions/side-1.jsonl", [customEntry(metadata())]],
			[
				"/sessions/side-2.jsonl",
				[
					customEntry(
						metadata({
							ordinal: 2,
							summary: "second question",
							createdAt: "2026-08-23T00:00:01.000Z",
						}),
					),
				],
			],
			["/sessions/unrelated.jsonl", [customEntry(metadata({ parentSessionPath: "/sessions/other-main.jsonl" }))]],
		]);
		const listSessions = vi.fn(async () => [
			session("/sessions/main.jsonl", "Main"),
			session("/sessions/side-1.jsonl", "BTW #1: first question"),
			session("/sessions/side-2.jsonl", "BTW #2: second question"),
			session("/sessions/unrelated.jsonl", "BTW #1: unrelated"),
			session("/sessions/cross-cwd.jsonl", "BTW #3: wrong cwd", "/other"),
		]);

		// When
		const catalog = await loadBtwSessionCatalog({
			cwd: "/repo",
			currentSessionPath: "/sessions/main.jsonl",
			listSessions,
			readMetadata: async (path) => readBtwSideMetadata(entries.get(path) ?? []),
		});

		// Then
		expect(catalog.main?.path).toBe("/sessions/main.jsonl");
		expect(catalog.sides.map((side) => side.path)).toEqual(["/sessions/side-1.jsonl", "/sessions/side-2.jsonl"]);
		expect(catalog.sides.map((side) => side.metadata.ordinal)).toEqual([1, 2]);
	});

	it("excludes stale sides when a Main path is reused by a new session ID", async () => {
		// Given
		const staleMetadata = metadata({ parentSessionId: "old-main" });

		// When
		const catalog = await loadBtwSessionCatalog({
			cwd: "/repo",
			currentSessionPath: "/sessions/main.jsonl",
			listSessions: async () => [
				session("/sessions/main.jsonl", "Main", "/repo", "new-main"),
				session("/sessions/side-1.jsonl", "BTW #1: stale"),
			],
			readMetadata: async (path) => (path.endsWith("side-1.jsonl") ? staleMetadata : undefined),
		});

		// Then
		expect(catalog.main?.id).toBe("new-main");
		expect(catalog.sides).toEqual([]);
	});

	it("resolves the root parent when opened from a retained side", async () => {
		// Given
		const sideMetadata = metadata({ ordinal: 2 });
		const entries = new Map<string, SessionEntry[]>([
			["/sessions/main.jsonl", []],
			["/sessions/side-2.jsonl", [customEntry(sideMetadata)]],
		]);

		// When
		const catalog = await loadBtwSessionCatalog({
			cwd: "/repo",
			currentSessionPath: "/sessions/side-2.jsonl",
			listSessions: async () => [
				session("/sessions/main.jsonl", "Main"),
				session("/sessions/side-2.jsonl", "BTW #2: second question"),
			],
			readMetadata: async (path) => readBtwSideMetadata(entries.get(path) ?? []),
		});

		// Then
		expect(catalog.parentSessionPath).toBe("/sessions/main.jsonl");
		expect(catalog.currentSide?.metadata.ordinal).toBe(2);
	});

	it("skips a stale row that disappears while metadata is loading", async () => {
		// Given
		const readMetadata = vi.fn(async (path: string) => {
			if (path.endsWith("stale.jsonl")) throw new Error("ENOENT");
			return path.endsWith("side.jsonl") ? metadata() : undefined;
		});

		// When
		const catalog = await loadBtwSessionCatalog({
			cwd: "/repo",
			currentSessionPath: "/sessions/main.jsonl",
			listSessions: async () => [
				session("/sessions/main.jsonl", "Main"),
				session("/sessions/side.jsonl", "BTW #1: first question"),
				session("/sessions/stale.jsonl", "BTW #2: stale"),
			],
			readMetadata,
		});

		// Then
		expect(catalog.sides.map((side) => side.path)).toEqual(["/sessions/side.jsonl"]);
		expect(catalog.skippedPaths).toEqual(["/sessions/stale.jsonl"]);
	});
});

describe("SessionManager.listMetadata", () => {
	it("skips malformed session files while retaining valid headers", async () => {
		// Given
		const directory = await mkdtemp(join(tmpdir(), "senpi-session-metadata-"));
		const validPath = join(directory, "valid.jsonl");
		const malformedPath = join(directory, "malformed.jsonl");
		await writeFile(
			validPath,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "valid-session",
				timestamp: "2026-08-23T00:00:00.000Z",
				cwd: "/repo",
			})}\n`,
		);
		await writeFile(malformedPath, "{not-json}\n");

		try {
			// When
			const sessions = await SessionManager.listMetadata("/repo", directory);

			// Then
			expect(sessions.map((item) => item.id)).toEqual(["valid-session"]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
