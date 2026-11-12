import { execFile } from "node:child_process";
import { constants, renameSync, writeFileSync } from "node:fs";
import { lstat, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireOwnershipSafeLock } from "../../../src/modes/rpc/ownership-safe-lock.ts";
import { ensureSocketSecret } from "../../../src/modes/rpc/socket-transport.ts";
import type { FileIdentity } from "../../../src/modes/rpc/sqlite-file-identity.ts";

const hooks = vi.hoisted(() => ({
	// Sees every handle `node:fs/promises` opens; may hold the open (and so its caller) until it resolves.
	opened: undefined as ((path: string, handle: import("node:fs/promises").FileHandle) => Promise<void>) | undefined,
	// Sees every `node:fs/promises` stat once it succeeded.
	statted: undefined as ((path: string) => void) | undefined,
	// Runs before SQLite's open of a path; the returned function runs after it.
	sqliteOpen: undefined as ((path: string) => (() => void) | undefined) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			await hooks.opened?.(String(args[0]), handle);
			return handle;
		},
		stat: (async (...args: Parameters<typeof actual.stat>) => {
			const result = await actual.stat(...args);
			hooks.statted?.(String(args[0]));
			return result;
		}) as typeof actual.stat,
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

const PROBE = `const { DatabaseSync } = require("node:sqlite");
const database = new DatabaseSync(process.argv[1]);
try { database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;"); database.exec("ROLLBACK;"); console.log("acquired"); }
catch { console.log("busy"); }
finally { database.close(); }`;

/** Another process's attempt to take the SQLite lock on `lockPath` at once: "acquired" or "busy". */
async function childLockAttempt(lockPath: string): Promise<string> {
	const { stdout } = await promisify(execFile)(process.execPath, ["--no-warnings", "-e", PROBE, lockPath]);
	return stdout.trim();
}

/** f47f5c7b93's validation of the lock file: an fs open, fstat and close of it. */
async function validateThroughDescriptor(lockPath: string): Promise<FileIdentity> {
	const handle = await open(lockPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const info = await handle.stat({ bigint: true });
		return { dev: info.dev, ino: info.ino };
	} finally {
		await handle.close();
	}
}

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 and senpi#6478 (review of
// senpi#6482). Security contract: closing any descriptor of a file drops all of this process's POSIX locks on it, so
// while a repair in this process holds the publish lock, nothing else in this process opens or closes a descriptor of
// the lock file: another process can never take the lock inside the holder's critical section, and the holder's
// release succeeds. In-process contenders wait for the holder in arrival order, each refused within its own deadline.
describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")("in-process publish-lock queue", () => {
	const roots: string[] = [];

	afterEach(async () => {
		hooks.opened = undefined;
		hooks.statted = undefined;
		hooks.sqliteOpen = undefined;
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	async function seeded(): Promise<{ root: string; secretPath: string; lockPath: string }> {
		const root = await realpath(await mkdtemp(join(tmpdir(), "rpc4199-lock-queue-")));
		roots.push(root);
		const secretPath = join(root, "rpc.sock.secret");
		await writeFile(secretPath, Buffer.alloc(8, 3), { mode: 0o600 });
		return { root, secretPath, lockPath: `${secretPath}.publish.lock` };
	}

	/** Holds the next repair of `secretPath` inside its critical section: its read of the secret under the lock waits. */
	function holdNextRepairInside(secretPath: string): { entered: Promise<void>; leave: () => void } {
		let leave: () => void = () => undefined;
		const left = new Promise<void>((resolve) => {
			leave = resolve;
		});
		let opens = 0;
		const entered = new Promise<void>((resolve) => {
			hooks.opened = async (path) => {
				if (path !== secretPath) return;
				opens += 1;
				// The first read is the unlocked hint; the second runs under the lock.
				if (opens !== 2) return;
				hooks.opened = undefined;
				resolve();
				await left;
			};
		});
		return { entered, leave };
	}

	it("#6478: another process cannot take the lock while an in-process repair holds it and an in-process contender validates the lock file on every attempt", async () => {
		const { secretPath, lockPath } = await seeded();
		const inside = holdNextRepairInside(secretPath);
		const repair = ensureSocketSecret(secretPath);
		let probe: string;
		let validatedWhileHeld = 0;
		try {
			await inside.entered;
			const contender = await acquireOwnershipSafeLock(lockPath, {
				validateFile: () => {
					validatedWhileHeld += 1;
					return validateThroughDescriptor(lockPath);
				},
				retries: { retries: 5, minTimeout: 1, maxTimeout: 10 },
			}).then(
				() => "acquired",
				(error: unknown) => error,
			);
			expect(contender).toBeInstanceOf(Error);
			probe = await childLockAttempt(lockPath);
		} finally {
			inside.leave();
		}
		const repaired = await repair.then(
			(secret) => secret,
			(error: unknown) => error,
		);
		expect(probe).toBe("busy");
		expect(validatedWhileHeld).toBe(0);
		expect(repaired).toHaveLength(32);
		expect(await readFile(secretPath)).toEqual(repaired);
	});

	it("#6478 at f47f5c7b93's shape: an in-process ensureSocketSecret contending with the holder never drops its lock", async () => {
		const { secretPath, lockPath } = await seeded();
		const inside = holdNextRepairInside(secretPath);
		const repair = ensureSocketSecret(secretPath);
		let probe: string;
		let contender: Promise<Buffer> | undefined;
		try {
			await inside.entered;
			// The contender reaches the lock: its validation of the lock file is over (f47f5c7b93: an fs open and close,
			// before the lock), or it checks the lock path for a legacy directory (here: before it queues).
			const reached = new Promise<void>((resolve) => {
				hooks.opened = async (path, handle) => {
					if (path !== lockPath) return;
					const close = handle.close.bind(handle);
					handle.close = async () => {
						await close();
						resolve();
					};
				};
				hooks.statted = (path) => {
					if (path === lockPath) resolve();
				};
			});
			contender = ensureSocketSecret(secretPath);
			await reached;
			probe = await childLockAttempt(lockPath);
		} finally {
			inside.leave();
		}
		const [repaired, contended] = await Promise.all(
			[repair, contender].map((pending) =>
				pending?.then(
					(secret) => secret,
					(error: unknown) => error,
				),
			),
		);
		expect(probe).toBe("busy");
		expect(repaired).toHaveLength(32);
		expect(contended).toEqual(repaired);
		expect(await readFile(secretPath)).toEqual(repaired);
	});

	async function lockFile(): Promise<{ root: string; lockPath: string; validateFile: () => Promise<FileIdentity> }> {
		const { root, lockPath } = await seeded();
		await writeFile(lockPath, "", { mode: 0o600 });
		const info = await lstat(lockPath, { bigint: true });
		const identity: FileIdentity = { dev: info.dev, ino: info.ino };
		return { root, lockPath, validateFile: async () => identity };
	}

	it("serves in-process contenders in arrival order and validates none of them while the lock is held", async () => {
		const { lockPath, validateFile } = await lockFile();
		// Long waits between attempts: a contender that polls instead of queueing loses its turn to the latecomer.
		const retries = { retries: 100, minTimeout: 1_000, maxTimeout: 1_000 };
		let held = true;
		let validatedWhileHeld = 0;
		const counting = async (): Promise<FileIdentity> => {
			if (held) validatedWhileHeld += 1;
			return validateFile();
		};
		const order: string[] = [];
		const contend = (name: string): Promise<void> =>
			acquireOwnershipSafeLock(lockPath, { validateFile: counting, retries }).then(async (release) => {
				order.push(name);
				await release();
			});
		const releaseHolder = await acquireOwnershipSafeLock(lockPath, { validateFile, retries });
		const contenders: Promise<void>[] = [];
		for (const name of ["first", "second", "third"]) {
			const arrived = new Promise<void>((resolve) => {
				hooks.statted = (path) => {
					if (path === lockPath) resolve();
				};
			});
			contenders.push(contend(name));
			await arrived;
		}
		hooks.statted = undefined;
		// Another process is refused meanwhile; the queued contenders wait without an attempt of their own.
		expect(await childLockAttempt(lockPath)).toBe("busy");
		held = false;
		await releaseHolder();
		contenders.push(contend("latecomer"));
		await Promise.all(contenders);
		expect(validatedWhileHeld).toBe(0);
		expect(order).toEqual(["first", "second", "third", "latecomer"]);
	});

	/** Swaps `lockPath` for an impostor around every SQLite open of it, and back once SQLite holds the impostor. */
	function persistentSwapper(root: string, lockPath: string): void {
		hooks.sqliteOpen = (path) => {
			if (path !== lockPath) return undefined;
			writeFileSync(join(root, "impostor.lock"), "", { mode: 0o600 });
			renameSync(lockPath, join(root, "parked.lock"));
			renameSync(join(root, "impostor.lock"), lockPath);
			return () => {
				renameSync(lockPath, join(root, "impostor.lock"));
				renameSync(join(root, "parked.lock"), lockPath);
			};
		};
	}

	// Deciding question of the senpi#6482 review: validation runs again on every attempt, and a persistent swapper makes
	// every attempt busy (a connection of this process has the file open). The queue still serves one contender at a time,
	// and each is refused within its own deadline, whether it was attempting or still waiting for its turn.
	it("refuses every in-process contender within its own deadline under a persistent swapper", async () => {
		const { root, lockPath, validateFile } = await lockFile();
		const holder = new DatabaseSync(lockPath);
		try {
			persistentSwapper(root, lockPath);
			const deadlineMs = 200;
			const retries = { retries: 10, minTimeout: 1, maxTimeout: 20 };
			const started = Date.now();
			const outcomes = await Promise.all(
				[1, 2, 3].map(() =>
					acquireOwnershipSafeLock(lockPath, { validateFile, retries }).then(
						() => "acquired",
						(error: unknown) => ({ error, elapsed: Date.now() - started }),
					),
				),
			);
			for (const outcome of outcomes) {
				expect(outcome).not.toBe("acquired");
				if (typeof outcome === "string") continue;
				expect(outcome.error).toBeInstanceOf(Error);
				// One attempt may start just before the deadline: its busy wait and checked open bound the overshoot.
				expect(outcome.elapsed).toBeLessThan(deadlineMs + 1_000);
			}
		} finally {
			hooks.sqliteOpen = undefined;
			holder.close();
		}
	});
});
