import { closeSync, linkSync, openSync, renameSync, unlinkSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { retryWhenBusy } from "../../../src/modes/rpc/endpoint-reservation-busy.ts";
import { openReservationDatabase } from "../../../src/modes/rpc/endpoint-reservation-file.ts";
import { ensureSocketSecret } from "../../../src/modes/rpc/socket-transport.ts";

const DESCRIPTOR_DIRECTORY = process.platform === "darwin" ? "/dev/fd" : "/proc/self/fd";

const hooks = vi.hoisted(() => ({
	// Runs once, inside the next descriptor listing, after its names were read.
	listing: undefined as (() => Promise<void>) | undefined,
	// Sees every handle `node:fs/promises` opens.
	opened: undefined as ((path: string, handle: FileHandle) => void) | undefined,
	// Sees every call into the checked-open queue.
	checkedOpen: undefined as ((path: string) => void) | undefined,
	// Runs before SQLite's open of a path; the returned function runs after it.
	sqliteOpen: undefined as ((path: string) => (() => void) | undefined) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			hooks.opened?.(String(args[0]), handle);
			return handle;
		},
		readdir: (async (...args: Parameters<typeof actual.readdir>) => {
			const names = await actual.readdir(...args);
			const hook = hooks.listing;
			if (hook && String(args[0]) === DESCRIPTOR_DIRECTORY) {
				hooks.listing = undefined;
				await hook();
			}
			return names;
		}) as typeof actual.readdir,
	};
});

vi.mock("node:sqlite", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:sqlite")>();
	class HookedDatabaseSync extends actual.DatabaseSync {
		constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
			const after = hooks.sqliteOpen?.(String(args[0]));
			try {
				super(...args);
			} finally {
				after?.();
			}
		}
	}
	return { ...actual, DatabaseSync: HookedDatabaseSync };
});

vi.mock("../../../src/modes/rpc/sqlite-file-identity.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/modes/rpc/sqlite-file-identity.ts")>();
	return {
		...actual,
		openExpectedFile: ((...args: Parameters<typeof actual.openExpectedFile>) => {
			hooks.checkedOpen?.(String(args[0]));
			return actual.openExpectedFile(...args);
		}) as typeof actual.openExpectedFile,
	};
});

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (design 4.2a, review of
// senpi#6440). Security contract: a caller's own no-follow validation open of a checked file runs inside the same
// one-at-a-time section as SQLite's open, so it can never land in another checked open's descriptor listing window and
// pass for SQLite's descriptor there.
describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")("serialized validation opens", () => {
	const roots: string[] = [];

	afterEach(async () => {
		hooks.listing = undefined;
		hooks.opened = undefined;
		hooks.checkedOpen = undefined;
		hooks.sqliteOpen = undefined;
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	async function scratch(): Promise<string> {
		const root = await realpath(await mkdtemp(join(tmpdir(), "rpc4199-validate-serial-")));
		roots.push(root);
		return root;
	}

	/** Resolves when a call reaches `path`'s validation open, or the checked-open queue, whichever comes first. */
	function validationOrQueue(path: string, onValidation: (handle: FileHandle) => void): Promise<void> {
		return new Promise((resolve) => {
			hooks.opened = (opened, handle) => {
				if (opened !== path) return;
				hooks.opened = undefined;
				onValidation(handle);
				resolve();
			};
			hooks.checkedOpen = (queued) => {
				if (queued === path) resolve();
			};
		});
	}

	// The reviewer's reproduction: this process holds a SQLite lock on another file X with a parked descriptor of it,
	// a concurrent ensureSocketSecret holds its validation handle of the real lock file across the repair's listings,
	// and X is linked over the lock path only for SQLite's open. SQLite then reuses the parked descriptor of X (adding
	// none) while the only added descriptor is the concurrent validation handle of the real file.
	it("refuses a swap while a concurrent ensureSocketSecret holds its validation handle across the listings", async () => {
		const root = await scratch();
		const secretPath = join(root, "rpc.sock.secret");
		const lockPath = `${secretPath}.publish.lock`;
		await writeFile(secretPath, Buffer.alloc(8, 3), { mode: 0o600 });
		const heldPath = join(root, "held.db");
		const holder = new DatabaseSync(heldPath);
		holder.exec("BEGIN EXCLUSIVE;");
		// Closed while the holder's lock is held, so SQLite parks this connection's descriptor of X.
		new DatabaseSync(heldPath).close();
		let releaseValidation: () => void = () => undefined;
		const validationGate = new Promise<void>((resolve) => {
			releaseValidation = resolve;
		});
		let placeholder: number | undefined;
		let concurrent: Promise<Buffer> | undefined;
		hooks.listing = async () => {
			// Takes the descriptor number the listing just closed, so the concurrent handle below gets one it never named.
			placeholder = openSync(join(root, "placeholder"), "w");
			const reached = validationOrQueue(lockPath, (handle) => {
				const close = handle.close.bind(handle);
				handle.close = async () => {
					await validationGate;
					await close();
				};
			});
			concurrent = ensureSocketSecret(secretPath);
			await reached;
		};
		hooks.sqliteOpen = (path) => {
			if (path !== lockPath) return undefined;
			hooks.sqliteOpen = undefined;
			const aside = join(root, "aside.lock");
			renameSync(lockPath, aside);
			linkSync(heldPath, lockPath);
			return () => {
				unlinkSync(lockPath);
				renameSync(aside, lockPath);
			};
		};
		try {
			await expect(ensureSocketSecret(secretPath)).rejects.toMatchObject({ code: "ELOCK_FILE_REPLACED" });
		} finally {
			releaseValidation();
			// Settled before the scratch directory goes; its outcome is asserted below.
			await concurrent?.then(
				() => undefined,
				() => undefined,
			);
			holder.exec("COMMIT;");
			holder.close();
			if (placeholder !== undefined) closeSync(placeholder);
		}
		const repaired = await concurrent;
		expect(repaired).toHaveLength(32);
		expect(await readFile(secretPath)).toEqual(repaired);
	});

	it("runs the reservation store's validation open only after a checked open in progress settles", async () => {
		const root = await scratch();
		const secretPath = join(root, "rpc.sock.secret");
		const lockPath = `${secretPath}.publish.lock`;
		const storePath = join(root, "reservations.db");
		await writeFile(secretPath, Buffer.alloc(8, 3), { mode: 0o600 });
		const order: string[] = [];
		hooks.sqliteOpen = (path) => {
			if (path === lockPath && !order.includes("lock opened by SQLite")) order.push("lock opened by SQLite");
			return undefined;
		};
		let store: ReturnType<typeof openReservationDatabase> | undefined;
		hooks.listing = async () => {
			const reached = validationOrQueue(storePath, () => order.push("store validation open"));
			// The repair keeps opening its own files while the store opens, which may answer store_busy; callers retry it.
			store = retryWhenBusy(() => openReservationDatabase(storePath));
			await reached;
		};
		expect(await ensureSocketSecret(secretPath)).toHaveLength(32);
		const database = await store;
		database?.close();
		expect(order).toEqual(["lock opened by SQLite", "store validation open"]);
	});
});
