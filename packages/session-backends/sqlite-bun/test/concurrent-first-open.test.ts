import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStoreFile } from "../src/sqlite-file.ts";

const OPENER = join(import.meta.dirname, "fixtures-open-store.ts");

// Every Database the store opens, with what its path held at that moment: SQLite switches a file to WAL with a single
// exclusive-lock attempt (no busy handler), so an open at the store path must never find a missing or non-WAL file.
const opened: { path: string; state: "missing" | "empty" | "rollback" | "wal" }[] = [];
vi.mock("bun:sqlite", async (importOriginal) => {
	const sqlite = await importOriginal<typeof import("bun:sqlite")>();
	const { existsSync, readFileSync } = await import("node:fs");
	class ObservedDatabase extends sqlite.Database {
		constructor(path: string, options?: ConstructorParameters<typeof sqlite.Database>[1]) {
			const bytes = existsSync(path) ? readFileSync(path) : undefined;
			opened.push({
				path,
				state: bytes === undefined ? "missing" : bytes.length < 20 ? "empty" : bytes[18] === 2 ? "wal" : "rollback",
			});
			super(path, options);
		}
	}
	return { ...sqlite, Database: ObservedDatabase };
});
const PROCESSES = 12;
const FILES = 10;

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sqlite-bun-first-open-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("a store file's first open", { timeout: 120_000 }, () => {
	// Many processes open one store file that does not exist yet. Before the fix the file appeared at its path before it
	// was in WAL mode, and an opener racing the creator's WAL switch got "database is locked" with no busy wait.
	it("never fails when many processes create the same store file at once", async () => {
		const results: string[] = [];
		for (let file = 0; file < FILES; file++) {
			const path = join(dir, `s${file}.sqlite`);
			const go = join(dir, `go${file}`);
			const children = Array.from({ length: PROCESSES }, () =>
				Bun.spawn([process.execPath, OPENER, path, go], { stdout: "pipe", stderr: "pipe" }),
			);
			writeFileSync(go, "");
			for (const child of children) {
				results.push((await new Response(child.stdout).text()).trim());
				await child.exited;
			}
		}
		expect(results.filter((result) => result !== "ok")).toEqual([]);
	});

	it("never opens the store path before the file there is in WAL mode, and leaves no temporary file", () => {
		const path = join(dir, "store.sqlite");
		opened.length = 0;
		openStoreFile(path).db.close();
		openStoreFile(path).db.close();
		expect(opened.filter((open) => open.path === path).map((open) => open.state)).toEqual(["wal", "wal"]);
		const header = readFileSync(path);
		// Bytes 18 and 19 of the SQLite header are the file format write/read versions: 2 means WAL.
		expect([header[18], header[19]]).toEqual([2, 2]);
		expect(readdirSync(dir).filter((name) => name !== "store.sqlite" && !name.startsWith("store.sqlite-"))).toEqual(
			[],
		);
	});
});
