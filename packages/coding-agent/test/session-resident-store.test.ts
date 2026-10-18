import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RESIDENT_STRING_PREFIX, ResidentStringStore } from "../src/core/session-resident-store.ts";

const KB = 1024;

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("ResidentStringStore", () => {
	it("round-trips large strings without a backing directory", () => {
		const store = new ResidentStringStore({ maxBytes: Number.MAX_SAFE_INTEGER });
		const text = "a".repeat(40 * KB);
		const token = store.externalize(text);
		expect(token).not.toBe(text);
		expect(store.materialize(token)).toBe(text);
	});

	it("never evicts without a recoverable backing directory", () => {
		const store = new ResidentStringStore({ maxBytes: 64 * KB });
		const first = store.externalize("x".repeat(40 * KB));
		const second = store.externalize("y".repeat(40 * KB));

		expect(store.materialize(first)).toBe("x".repeat(40 * KB));
		expect(store.materialize(second)).toBe("y".repeat(40 * KB));
		expect(store.stats().evictedCount).toBe(0);
	});

	it("evicts to disk over budget and hydrates transparently", () => {
		const dir = tempDir("resident-store-evict-");
		const blobs = join(dir, "blobs");
		try {
			const store = new ResidentStringStore({ maxBytes: 96 * KB, blobsDir: () => blobs });
			const texts = ["a".repeat(40 * KB), "b".repeat(40 * KB), "c".repeat(40 * KB)];
			const tokens = texts.map((text) => store.externalize(text));

			const stats = store.stats();
			expect(stats.evictedCount ?? 0).toBeGreaterThan(0);
			expect(stats.blobBytes).toBeLessThanOrEqual(96 * KB);
			expect(readdirSync(blobs).some((file) => file.endsWith(".blob"))).toBe(true);

			for (const [index, token] of tokens.entries()) {
				expect(store.materialize(token)).toBe(texts[index]);
			}
			expect(store.stats().blobBytes).toBeLessThanOrEqual(96 * KB);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps recently used strings resident and evicts the oldest first", () => {
		const dir = tempDir("resident-store-lru-");
		const blobs = join(dir, "blobs");
		try {
			const store = new ResidentStringStore({ maxBytes: 80 * KB, blobsDir: () => blobs });
			const oldText = "o".repeat(40 * KB);
			const oldToken = store.externalize(oldText);
			const newText = "n".repeat(40 * KB);
			store.externalize(newText);

			expect(store.materialize(oldToken)).toBe(oldText);

			store.externalize("t".repeat(40 * KB));
			expect(store.materialize(oldToken)).toBe(oldText);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("evict, hydrate and re-externalize adds no blob file", () => {
		const dir = tempDir("resident-store-rehydrate-");
		const blobs = join(dir, "blobs");
		try {
			const store = new ResidentStringStore({ maxBytes: KB, blobsDir: () => blobs });
			const text = "h".repeat(40 * KB);
			const token = store.externalize(text);
			const blobFilesAfterEviction = readdirSync(blobs).length;
			const evictionsAfterFirst = store.stats().evictedCount ?? 0;

			const reToken = store.externalize(store.materialize(token));

			expect(reToken).toBe(token);
			expect(readdirSync(blobs)).toHaveLength(blobFilesAfterEviction);
			// The hydrated string re-enters the resident map and is evicted onto its own
			// existing blob; a stale reverse index would skip both.
			expect(store.stats().evictedCount).toBe(evictionsAfterFirst + 1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("stores sharing one backing directory never hydrate each other's text", () => {
		const dir = tempDir("resident-store-shared-");
		const blobs = join(dir, "blobs");
		try {
			const storeA = new ResidentStringStore({ maxBytes: KB, blobsDir: () => blobs });
			const storeB = new ResidentStringStore({ maxBytes: KB, blobsDir: () => blobs });
			const textA = "a".repeat(40 * KB);
			const textB = "b".repeat(40 * KB);

			const tokenA = storeA.externalize(textA);
			const tokenB = storeB.externalize(textB);

			expect(storeA.materialize(tokenA)).toBe(textA);
			expect(storeB.materialize(tokenB)).toBe(textB);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps strings resident when the backing directory is unwritable", () => {
		const dir = tempDir("resident-store-fail-");
		try {
			const blocker = join(dir, "blocker");
			writeFileSync(blocker, "not a directory", "utf8");
			const store = new ResidentStringStore({ maxBytes: KB, blobsDir: () => join(blocker, "blobs") });

			const text = "f".repeat(40 * KB);
			const token = store.externalize(text);
			expect(store.materialize(token)).toBe(text);
			expect(store.stats().evictedCount).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("spills resident strings to the backing and keeps the backing for hydration", () => {
		const dir = tempDir("resident-store-spill-");
		const blobs = join(dir, "blobs");
		try {
			const store = new ResidentStringStore({ maxBytes: 96 * KB, blobsDir: () => blobs });
			const texts = ["a".repeat(40 * KB), "b".repeat(40 * KB)];
			const tokens = texts.map((text) => store.externalize(text));

			store.spillResident();

			expect(store.stats().blobCount).toBe(0);
			expect(store.stats().blobBytes).toBe(0);
			expect(readdirSync(blobs).filter((file) => file.endsWith(".blob"))).toHaveLength(2);
			for (const [index, token] of tokens.entries()) {
				expect(store.materialize(token)).toBe(texts[index]);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("hydrates readable-but-corrupt blobs by falling back to JSONL recovery", () => {
		const dir = tempDir("resident-store-corrupt-");
		const blobs = join(dir, "blobs");
		try {
			const store = new ResidentStringStore({ maxBytes: KB, blobsDir: () => blobs });
			const text = "c".repeat(40 * KB);
			const token = store.externalize(text);

			writeFileSync(join(blobs, `${token.slice(RESIDENT_STRING_PREFIX.length)}.blob`), "{corrupt", "utf8");

			const fallback = new Map([[token.slice(RESIDENT_STRING_PREFIX.length), text]]);
			expect(store.materialize(token, (id) => fallback.get(id))).toBe(text);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("re-externalizing a spilled string makes it resident again with the same token", () => {
		const dir = tempDir("resident-store-respill-");
		const blobs = join(dir, "blobs");
		try {
			const store = new ResidentStringStore({ maxBytes: 96 * KB, blobsDir: () => blobs });
			const text = "a".repeat(40 * KB);
			const token = store.externalize(text);
			store.spillResident();
			expect(store.stats().blobCount).toBe(0);

			const reToken = store.externalize(text);

			expect(reToken).toBe(token);
			expect(store.stats().blobCount).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a corrupt blob is removed on read so the next eviction rewrites it", () => {
		const dir = tempDir("resident-store-corrupt-prune-");
		const blobs = join(dir, "blobs");
		try {
			const store = new ResidentStringStore({ maxBytes: KB, blobsDir: () => blobs });
			const text = "c".repeat(40 * KB);
			const token = store.externalize(text);
			const id = token.slice(RESIDENT_STRING_PREFIX.length);
			const blobFile = join(blobs, `${id}.blob`);
			expect(existsSync(blobFile)).toBe(true);
			writeFileSync(blobFile, "{corrupt", "utf8");

			const hydrated = store.materialize(token, (missing) => (missing === id ? text : undefined));

			expect(hydrated).toBe(text);
			expect(existsSync(blobFile)).toBe(false);
			expect(store.externalize(text)).toBe(token);
			expect(existsSync(blobFile)).toBe(true);
			expect(store.materialize(token)).toBe(text);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves strings resident on spill without a backing directory", () => {
		const store = new ResidentStringStore({ maxBytes: 64 * KB });
		const text = "x".repeat(40 * KB);
		const token = store.externalize(text);

		store.spillResident();

		expect(store.materialize(token)).toBe(text);
	});

	it("externalizeInPlace/materializeInPlace round-trips runtime state", () => {
		const dir = tempDir("resident-store-inplace-");
		try {
			const store = new ResidentStringStore({ maxBytes: 64 * KB, blobsDir: () => join(dir, "blobs") });
			const large = "m".repeat(40 * KB);
			const state = { messages: [{ role: "user", content: [{ type: "text", text: large }] }] };

			store.externalizeInPlace(state);
			expect(JSON.stringify(state)).toContain(RESIDENT_STRING_PREFIX.slice(1, 20));

			store.materializeInPlace(state);
			expect(state.messages[0].content[0].text).toBe(large);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("removes blob files on clear", () => {
		const dir = tempDir("resident-store-clear-");
		const blobs = join(dir, "blobs");
		try {
			const store = new ResidentStringStore({ maxBytes: 64 * KB, blobsDir: () => blobs });
			store.externalize("x".repeat(40 * KB));
			store.externalize("y".repeat(40 * KB));
			expect(existsSync(blobs)).toBe(true);

			store.clear();
			expect(existsSync(blobs)).toBe(false);
			expect(store.stats()).toMatchObject({ blobCount: 0, blobBytes: 0, evictedCount: 0, evictedBytes: 0 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("BigInt values throw the JSON TypeError", () => {
		const store = new ResidentStringStore({ maxBytes: Number.MAX_SAFE_INTEGER });

		expect(() => store.externalize({ n: 1n })).toThrow(/BigInt/);
	});

	it("round-trips surrogate pairs through eviction", () => {
		const dir = tempDir("resident-store-utf16-");
		const blobs = join(dir, "blobs");
		try {
			const store = new ResidentStringStore({ maxBytes: 100 * KB, blobsDir: () => blobs });
			const text = "🦊".repeat(33_000);
			const token = store.externalize(text);
			store.externalize("z".repeat(33_000));
			expect(store.materialize(token)).toBe(text);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("SessionManager resident store wiring", () => {
	it("rebuilds materialized views after dropMaterializedCaches", async () => {
		const { SessionManager } = await import("../src/core/session-manager.ts");
		const dir = tempDir("resident-sm-drop-");
		try {
			const sessionDir = join(dir, "sessions");
			mkdirSync(sessionDir, { recursive: true });
			const session = SessionManager.create(dir, sessionDir);
			session.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() });

			const before = session.getEntries();
			expect(before).toHaveLength(1);

			session.dropMaterializedCaches();

			const after = session.getEntries();
			expect(after).toHaveLength(1);
			expect(after[0]!.id).toBe(before[0]!.id);
			expect(session.getResidentStoreStats().blobCount).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
