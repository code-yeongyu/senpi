import { appendFile, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAdmissionLine } from "../../../agent/src/durable/store-admission.ts";
import { createMemoryStoreMedium, openMemoryStore } from "../../../agent/src/durable/store-memory.ts";
import type { StoreValue } from "../../../agent/src/durable/store.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createJsonlImporter } from "../../src/core/session-import/jsonl-import.ts";

// senpi#5070: the S07 importer must accept every session file SessionManager opens and hold the same entries.
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Plain = { [key: string]: StoreValue };
const isPlain = (value: StoreValue): value is Plain =>
	typeof value === "object" && value !== null && !Array.isArray(value);

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "s07-5070-"));
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
	// SessionManager migrates and rewrites a writable legacy file, so it loads a copy and the import source stays as written.
	const loadWithSessionManager = async (path: string) => {
		const copy = join(root, `sm-${Date.now()}-${Math.random()}.jsonl`);
		await copyFile(path, copy);
		return SessionManager.open(copy, root).getEntries() as unknown as StoreValue[];
	};
	return { root, importer, put, loadWithSessionManager };
}

const header = { type: "session", id: "legacy", timestamp: "2025-01-01T00:00:00.000Z", cwd: "/fixture" };
const v1Entries = [
	{ type: "message", timestamp: "2025-01-01T00:00:01.000Z", message: { role: "user", content: "hi", timestamp: 1 } },
	{
		type: "message",
		timestamp: "2025-01-01T00:00:02.000Z",
		message: { role: "user", content: "again", timestamp: 2 },
	},
	{
		type: "message",
		timestamp: "2025-01-01T00:00:03.000Z",
		message: { role: "hookMessage", content: "hook", timestamp: 3 },
	},
	{
		type: "compaction",
		timestamp: "2025-01-01T00:00:04.000Z",
		summary: "so far",
		firstKeptEntryIndex: 2,
		tokensBefore: 10,
	},
];

/** Entries with their generated ids replaced by their position, so two loads with different id schemes compare. */
function byPosition(entries: StoreValue[]): StoreValue[] {
	const position = new Map<string, number>();
	entries.forEach((entry, index) => {
		if (isPlain(entry) && typeof entry.id === "string") position.set(entry.id, index);
	});
	const at = (id: StoreValue | undefined): StoreValue =>
		typeof id === "string" ? (position.get(id) ?? `missing:${id}`) : (id ?? null);
	return entries.map((entry) => {
		if (!isPlain(entry)) return entry;
		const { id, parentId, firstKeptEntryId, ...rest } = entry;
		return {
			...rest,
			id: at(id),
			parentId: at(parentId),
			...(firstKeptEntryId === undefined ? {} : { firstKeptEntryId: at(firstKeptEntryId) }),
		};
	});
}

describe("JSONL import of legacy session files (senpi#5070)", () => {
	it("imports a pre-v2 session with the same migrated entries SessionManager loads, and keeps its ids across reopens", async () => {
		const f = await fixture();
		const path = await f.put("v1", [header, ...v1Entries]);
		const expected = await f.loadWithSessionManager(path);

		expect(await f.importer().importFile(path)).toMatchObject({ outcome: "imported", sessionId: "legacy" });
		const session = await f.importer().getSession("legacy");
		expect(session?.header).toMatchObject({ id: "legacy", version: 3 });
		const entries = session?.entries ?? [];
		expect(byPosition(entries)).toEqual(byPosition(expected));
		expect(entries.map((entry) => isPlain(entry) && entry.parentId)).toEqual([
			null,
			...entries.slice(0, -1).map((entry) => isPlain(entry) && entry.id),
		]);

		expect(await f.importer().importFile(path)).toMatchObject({ outcome: "unchanged", imported: 0 });
		await appendFile(
			path,
			JSON.stringify({
				type: "message",
				timestamp: "2025-01-01T00:00:05.000Z",
				message: { role: "user", content: "more", timestamp: 5 },
			}) + "\n",
		);
		expect(await f.importer().importFile(path)).toMatchObject({ outcome: "extended", imported: 1 });
		const extended = (await f.importer().getSession("legacy"))?.entries ?? [];
		expect(extended.slice(0, entries.length)).toEqual(entries);
		expect(byPosition(extended)).toEqual(byPosition(await f.loadWithSessionManager(path)));
	});

	it("keeps non-object and id-less lines in file order exactly as SessionManager loads them", async () => {
		const f = await fixture();
		const a = { type: "custom", id: "a", parentId: null, timestamp: "t", customType: "fixture", data: "a" };
		const b = { type: "custom", id: "b", parentId: "a", timestamp: "t", customType: "fixture", data: "b" };
		const idless = { type: "custom", timestamp: "t", customType: "fixture", data: "no id" };
		const path = await f.put("odd", [
			{ ...header, version: 3 },
			a,
			42,
			"note",
			[1, 2],
			null,
			0,
			false,
			"",
			idless,
			b,
		]);
		const expected = await f.loadWithSessionManager(path);

		expect(await f.importer().importFile(path)).toMatchObject({ outcome: "imported", sessionId: "legacy" });
		expect((await f.importer().getSession("legacy"))?.entries).toEqual(expected);
		expect(expected).toEqual([a, 42, "note", [1, 2], idless, b]);
		expect(await f.importer().importFile(path)).toMatchObject({ outcome: "unchanged" });
	});
});
