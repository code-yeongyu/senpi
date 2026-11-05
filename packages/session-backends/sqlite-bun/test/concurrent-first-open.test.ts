import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const OPENER = join(import.meta.dirname, "fixtures-open-store.ts");
const BUSY_TIMEOUT_MS = 5000;

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sqlite-bun-first-open-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function opener(path: string) {
	const child = spawn(process.execPath, [OPENER, path], { stdio: ["pipe", "pipe", "inherit"] });
	const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
	return {
		go: () => child.stdin.write("go\n"),
		next: async () => {
			const line = await lines.next();
			if (line.done === true) throw new Error("opener ended without a line");
			return line.value;
		},
		exited: once(child, "exit"),
	};
}

/** A peer that opened the new file before its switch to WAL, holding a read lock (rollback mode). */
function peerHoldingReadLock(path: string): Database {
	const peer = new Database(path, { create: true });
	peer.exec("BEGIN");
	peer.query("SELECT count(*) FROM sqlite_master").get();
	return peer;
}

describe("a store file's switch to WAL on first open", { timeout: 60_000 }, () => {
	// The switch retries a busy lock, so a lock held for good still fails, after the busy timeout and not before.
	it("waits out a peer's lock like busy_timeout, and fails only after that bound", async () => {
		const path = join(dir, "store.sqlite");
		const peer = peerHoldingReadLock(path);
		const child = opener(path);
		child.go();
		expect(await child.next()).toBe("start");
		const [outcome, elapsed] = (await child.next()).split(" ");
		await child.exited;
		peer.exec("COMMIT");
		peer.close();
		expect(outcome).toBe("ERR");
		expect(Number(elapsed)).toBeGreaterThanOrEqual(BUSY_TIMEOUT_MS);
	});

	// Before the fix, two openers switching one new file to WAL could fail with "database is locked" (SQLite answers the
	// deadlock at once, without the busy handler).
	it("never fails when many processes create the same store file at once", async () => {
		const results: string[] = [];
		for (let file = 0; file < 10; file++) {
			const children = Array.from({ length: 12 }, () => opener(join(dir, `s${file}.sqlite`)));
			for (const child of children) child.go();
			for (const child of children) {
				await child.next();
				results.push((await child.next()).split(" ")[0] ?? "");
				await child.exited;
			}
		}
		expect(results.filter((result) => result !== "ok")).toEqual([]);
	});
});
