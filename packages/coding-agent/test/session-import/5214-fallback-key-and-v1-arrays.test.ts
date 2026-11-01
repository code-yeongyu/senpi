import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAdmissionLine } from "../../../agent/src/durable/store-admission.ts";
import { createMemoryStoreMedium, openMemoryStore } from "../../../agent/src/durable/store-memory.ts";
import type { StoreValue } from "../../../agent/src/durable/store.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createJsonlImporter } from "../../src/core/session-import/jsonl-import.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Plain = { [key: string]: StoreValue };
const isPlain = (value: StoreValue | undefined): value is Plain =>
	typeof value === "object" && value !== null && !Array.isArray(value);

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "s07-5214-"));
	roots.push(root);
	const medium = createMemoryStoreMedium();
	await openMemoryStore(medium).claim(0, 1);
	const importer = () =>
		createJsonlImporter({
			store: openMemoryStore(medium),
			epoch: 1,
			admission: createAdmissionLine(),
			now: () => Date.now() + 10_000,
		});
	const put = async (name: string, lines: unknown[]) => {
		const path = join(root, `${name}.jsonl`);
		await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
		return path;
	};
	const loadWithSessionManager = async (path: string) => {
		const copy = join(root, `sm-${Math.random()}.jsonl`);
		await copyFile(path, copy);
		return SessionManager.open(copy, root).getEntries() as unknown as StoreValue[];
	};
	return { importer, put, loadWithSessionManager };
}

const header = { type: "session", id: "s", timestamp: "2025-01-01T00:00:00.000Z", cwd: "/fixture" };

describe("JSONL import keys and v1 array lines (senpi#5214)", () => {
	it("imports a real id spelled like a fallback key next to the id-less line it would collide with", async () => {
		const f = await fixture();
		const real = {
			type: "custom",
			id: "~line-1",
			parentId: null,
			timestamp: "t",
			customType: "fixture",
			data: "real",
		};
		const escaped = {
			type: "custom",
			id: "~~line-1",
			parentId: "~line-1",
			timestamp: "t",
			customType: "fixture",
			data: "x",
		};
		const path = await f.put("collide", [{ ...header, version: 3 }, real, 42, escaped]);
		const expected = await f.loadWithSessionManager(path);

		expect(await f.importer().importFile(path)).toMatchObject({ outcome: "imported", sessionId: "s" });
		expect((await f.importer().getSession("s"))?.entries).toEqual(expected);
		expect(expected).toEqual([real, 42, escaped]);
		expect(await f.importer().importFile(path)).toMatchObject({ outcome: "unchanged" });
	});

	it("links around a v1 array line where SessionManager leaves dangling ids", async () => {
		const f = await fixture();
		const message = (content: string, at: number) => ({
			type: "message",
			timestamp: `2025-01-01T00:00:0${at}.000Z`,
			message: { role: "user", content, timestamp: at },
		});
		const lines = [
			header,
			message("first", 1),
			["an", "array"],
			message("after the array", 2),
			{
				type: "compaction",
				timestamp: "2025-01-01T00:00:03.000Z",
				summary: "s",
				firstKeptEntryIndex: 2,
				tokensBefore: 1,
			},
		];
		const path = await f.put("v1-array", lines);
		const sm = await f.loadWithSessionManager(path);
		expect(await f.importer().importFile(path)).toMatchObject({ outcome: "imported" });
		const imported = (await f.importer().getSession("s"))?.entries ?? [];

		const ids = (entries: StoreValue[]) =>
			new Set(
				entries
					.filter(isPlain)
					.map((entry) => entry.id)
					.filter((id) => typeof id === "string"),
			);
		const [smFirst, , smAfter, smCompaction] = sm;
		const [first, array, after, compaction] = imported;
		expect(array).toEqual(["an", "array"]);
		expect(Object.keys(array as object)).toEqual(["0", "1"]);
		// Named difference 0: SessionManager's in-memory array carries the v1 id it was given; JSON drops it on save.
		expect(Object.keys(sm[1] as object)).toEqual(["0", "1", "id", "parentId"]);
		expect(JSON.parse(JSON.stringify(sm[1]))).toEqual(["an", "array"]);

		// Named difference 1: the entry after the array line.
		if (!isPlain(smAfter) || !isPlain(after) || !isPlain(smFirst) || !isPlain(first))
			throw new Error("expected entries");
		expect(ids(sm).has(smAfter.parentId as string)).toBe(false);
		expect(after.parentId).toBe(first.id);

		// Named difference 2: a compaction whose firstKeptEntryIndex points at the array line.
		if (!isPlain(smCompaction) || !isPlain(compaction)) throw new Error("expected compactions");
		expect(typeof smCompaction.firstKeptEntryId).toBe("string");
		expect(ids(sm).has(smCompaction.firstKeptEntryId as string)).toBe(false);
		expect(compaction).not.toHaveProperty("firstKeptEntryId");
		expect(compaction).not.toHaveProperty("firstKeptEntryIndex");
	});
});
