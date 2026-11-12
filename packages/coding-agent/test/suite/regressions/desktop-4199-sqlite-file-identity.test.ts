import { renameSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FileIdentity, openExpectedFile } from "../../../src/modes/rpc/sqlite-file-identity.ts";

// One outcome per descriptor listing, in order: an errno code fails that listing's readdir; undefined lets it run.
const listings = vi.hoisted(() => ({ outcomes: [] as (string | undefined)[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		readdir: (async (...args: Parameters<typeof actual.readdir>) => {
			const descriptors = String(args[0]) === "/proc/self/fd" || String(args[0]) === "/dev/fd";
			const code = descriptors ? listings.outcomes.shift() : undefined;
			if (code !== undefined) throw Object.assign(new Error(`${code}: injected listing failure`), { code });
			return actual.readdir(...args);
		}) as typeof actual.readdir,
	};
});

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (design 4.2a). Security contract:
// a SQLite open of a file validated through its own descriptor is accepted only when the file SQLite holds is that one.
// A name swapped for an impostor during the open and swapped back afterwards passes the name check, so only the
// descriptor listing catches it, including while another connection of this process holds the validated file open.
const listable = process.platform === "linux" || process.platform === "darwin";

describe.skipIf(!listable)("SQLite file identity proof", () => {
	const roots: string[] = [];
	const holders: DatabaseSync[] = [];

	afterEach(async () => {
		listings.outcomes = [];
		for (const holder of holders.splice(0)) holder.close();
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	async function seeded(name = "store.db"): Promise<{ root: string; path: string; expected: FileIdentity }> {
		const root = await mkdtemp(join(tmpdir(), "rpc4199-identity-"));
		roots.push(root);
		const path = join(root, name);
		writeFileSync(path, "", { mode: 0o600 });
		const info = statSync(path, { bigint: true });
		return { root, path, expected: { dev: info.dev, ino: info.ino } };
	}

	/** SQLite's open of `path` with the name swapped for an impostor during it and swapped back once SQLite holds it. */
	function swappedOpen(root: string, path: string): () => DatabaseSync {
		return () => {
			writeFileSync(join(root, "impostor.db"), "", { mode: 0o600 });
			renameSync(path, join(root, "parked.db"));
			renameSync(join(root, "impostor.db"), path);
			try {
				return new DatabaseSync(path);
			} finally {
				renameSync(path, join(root, "impostor.db"));
				renameSync(join(root, "parked.db"), path);
			}
		};
	}

	function closing(closed: DatabaseSync[]): (database: DatabaseSync) => void {
		return (database) => {
			closed.push(database);
			database.close();
		};
	}

	it("refuses a swap undone after the open as replaced when no connection of this process has the file open", async () => {
		const { root, path, expected } = await seeded();
		const closed: DatabaseSync[] = [];
		const result = await openExpectedFile(path, async () => expected, swappedOpen(root, path), closing(closed));
		expect(result).toHaveProperty("replaced");
		expect(closed).toHaveLength(1);
	});

	it("answers busy, never opened, for a swap undone after the open while a holder connection has the file open", async () => {
		const { root, path, expected } = await seeded();
		holders.push(new DatabaseSync(path));
		const closed: DatabaseSync[] = [];
		const result = await openExpectedFile(path, async () => expected, swappedOpen(root, path), closing(closed));
		expect(result).not.toHaveProperty("opened");
		expect(result).toHaveProperty("busy");
		expect(closed).toHaveLength(1);
	});

	it("opens the validated file while a holder connection has it open", async () => {
		const { path, expected } = await seeded();
		holders.push(new DatabaseSync(path));
		const result = await openExpectedFile(
			path,
			async () => expected,
			() => new DatabaseSync(path),
			closing([]),
		);
		expect(result).toHaveProperty("opened");
		if ("opened" in result) holders.push(result.opened);
	});

	it("runs concurrent checked opens of this process one at a time", async () => {
		const first = await seeded("first.db");
		const second = await seeded("second.db");
		let firstSettled = false;
		let firstSettledBySecondOpen: boolean | undefined;
		const one = openExpectedFile(
			first.path,
			async () => first.expected,
			() => new DatabaseSync(first.path),
			closing([]),
		);
		const two = openExpectedFile(
			second.path,
			async () => second.expected,
			() => {
				firstSettledBySecondOpen = firstSettled;
				return new DatabaseSync(second.path);
			},
			closing([]),
		);
		void one.then(() => {
			firstSettled = true;
		});
		for (const result of await Promise.all([one, two])) if ("opened" in result) holders.push(result.opened);
		expect(firstSettledBySecondOpen).toBe(true);
	});

	// The listing before the open succeeded, so the descriptor proof was available; a failed listing after it (EMFILE
	// after SQLite reused a parked descriptor and needed no new one) must not fall back to the name check alone.
	it("answers busy, never opened, when the descriptor listing after the open fails", async () => {
		const { path, expected } = await seeded();
		listings.outcomes = [undefined, "EMFILE"];
		const closed: DatabaseSync[] = [];
		const result = await openExpectedFile(
			path,
			async () => expected,
			() => new DatabaseSync(path),
			closing(closed),
		);
		expect(result).not.toHaveProperty("opened");
		expect(result).toHaveProperty("busy");
		expect(closed).toHaveLength(1);
	});

	it("keeps serving checked opens after one of them throws", async () => {
		const { path, expected } = await seeded();
		const failing = openExpectedFile(
			path,
			async () => expected,
			(): DatabaseSync => {
				throw new Error("open failed");
			},
			closing([]),
		);
		const next = openExpectedFile(
			path,
			async () => expected,
			() => new DatabaseSync(path),
			closing([]),
		);
		await expect(failing).rejects.toThrow("open failed");
		const result = await next;
		expect(result).toHaveProperty("opened");
		if ("opened" in result) holders.push(result.opened);
	});
});
