import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openReservationDatabase } from "../../../src/modes/rpc/endpoint-reservation-file.ts";
import { ensureSocketSecret } from "../../../src/modes/rpc/socket-transport.ts";

const opens = vi.hoisted(() => ({
	// Every path `node:fs/promises` opened a descriptor of, in order.
	paths: [] as string[],
	// Runs on every open attempt of a path, whether or not it opens a descriptor.
	onOpen: undefined as ((path: string) => void) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			opens.onOpen?.(String(args[0]));
			const handle = await actual.open(...args);
			opens.paths.push(String(args[0]));
			return handle;
		},
	};
});

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 and senpi#6478 (review of
// senpi#6482). Security contract: closing any descriptor of a file drops all of this process's POSIX locks on it, so the
// validation of an existing lock or store file opens no descriptor of it (it is checked by lstat, and the descriptor
// proof checks SQLite opened that file). A validation never blocks on the file, and a refusal of a file that is not a
// regular one is final at once, whatever the path says.
describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
	"validation without a descriptor",
	() => {
		const roots: string[] = [];
		const fifos: string[] = [];

		afterEach(async () => {
			opens.paths = [];
			opens.onOpen = undefined;
			// A reader blocked on a FIFO (the unfixed validation) is released by a writer's open.
			for (const fifo of fifos.splice(0)) {
				await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK).then(
					(handle) => handle.close(),
					() => undefined,
				);
			}
			for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
		});

		async function seeded(directory = ""): Promise<{ root: string; secretPath: string; lockPath: string }> {
			const root = await realpath(await mkdtemp(join(tmpdir(), "rpc4199-no-descriptor-")));
			roots.push(root);
			await mkdir(join(root, directory), { recursive: true });
			const secretPath = join(root, directory, "rpc.sock.secret");
			await writeFile(secretPath, Buffer.alloc(8, 3), { mode: 0o600 });
			return { root, secretPath, lockPath: `${secretPath}.publish.lock` };
		}

		it("#6478: repairs a secret without opening a descriptor of the existing publish lock file", async () => {
			const { secretPath, lockPath } = await seeded();
			await writeFile(lockPath, "", { mode: 0o600 });
			expect(await ensureSocketSecret(secretPath)).toHaveLength(32);
			expect(opens.paths.filter((path) => path === lockPath)).toEqual([]);
		});

		it("#6478: opens an existing reservation store without opening a descriptor of it", async () => {
			const { root } = await seeded();
			const storePath = join(root, "reservations.db");
			(await openReservationDatabase(storePath)).close();
			opens.paths = [];
			(await openReservationDatabase(storePath)).close();
			expect(opens.paths.filter((path) => path === storePath)).toEqual([]);
		});

		it("refuses a FIFO at the lock path at once, and an unrelated store open is not held up by it", async () => {
			const { root, secretPath, lockPath } = await seeded();
			await promisify(execFile)("mkfifo", ["-m", "600", lockPath]);
			fifos.push(lockPath);
			const repair = ensureSocketSecret(secretPath);
			const store = openReservationDatabase(join(root, "reservations.db"));
			await expect(repair).rejects.toThrow(/not a regular file/);
			(await store).close();
		}, 5_000);

		it("refuses a lock path that is not a regular file at once, even when the path says busy", async () => {
			const { root, secretPath, lockPath } = await seeded("busy-locked");
			await writeFile(join(root, "target"), "", { mode: 0o600 });
			await symlink(join(root, "target"), lockPath);
			let attempts = 0;
			const retried = new Promise<"retried">((resolve) => {
				opens.onOpen = (path) => {
					if (path !== lockPath) return;
					attempts += 1;
					if (attempts === 2) resolve("retried");
				};
			});
			const outcome = await Promise.race([
				ensureSocketSecret(secretPath).then(
					() => "repaired" as const,
					(error: unknown) => error,
				),
				retried,
			]);
			expect(outcome).toBeInstanceOf(Error);
			expect((outcome as Error).message).toMatch(/not a regular file/);
		});
	},
);
