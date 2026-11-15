// senpi#5924 review M1/M2/L2/L3: the locked durable-file store several daemons share under one agent dir. A claim
// supersedes the earlier owner and its commits are refused, a retried claim keeps its epoch, the cross-process lock
// serializes claims, the file stays owner-only, a crashed writer's temp files go, and a corrupt file fails closed.
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openLockedFileStore } from "../../src/modes/rpc/locked-file-store.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function storePath(): string {
	const root = mkdtempSync(join(tmpdir(), "lfs-"));
	roots.push(root);
	return join(root, "store", "state.json");
}

const put = (key: string, data: string) => ({ op: "put", key, data }) as const;
const valid = { owner: "a", epoch: 1, records: [], documents: [] };

describe("locked file store", () => {
	it("a claim supersedes the earlier owner: its commit is refused stale-epoch and the newer state stays", async () => {
		const path = storePath();
		const [older, newer] = [openLockedFileStore(path), openLockedFileStore(path)];
		const olderEpoch = await older.claimFor("older");
		await older.commit(olderEpoch, [put("k", "older")], () => {});
		const newerEpoch = await newer.claimFor("newer");
		await newer.commit(newerEpoch, [put("k", "newer")], () => {});

		await expect(older.commit(olderEpoch, [put("k", "stale")], () => {})).rejects.toMatchObject({
			code: "stale-epoch",
		});
		expect(await older.getDocument("k")).toBe("newer");
		expect(await older.owner()).toBe("newer");
		expect(newerEpoch).toBe(olderEpoch + 1);
	});

	it("a repeated claim by the owner keeps its epoch, and racing claims get distinct epochs", async () => {
		const path = storePath();
		const store = openLockedFileStore(path);
		const first = await store.claimFor("a");
		expect(await store.claimFor("a")).toBe(first);
		expect(await store.readEpoch()).toBe(first);

		const epochs = await Promise.all(["b", "c", "d"].map((token) => openLockedFileStore(path).claimFor(token)));
		expect(new Set(epochs).size).toBe(3);
		expect([...epochs].sort()).toEqual([first + 1, first + 2, first + 3]);
	});

	it("keeps the file owner-only and removes the temp files a crashed writer left", async () => {
		const path = storePath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(join(dirname(path), ".state.json.crashed.tmp"), "{");

		await openLockedFileStore(path).claimFor("a");

		expect(readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it.each([
		["not JSON", "{"],
		["an epoch of 0", JSON.stringify({ ...valid, epoch: 0 })],
		["a fractional epoch", JSON.stringify({ ...valid, epoch: 1.5 })],
		["a string epoch", JSON.stringify({ ...valid, epoch: "1" })],
		["no owner", JSON.stringify({ ...valid, owner: undefined })],
		["a non-string owner", JSON.stringify({ ...valid, owner: 7 })],
		["a document without a string key", JSON.stringify({ ...valid, documents: [[1, "x"]] })],
		["a record without a sequence", JSON.stringify({ ...valid, records: [{ seq: 0, id: "r", kind: "k" }] })],
	])("fails closed on a file with %s", async (_label, text) => {
		const path = storePath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
		const store = openLockedFileStore(path);

		await expect(store.readEpoch()).rejects.toMatchObject({ name: "LockedFileStoreCorruptError" });
		await expect(store.claimFor("b")).rejects.toMatchObject({ name: "LockedFileStoreCorruptError" });
	});

	it("refuses a write whose temp file cannot be created and leaves the file as it was, never rewriting in place", async () => {
		const path = storePath();
		const store = openLockedFileStore(path);
		const epoch = await store.claimFor("a");
		await store.commit(epoch, [put("k", "before")], () => {});
		const before = readFileSync(path, "utf8");
		chmodSync(dirname(path), 0o500);
		try {
			await expect(store.commit(epoch, [put("k", "after")], () => {})).rejects.toMatchObject({
				name: "LockedFileStoreWriteError",
				code: "store_write_refused",
			});
		} finally {
			chmodSync(dirname(path), 0o700);
		}
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(await store.getDocument("k")).toBe("before");
	});

	it("tells the owner it lost the store as soon as another process claims it", async () => {
		const path = storePath();
		const store = openLockedFileStore(path);
		await store.claimFor("a");
		const lost = Promise.withResolvers<void>();
		const stop = store.watchOwnership("a", () => lost.resolve());
		try {
			await openLockedFileStore(path).claimFor("b");
			await lost.promise;
			expect(await store.owner()).toBe("b");
		} finally {
			stop();
		}
	});

	it("retries a transient owner read error, and gives up typed on one that persists", async () => {
		const path = storePath();
		await openLockedFileStore(path).claimFor("a");
		const emfile = () => Object.assign(new Error("too many open files"), { code: "EMFILE" });
		let failures = 1;
		const flaky = openLockedFileStore(path, {
			readText: (file) => {
				if (failures-- > 0) throw emfile();
				return readFileSync(file, "utf8");
			},
		});
		expect(await flaky.owner()).toBe("a");

		const broken = openLockedFileStore(path, {
			readText: () => {
				throw emfile();
			},
		});
		await expect(broken.owner()).rejects.toMatchObject({
			name: "LockedFileStoreReadError",
			code: "store_read_failed",
		});
	});
});
