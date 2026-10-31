import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAdmissionLine } from "../../../agent/src/durable/store-admission.ts";
import { createMemoryStoreMedium, openMemoryStore } from "../../../agent/src/durable/store-memory.ts";
import type { DurableStoreOptions } from "../../../agent/src/durable/store.ts";
import { createJsonlImporter, jsonlFiles, writeHatchMarker } from "../../src/core/session-import/jsonl-import.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const header = (id: string) => ({ type: "session", version: 3, id, timestamp: "2026-01-01", cwd: "/fixture" });
const entry = (id: string, parentId: string | null = null, data = id) => ({
	type: "custom",
	id,
	parentId,
	timestamp: "2026-01-01",
	customType: "fixture",
	data,
});
const text = (id: string, entries: ReturnType<typeof entry>[]) =>
	[header(id), ...entries].map((value) => JSON.stringify(value)).join("\n") + "\n";

async function fixture(options: DurableStoreOptions = {}) {
	const root = await mkdtemp(join(tmpdir(), "s07-"));
	roots.push(root);
	const medium = createMemoryStoreMedium();
	const store = openMemoryStore(medium, options);
	await store.claim(0, 1);
	const reads: { path: string; start: number; end: number }[] = [];
	let clock = Date.now() + 10_000;
	const files = {
		...jsonlFiles,
		read: async (path: string, start: number, end: number) => {
			reads.push({ path, start, end });
			return jsonlFiles.read(path, start, end);
		},
	};
	const reopen = () =>
		createJsonlImporter({
			store: openMemoryStore(medium, options),
			epoch: 1,
			admission: createAdmissionLine(),
			files,
			now: () => clock,
			mtimeTickMs: 1,
		});
	const put = async (name: string, contents: string) => {
		const path = join(root, `${name}.jsonl`);
		await writeFile(path, contents);
		return path;
	};
	return {
		root,
		medium,
		store,
		reads,
		files,
		reopen,
		put,
		setClock: (value: number) => {
			clock = value;
		},
	};
}

