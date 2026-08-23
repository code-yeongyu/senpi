import { describe, expect, it, vi } from "vitest";
import {
	BTW_SIDE_ENTRY_TYPE,
	type BtwSessionListItem,
	type BtwSideMetadata,
	loadBtwSessionCatalog,
	readBtwSideMetadata,
} from "../../src/core/extensions/builtin/btw/session-catalog.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";

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

function session(path: string, name?: string, cwd = "/repo"): BtwSessionListItem {
	return {
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
			readEntries: async (path) => entries.get(path) ?? [],
		});

		// Then
		expect(catalog.main?.path).toBe("/sessions/main.jsonl");
		expect(catalog.sides.map((side) => side.path)).toEqual(["/sessions/side-1.jsonl", "/sessions/side-2.jsonl"]);
		expect(catalog.sides.map((side) => side.metadata.ordinal)).toEqual([1, 2]);
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
			readEntries: async (path) => entries.get(path) ?? [],
		});

		// Then
		expect(catalog.parentSessionPath).toBe("/sessions/main.jsonl");
		expect(catalog.currentSide?.metadata.ordinal).toBe(2);
	});

	it("skips a stale row that disappears while metadata is loading", async () => {
		// Given
		const readEntries = vi.fn(async (path: string) => {
			if (path.endsWith("stale.jsonl")) throw new Error("ENOENT");
			return path.endsWith("side.jsonl") ? [customEntry(metadata())] : [];
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
			readEntries,
		});

		// Then
		expect(catalog.sides.map((side) => side.path)).toEqual(["/sessions/side.jsonl"]);
		expect(catalog.skippedPaths).toEqual(["/sessions/stale.jsonl"]);
	});
});
