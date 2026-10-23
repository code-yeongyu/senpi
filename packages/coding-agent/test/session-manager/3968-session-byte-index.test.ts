/**
 * The content-free byte index of a session file (senpi#3968): one record per line the loader keeps, with the line's
 * exact UTF-8 byte range and no body text, so a large session's history can be planned and read back by position.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventLoopSlicer } from "../../src/core/event-loop-slicer.ts";
import { sidecarPath } from "../../src/core/session-index/sidecar.ts";
import { SessionByteIndex } from "../../src/core/session-index/session-byte-index.ts";
import { loadEntriesFromFile } from "../../src/core/session-manager.ts";
import {
	assistant,
	header,
	jsonl,
	recordAt,
	sessionDir,
	user,
	writeSessionFile,
} from "./session-byte-index-support.ts";

describe("SessionByteIndex records (senpi#3968)", () => {
	it("#given lines with multi-byte text #then every record's byte range reads back the entry the loader keeps", () => {
		const entries = [
			header,
			user("u1", null, "안녕하세요 🌊 multi-byte"),
			assistant("a1", "u1", "답변 ✅"),
			user("u2", "a1", "plain"),
		];
		const file = writeSessionFile(sessionDir(), entries);

		const index = SessionByteIndex.open(file);

		const loaded = loadEntriesFromFile(file);
		expect(index.records.map((record) => record.id)).toEqual(loaded.map((entry) => entry.id));
		expect(index.records.map((record) => index.readEntry(record))).toEqual(loaded);
		expect(index.records[2]?.offset).toBe(Buffer.byteLength(jsonl(entries.slice(0, 2))));
		expect(index.committedLength).toBe(Buffer.byteLength(jsonl(entries)));
	});

	it("#given large bodies #then neither the records nor the saved index hold any body text", () => {
		const body = `BODY-MARKER-${"x".repeat(256 * 1024)}`;
		const image = `IMAGE-MARKER-${"A".repeat(128 * 1024)}`;
		const toolResult = {
			type: "message",
			id: "t1",
			parentId: "a1",
			timestamp: "2026-10-23T00:00:03.000Z",
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "bash",
				content: [{ type: "image", data: image, mimeType: "image/png" }],
				isError: false,
				timestamp: 3,
			},
		};
		const file = writeSessionFile(sessionDir(), [
			header,
			user("u1", null, body),
			assistant("a1", "u1", body),
			toolResult,
		]);

		const index = SessionByteIndex.open(file);

		const held = JSON.stringify(index.records);
		const saved = readFileSync(sidecarPath(file), "utf8");
		for (const text of [held, saved]) {
			expect(text).not.toContain("BODY-MARKER");
			expect(text).not.toContain("IMAGE-MARKER");
			expect(text.length).toBeLessThan(2048);
		}
		expect(index.records.find((record) => record.id === "a1")).toMatchObject({
			role: "assistant",
			usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 1, cost: 0.25 },
		});
	});

	it("#given duplicate ids and a malformed line #then duplicates are kept in order and the malformed line is skipped", () => {
		const dir = sessionDir();
		const file = writeSessionFile(dir, [header, user("u1", null, "first"), user("u1", null, "again")]);
		const withGarbage = `${readFileSync(file, "utf8")}{not json\n${JSON.stringify(user("u2", "u1", "after"))}\n`;
		const garbled = join(dir, "garbled.jsonl");
		writeFileSync(garbled, withGarbage);

		const index = SessionByteIndex.open(garbled);

		expect(index.records.map((record) => record.id)).toEqual(loadEntriesFromFile(garbled).map((entry) => entry.id));
		expect(index.records.map((record) => record.id)).toEqual(["s-1", "u1", "u1", "u2"]);
		expect(index.readEntry(recordAt(index, 3))).toMatchObject({ id: "u2" });
	});

	it("#given a file whose first entry is not a session header #then it indexes nothing, like the loader", () => {
		const file = writeSessionFile(sessionDir(), [user("u1", null, "headless")]);

		const index = SessionByteIndex.open(file);

		expect(index.records).toEqual([]);
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("#given custom entries and a tool_search activation marker #then the custom type and the marker are indexed", () => {
		const marker = "[tool_search:activated:v2] " + JSON.stringify([{ name: "mcp_tool", registrationId: "r1" }]);
		const file = writeSessionFile(sessionDir(), [
			header,
			{ type: "custom", id: "k1", parentId: null, timestamp: "t", customType: "client-admission", data: { a: 1 } },
			user("u1", "k1", "no marker here"),
			assistant("a1", "u1", marker),
		]);

		const records = SessionByteIndex.open(file).records;

		expect(records[1]).toMatchObject({ type: "custom", customType: "client-admission" });
		expect(records.filter((record) => record.activationMarker === true).map((record) => record.id)).toEqual(["a1"]);
	});

	it("#given a host's event loop #then openAsync yields while it parses and indexes exactly what open does", async () => {
		const entries = [
			header,
			...Array.from({ length: 50 }, (_, n) => user(`u${n}`, n === 0 ? null : `u${n - 1}`, `turn ${n}`)),
		];
		const file = writeSessionFile(sessionDir(), entries);
		let tick = 0;
		let yields = 0;
		const slicer = new EventLoopSlicer({ budgetMs: 1, clock: () => tick++ });
		const yieldOnce = slicer.yield.bind(slicer);
		slicer.yield = async () => {
			yields++;
			await yieldOnce();
		};

		const sliced = await SessionByteIndex.openAsync(file, slicer, { persist: false });

		expect(yields).toBeGreaterThan(10);
		expect(sliced.records).toEqual(SessionByteIndex.open(file, { persist: false }).records);
	});

	it("#given compaction, label and name entries #then their small state fields are indexed", () => {
		const file = writeSessionFile(sessionDir(), [
			header,
			user("u1", null, "q"),
			{
				type: "compaction",
				id: "c1",
				parentId: "u1",
				timestamp: "t",
				summary: "S",
				firstKeptEntryId: "u1",
				tokensBefore: 9,
			},
			{
				type: "label",
				id: "l1",
				parentId: "c1",
				timestamp: "2026-10-23T00:00:05.000Z",
				targetId: "u1",
				label: "pin",
			},
			{ type: "session_info", id: "n1", parentId: "l1", timestamp: "t", name: "Big session" },
		]);

		const index = SessionByteIndex.open(file);

		expect(index.records.slice(2)).toMatchObject([
			{ type: "compaction", firstKeptEntryId: "u1" },
			{ type: "label", targetId: "u1", label: "pin", timestamp: "2026-10-23T00:00:05.000Z" },
			{ type: "session_info", name: "Big session" },
		]);
	});
});