// R1.f / S07, #4995: the durable documents and actual file bytes are the assertion boundary.
describe("JSONL import", () => {
	it("imports a new session and later tails exactly once across reopen, preserving interleaved parent links", async () => {
		const f = await fixture();
		const a = entry("a");
		const b = entry("b", "a");
		const c = entry("c", "a");
		const d = entry("d", "b");
		const path = await f.put("first", text("s", [a]));
		expect(await f.reopen().open([path])).toMatchObject([{ outcome: "imported", sessionId: "s", imported: 1 }]);
		await writeFile(path, text("s", [a, b, c, d]));
		expect(await f.reopen().importFile(path)).toMatchObject({ outcome: "extended", imported: 3 });
		await f.reopen().open([path]);
		expect((await f.reopen().getSession("s"))?.entries).toEqual([a, b, c, d]);
		expect(await f.reopen().getLedger(path)).toMatchObject({
			sourceSessionId: "s",
			sessionId: "s",
			writerKind: "other",
			highWaterMark: { id: "d" },
		});
	});

	it("uses session identity rather than the file name and imports interleaved entries before its high water mark", async () => {
		const f = await fixture();
		const a = entry("a");
		const b = entry("b", "a");
		const path = await f.put("one", text("s", [a, b]));
		await f.reopen().importFile(path);
		const other = await f.put("renamed", text("s", [a, entry("x", "a"), b, entry("c", "b")]));
		expect(await f.reopen().importFile(other)).toMatchObject({ outcome: "extended", imported: 2 });
		expect((await f.reopen().getSession("s"))?.entries.map((value) => value.id)).toEqual(["a", "x", "b", "c"]);
	});

	it.each(["hatch", "other", "stale-marker"] as const)(
		"handles %s divergence without losing the original attribution",
		async (writer) => {
			const f = await fixture();
			const before = text("s", [entry("a")]);
			const path = await f.put("session", before);
			await f.reopen().importFile(path);
			if (writer === "stale-marker") await writeHatchMarker(path, await jsonlFiles.stat(path));
			const after = text("s", [entry("a", null, "edited")]);
			await writeFile(path, after);
			if (writer === "hatch") await writeHatchMarker(path, await jsonlFiles.stat(path));
			const result = await f.reopen().importFile(path);
			if (writer === "hatch") {
				expect(result.outcome).toBe("forked");
				expect(result.sessionId).not.toBe("s");
				expect((await f.reopen().getSession("s"))?.entries).toEqual([entry("a")]);
				expect(await f.reopen().getSession(result.sessionId)).toMatchObject({
					header: { id: result.sessionId },
					divergence: { kind: "k9f2", parentSessionId: "s" },
					entries: [entry("a", null, "edited")],
				});
				expect((await f.reopen().getSession(result.sessionId))?.divergence?.note.length).toBeGreaterThan(0);
				await writeFile(path, text("s", [entry("a", null, "edited"), entry("b", "a")]));
				await writeHatchMarker(path, await jsonlFiles.stat(path));
				expect(await f.reopen().importFile(path)).toMatchObject({
					outcome: "extended",
					sessionId: result.sessionId,
				});
			} else {
				expect(result).toMatchObject({ outcome: "adopted", sessionId: "s" });
				expect((await f.reopen().getSession("s"))?.divergence).toBeUndefined();
				expect((await f.reopen().getSession("s"))?.entries).toEqual([entry("a", null, "edited")]);
			}
			expect(await readFile(path, "utf8")).not.toBe(before);
		},
	);

	it("recognizes a recorded store projection and does not swallow an unrecorded append", async () => {
		const f = await fixture();
		const contents = text("s", [entry("a")]);
		const path = await f.put("session", contents);
		const importer = f.reopen();
		await importer.importFile(path);
		await importer.recordProjection(path, contents, await jsonlFiles.stat(path));
		f.reads.length = 0;
		expect(await f.reopen().importFile(path)).toMatchObject({ outcome: "unchanged", sessionId: "s" });
		expect(f.reads).toEqual([]);
		expect((await importer.getLedger(path))?.writerKind).toBe("store");
		const written = await jsonlFiles.stat(path);
		await writeFile(path, text("s", [entry("a"), entry("b", "a")]));
		await importer.recordProjection(path, contents, written);
		expect(await importer.importFile(path)).toMatchObject({ outcome: "extended", imported: 1 });
	});

	it("refuses a projection record whose image size differs from its written stamp", async () => {
		const f = await fixture();
		const contents = text("s", [entry("a")]);
		const path = await f.put("session", contents);
		const importer = f.reopen();
		await importer.importFile(path);
		const before = await importer.getLedger(path);
		const stamp = await jsonlFiles.stat(path);
		await expect(importer.recordProjection(path, contents, { ...stamp, size: stamp.size + 1 })).rejects.toThrow(
			"Projection size does not match its written image",
		);
		expect(await importer.getLedger(path)).toEqual(before);
	});

	it("adopts a same-size divergence whose marker matches the size but not the mtime", async () => {
		const f = await fixture();
		const path = await f.put("session", text("s", [entry("a", null, "x")]));
		await f.reopen().importFile(path);
		const imported = await stat(path);
		await writeFile(path, text("s", [entry("a", null, "y")]));
		const mtime = new Date(imported.mtimeMs + 5_000);
		await utimes(path, mtime, mtime);
		const edited = await jsonlFiles.stat(path);
		expect(edited.size).toBe(imported.size);
		await writeHatchMarker(path, { size: edited.size, mtimeMs: edited.mtimeMs - 1_000 });
		expect(await f.reopen().importFile(path)).toMatchObject({ outcome: "adopted", sessionId: "s" });
		expect(await f.reopen().getLedger(path)).toMatchObject({ writerKind: "other" });
		expect(await f.store.scanDocuments("session-import/session/")).toHaveLength(1);
	});

	it.each(["a", "b"])("detects same-size same-tick edits to entry %s, including a non-HWM entry", async (edited) => {
		const f = await fixture();
		const path = await f.put("session", text("s", [entry("a"), entry("b", "a")]));
		const stamp = await stat(path);
		let ctimeMs = stamp.ctimeMs;
		f.files.stat = async (file) => ({ ...(await jsonlFiles.stat(file)), mtimeMs: stamp.mtimeMs, ctimeMs });
		f.setClock(stamp.mtimeMs);
		const importer = f.reopen();
		await importer.importFile(path);
		const original = await stat(path);
		await writeFile(
			path,
			text("s", [entry("a", null, edited === "a" ? "z" : "a"), entry("b", "a", edited === "b" ? "z" : "b")]),
		);
		await utimes(path, original.atime, original.mtime);
		// Pin the HWM case to one timestamp tick; an earlier-entry edit needs the ctime signal.
		if (edited === "a") ctimeMs += 1;
		expect((await stat(path)).size).toBe(original.size);
		expect((await f.files.stat(path)).mtimeMs).toBe(stamp.mtimeMs);
		expect(await importer.importFile(path)).toMatchObject({ outcome: "adopted" });
		expect((await importer.getSession("s"))?.entries.find((value) => value.id === edited)?.data).toBe("z");
	});

	it("probes only the HWM bytes for an unchanged same-tick file and reads zero settled files", async () => {
		const f = await fixture();
		const path = await f.put("session", text("s", [entry("a"), entry("b", "a")]));
		f.setClock((await stat(path)).mtimeMs);
		await f.reopen().importFile(path);
		const ledger = await f.reopen().getLedger(path);
		f.reads.length = 0;
		await f.reopen().importFile(path);
		expect(f.reads).toEqual([{ path, start: ledger?.highWaterMark.offset, end: ledger?.highWaterMark.end }]);
		f.setClock(Date.now() + 10_000);
		await f.reopen().importFile(path);
		f.reads.length = 0;
		await f.reopen().importFile(path);
		expect(f.reads).toEqual([]);
	});

	it("reads only the changed file on a multi-session reopen", async () => {
		const f = await fixture();
		const a = await f.put("a", text("a", [entry("a")]));
		const b = await f.put("b", text("b", [entry("b")]));
		await f.reopen().open([a, b]);
		f.reads.length = 0;
		await f.reopen().open([a, b]);
		expect(f.reads).toEqual([]);
		await writeFile(b, text("b", [entry("b"), entry("c", "b")]));
		await f.reopen().open([a, b]);
		expect([...new Set(f.reads.map((read) => read.path))]).toEqual([b]);
	});

	it("keeps UTF-8 HWM byte ranges and imports a header-only session", async () => {
		const f = await fixture();
		const path = await f.put("unicode", text("s", []));
		await f.reopen().importFile(path);
		expect((await f.reopen().getSession("s"))?.entries).toEqual([]);
		const entries = [entry("a", null, "\uD55C\uAE00"), entry("b", "a", "\uD83C\uDF0D")];
		await writeFile(path, text("s", entries));
		f.setClock((await stat(path)).mtimeMs);
		await f.reopen().importFile(path);
		f.reads.length = 0;
		await f.reopen().importFile(path);
		const ledger = await f.reopen().getLedger(path);
		if (!ledger) throw new Error("Expected an imported file ledger");
		const hwm = ledger.highWaterMark;
		expect(f.reads).toEqual([{ path, start: hwm.offset, end: hwm.end }]);
		expect(Buffer.from(await jsonlFiles.read(path, hwm.offset, hwm.end)).toString()).toBe(JSON.stringify(entries[1]));
	});

	it("does not commit a file that changes while its snapshot is being read", async () => {
		const f = await fixture();
		const path = await f.put("session", text("s", [entry("a")]));
		const originalRead = f.files.read;
		let changed = false;
		f.files.read = async (file, start, end) => {
			const bytes = await originalRead(file, start, end);
			if (!changed) {
				changed = true;
				await writeFile(path, text("s", [entry("a"), entry("b", "a")]));
			}
			return bytes;
		};
		const failure = await f
			.reopen()
			.importFile(path)
			.then(
				() => undefined,
				(reason: unknown) => reason,
			);
		expect(failure).toBeInstanceOf(Error);
		expect(await f.reopen().getSession("s")).toBeUndefined();
		expect(await f.reopen().getLedger(path)).toBeUndefined();
		expect(await f.reopen().importFile(path)).toMatchObject({ outcome: "imported", imported: 2 });
	});

	it("serializes simultaneous opens on the shared admission line", async () => {
		const f = await fixture();
		const path = await f.put("session", text("s", [entry("a")]));
		const admission = createAdmissionLine();
		const options = { store: f.store, epoch: 1, admission, now: () => Date.now() + 10_000 };
		const results = await Promise.all([
			createJsonlImporter(options).importFile(path),
			createJsonlImporter(options).importFile(path),
		]);
		expect(results.map((result) => result.outcome)).toEqual(["imported", "unchanged"]);
		expect(await f.store.scanDocuments("session-import/session/")).toHaveLength(1);
	});

	it.each(["write", "durable"] as const)(
		"recovers an interrupted %s commit without duplicate hatch forks",
		async (cut) => {
			let armed = false;
			const f = await fixture({
				onWritePoint: (point) => {
					if (armed && point.op === "commit" && point.at === cut && (point.at !== "write" || point.index === 2)) {
						armed = false;
						throw new Error("cut");
					}
				},
			});
			const path = await f.put("session", text("s", [entry("a")]));
			await f.reopen().importFile(path);
			await writeFile(path, text("s", [entry("b")]));
			await writeHatchMarker(path, await jsonlFiles.stat(path));
			armed = true;
			const error = await f
				.reopen()
				.importFile(path)
				.then(
					() => undefined,
					(reason: unknown) => reason,
				);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe("cut");
			await f.reopen().importFile(path);
			const ledger = await f.reopen().getLedger(path);
			if (!ledger) throw new Error("Expected an imported file ledger after recovery");
			expect(ledger.sessionId).not.toBe("s");
			const sessions = await f.store.scanDocuments("session-import/session/");
			expect(sessions).toHaveLength(2);
			expect((await f.reopen().getSession(ledger.sessionId))?.entries).toEqual([entry("b")]);
		},
	);
});
