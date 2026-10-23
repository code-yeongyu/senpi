/**
 * The saved session index (senpi#3968) is derived and disposable: a reopen parses only the lines appended since it
 * was saved, a crash can never make an uncommitted line visible through it, and any sign that the file is not the one
 * it describes (replaced, truncated, rewritten in place, or a broken index file) discards it and rebuilds from the file.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionByteIndex, StaleIndexError } from "../../src/core/session-index/session-byte-index.ts";
import { readSidecar, sidecarPath } from "../../src/core/session-index/sidecar.ts";
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

const base = [header, user("u1", null, "one"), assistant("a1", "u1", "two")];
const ids = (index: SessionByteIndex): string[] => index.records.map((record) => record.id);

describe("saved session index reuse (senpi#3968)", () => {
	it("#given a saved index #when lines are appended #then a reopen parses only the appended bytes", () => {
		const file = writeSessionFile(sessionDir(), base);
		SessionByteIndex.open(file);
		const appended = jsonl([user("u2", "a1", "three"), assistant("a2", "u2", "four")]);
		appendFileSync(file, appended);

		const reopened = SessionByteIndex.open(file);

		expect(reopened.lastScan).toMatchObject({
			reusedRecords: 3,
			scannedBytes: Buffer.byteLength(appended),
			rebuilt: false,
		});
		expect(ids(reopened)).toEqual(["s-1", "u1", "a1", "u2", "a2"]);
		expect(readSidecar(file)?.committedBytes).toBe(readFileSync(file).length);
	});

	it("#given a live index #when the file grows #then refresh reads only the new bytes", () => {
		const file = writeSessionFile(sessionDir(), base);
		const index = SessionByteIndex.open(file);
		appendFileSync(file, jsonl([user("u2", "a1", "three")]));

		expect(index.refresh()).toMatchObject({ reusedRecords: 3, rebuilt: false });
		expect(ids(index)).toEqual(["s-1", "u1", "a1", "u2"]);
	});
});

describe("crash safety (senpi#3968)", () => {
	it("#given a torn final line #then it is not indexed, not saved, and indexed once when completed", () => {
		const file = writeSessionFile(sessionDir(), base);
		const line = JSON.stringify(user("u2", "a1", "late"));
		appendFileSync(file, line.slice(0, 20));

		const torn = SessionByteIndex.open(file);
		expect(ids(torn)).toEqual(["s-1", "u1", "a1"]);
		expect(readSidecar(file)?.committedBytes).toBe(Buffer.byteLength(jsonl(base)));

		appendFileSync(file, `${line.slice(20)}\n`);
		expect(ids(SessionByteIndex.open(file))).toEqual(["s-1", "u1", "a1", "u2"]);
	});

	it("#given a whole final line without a newline #then it is indexed like the loader keeps it, but never saved", () => {
		const file = writeSessionFile(sessionDir(), base);
		appendFileSync(file, JSON.stringify(user("u2", "a1", "unterminated")));

		const index = SessionByteIndex.open(file);
		expect(ids(index)).toEqual(loadEntriesFromFile(file).map((entry) => entry.id));
		expect(readSidecar(file)?.records.map((record) => record.id)).toEqual(["s-1", "u1", "a1"]);

		appendFileSync(file, "\n");
		expect(ids(SessionByteIndex.open(file))).toEqual(["s-1", "u1", "a1", "u2"]);
	});
});

describe("saved index invalidation (senpi#3968)", () => {
	it("#given the file was replaced #then the saved index is discarded and rebuilt from the new file", () => {
		const file = writeSessionFile(sessionDir(), base);
		const stale = SessionByteIndex.open(file);
		const replacement = writeSessionFile(dirname(file), [header, user("x1", null, "replaced")], "next.jsonl");
		renameSync(replacement, file);

		expect(() => stale.readEntry(recordAt(stale, 1))).toThrow(StaleIndexError);
		const reopened = SessionByteIndex.open(file);
		expect(reopened.lastScan.rebuilt).toBe(true);
		expect(ids(reopened)).toEqual(["s-1", "x1"]);
	});

	it("#given a replacement that keeps the first and last lines #then the new file's middle lines are indexed, not the saved ones", () => {
		const file = writeSessionFile(sessionDir(), [...base, user("u2", "a1", "three")]);
		SessionByteIndex.open(file);
		const rewritten = readFileSync(file, "utf8").replace('"cacheRead":100', '"cacheRead":200');
		writeFileSync(`${file}.migrated`, rewritten);
		renameSync(`${file}.migrated`, file);

		const reopened = SessionByteIndex.open(file);
		expect(reopened.lastScan.rebuilt).toBe(true);
		expect(reopened.records.find((record) => record.id === "a1")?.usage?.cacheRead).toBe(200);
	});

	it("#given the file was truncated below the saved boundary #then the index rebuilds", () => {
		const file = writeSessionFile(sessionDir(), base);
		const index = SessionByteIndex.open(file);
		truncateSync(file, Buffer.byteLength(jsonl(base.slice(0, 2))));

		expect(index.refresh().rebuilt).toBe(true);
		expect(ids(index)).toEqual(["s-1", "u1"]);
	});

	it("#given the file was rewritten in place to the same length #then the saved record mismatch forces a rebuild", () => {
		const file = writeSessionFile(sessionDir(), base);
		SessionByteIndex.open(file);
		writeFileSync(file, readFileSync(file, "utf8").replace('"id":"a1"', '"id":"b1"'));

		const reopened = SessionByteIndex.open(file);
		expect(reopened.lastScan.rebuilt).toBe(true);
		expect(ids(reopened)).toEqual(["s-1", "u1", "b1"]);
	});

	it("#given a broken index file #then it is ignored and rewritten", () => {
		const file = writeSessionFile(sessionDir(), base);
		mkdirSync(dirname(sidecarPath(file)), { recursive: true });
		writeFileSync(sidecarPath(file), '{"v":1,"dev":');

		const index = SessionByteIndex.open(file);
		expect(index.lastScan.rebuilt).toBe(true);
		expect(readSidecar(file)?.records).toHaveLength(3);
	});

	it("#given an index folder that cannot be written #then the session still indexes and reports why it was not saved", () => {
		const dir = sessionDir();
		const file = writeSessionFile(dir, base);
		writeFileSync(join(dir, ".session-index"), "a file where the folder should be");

		const index = SessionByteIndex.open(file);
		expect(ids(index)).toEqual(["s-1", "u1", "a1"]);
		expect(index.lastScan.saveError).toEqual(expect.any(String));
	});
});
