import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openEndpointReservationStore } from "../../../src/modes/rpc/endpoint-reservation-store.ts";

// Runs `before` and `after` around SQLite's own open of `path` (node:sqlite under vitest).
const sqliteOpen = vi.hoisted(() => ({
	around: undefined as { path: string; before: () => void; after: () => void } | undefined,
}));

vi.mock("node:sqlite", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:sqlite")>();
	class DatabaseSync extends actual.DatabaseSync {
		constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
			const hook = sqliteOpen.around?.path === String(args[0]) ? sqliteOpen.around : undefined;
			if (hook) sqliteOpen.around = undefined;
			hook?.before();
			super(...args);
			hook?.after();
		}
	}
	return { ...actual, DatabaseSync };
});

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (design 4.2a "Reservation through
// startup"). Security contract: the store validates its file through a no-follow descriptor, then SQLite reopens it by
// name; the file SQLite opened must be the validated one, checked on SQLite's own descriptor where the platform lists
// them, and the rollback journal SQLite would read or write beside it must be absent or a private regular file.
describe("endpoint reservation store file", () => {
	const roots: string[] = [];

	afterEach(async () => {
		sqliteOpen.around = undefined;
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	async function scratch(): Promise<{ root: string; path: string }> {
		const root = await mkdtemp(join(tmpdir(), "rpc4199-store-file-"));
		roots.push(root);
		return { root, path: join(root, "endpoint.reservation.db") };
	}

	function swapWhileOpening(root: string, path: string, undo: boolean): void {
		const parked = join(root, "parked.db");
		const impostor = join(root, "impostor.db");
		sqliteOpen.around = {
			path,
			before: () => {
				writeFileSync(impostor, "", { mode: 0o600 });
				renameSync(path, parked);
				renameSync(impostor, path);
			},
			after: () => {
				if (!undo) return;
				renameSync(path, impostor);
				renameSync(parked, path);
			},
		};
	}

	it("refuses a store whose file is swapped for another while SQLite opens it", async () => {
		const { root, path } = await scratch();
		swapWhileOpening(root, path, false);
		await expect(openEndpointReservationStore(path)).rejects.toMatchObject({ reason: "store_insecure" });
	});

	// Only a check on SQLite's own descriptor catches a swap undone once SQLite holds the other file.
	it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
		"refuses a store whose file is swapped only while SQLite opens it",
		async () => {
			const { root, path } = await scratch();
			swapWhileOpening(root, path, true);
			await expect(openEndpointReservationStore(path)).rejects.toMatchObject({ reason: "store_insecure" });
			expect(await readFile(path)).toHaveLength(0);
		},
	);

	it.skipIf(process.platform === "win32")("refuses a rollback journal path that is a symlink", async () => {
		const { root, path } = await scratch();
		await writeFile(join(root, "victim"), "keep", { mode: 0o600 });
		await symlink(join(root, "victim"), `${path}-journal`);
		await expect(openEndpointReservationStore(path)).rejects.toMatchObject({ reason: "store_insecure" });
		expect(await readFile(join(root, "victim"), "utf8")).toBe("keep");
	});

	it.skipIf(process.platform === "win32")("refuses a rollback journal open to other users", async () => {
		const { path } = await scratch();
		await writeFile(`${path}-journal`, "");
		await chmod(`${path}-journal`, 0o660);
		await expect(openEndpointReservationStore(path)).rejects.toMatchObject({ reason: "store_insecure" });
	});

	it.skipIf(process.platform === "win32")("accepts a leftover owner-only rollback journal", async () => {
		const { path } = await scratch();
		writeFileSync(`${path}-journal`, "");
		chmodSync(`${path}-journal`, 0o600);
		const store = await openEndpointReservationStore(path);
		store.close();
	});
});
