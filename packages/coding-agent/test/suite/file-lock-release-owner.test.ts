import * as nodeFs from "node:fs";
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lockWithLossHandling } from "../../src/core/file-lock.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function target(): { file: string; lockDir: string; alias: (name: string) => string } {
	const base = mkdtempSync(join(tmpdir(), "senpi-6428-"));
	roots.push(base);
	const real = mkdtempSync(join(base, "real-"));
	const file = join(real, "record.json");
	writeFileSync(file, "{}");
	// A symlinked directory gives the same file a second canonical-free spelling, so the lock library keeps a
	// separate in-process entry for it, as a second process would (the library keys entries by path.resolve).
	const alias = (name: string): string => {
		const link = join(base, name);
		symlinkSync(real, link, "dir");
		return join(link, "record.json");
	};
	return { file, lockDir: `${file}.lock`, alias };
}

// One process stands in for three: each holder reaches the same lock directory through its own symlinked spelling,
// so the lock library keeps separate in-process entries for them, as separate processes would (senpi#6428).
describe("a lock holder that lost its lock without learning it (senpi#6428)", () => {
	it("#given a holder whose lock was taken over after going stale #when the first holder releases #then the new holder's lock survives and a third acquire is refused", async () => {
		const { file, lockDir, alias } = target();
		const stale = 2_000;
		const first = await lockWithLossHandling(file, { realpath: false, stale, update: 60_000 });
		// The first holder stalls past the stale bound (its refresh never ran): backdate the lock directory.
		const old = new Date(Date.now() - 10 * stale);
		utimesSync(lockDir, old, old);
		const second = await lockWithLossHandling(alias("second"), {
			realpath: false,
			lockfilePath: lockDir,
			stale,
			update: 60_000,
		});

		await first.release();

		expect(statSync(lockDir).isDirectory()).toBe(true);
		await expect(
			lockWithLossHandling(alias("third"), {
				realpath: false,
				lockfilePath: lockDir,
				stale,
				retries: 0,
			}),
		).rejects.toMatchObject({ code: "ELOCKED" });
		expect(first.lost()).toBe(true);
		await second.release();
		expect(() => statSync(lockDir)).toThrow();
	});

	it("#given a holder that was taken over #when its process exits without releasing #then its exit-time cleanup leaves the new holder's lock (review MEDIUM)", async () => {
		const { file, lockDir, alias } = target();
		const stale = 2_000;
		const script = `
			const { lockWithLossHandling } = await import(${JSON.stringify(new URL("../../src/core/file-lock.ts", import.meta.url).pathname)});
			await lockWithLossHandling(${JSON.stringify(file)}, { realpath: false, stale: ${stale}, update: 60_000 });
			process.stdout.write("held\\n");
			process.stdin.once("data", () => process.exit(0));
		`;
		const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
			stdio: ["pipe", "pipe", "inherit"],
		});
		await once(child.stdout, "data");
		const old = new Date(Date.now() - 10 * stale);
		utimesSync(lockDir, old, old);
		const second = await lockWithLossHandling(alias("second"), {
			realpath: false,
			lockfilePath: lockDir,
			stale,
			update: 60_000,
		});
		const exited = once(child, "exit");
		child.stdin.write("go\n");
		await exited;
		expect(statSync(lockDir).isDirectory()).toBe(true);
		await second.release();
	});

	it("#given a takeover that is between mkdir and its own token #when the stale holder releases #then the new holder's lock survives (review LOW)", async () => {
		const { file, lockDir, alias } = target();
		const stale = 2_000;
		const first = await lockWithLossHandling(file, { realpath: false, stale, update: 60_000 });
		const old = new Date(Date.now() - 10 * stale);
		utimesSync(lockDir, old, old);
		let releaseFirst: () => void = () => {};
		const firstReleasing = new Promise<void>((resolve) => {
			releaseFirst = () => void first.release().then(resolve);
		});
		// The second holder's mkdir finishes, then the stale holder releases before the second writes its token.
		const gatedFs = Object.assign(Object.create(nodeFs) as typeof nodeFs, {
			mkdir: (dir: string, callback: (error: NodeJS.ErrnoException | null) => void) =>
				nodeFs.mkdir(dir, (error) => {
					// Only the mkdir that wins the takeover is held open; the first one fails with EEXIST.
					if (error) {
						callback(error);
						return;
					}
					releaseFirst();
					void firstReleasing.then(() => callback(null));
				}),
		});
		const second = await lockWithLossHandling(alias("second"), {
			realpath: false,
			lockfilePath: lockDir,
			stale,
			update: 60_000,
			fs: gatedFs,
		} as never);
		expect(statSync(lockDir).isDirectory()).toBe(true);
		expect(first.lost()).toBe(true);
		await second.release();
	});

	it("#given the token file cannot be read for a reason other than its absence #when the owner releases #then the lock directory is still removed (review LOW)", async () => {
		const { file, lockDir } = target();
		const failingFs = Object.assign(Object.create(nodeFs) as typeof nodeFs, {
			readFile: (
				_path: string,
				_encoding: string,
				callback: (error: NodeJS.ErrnoException | null, data?: string) => void,
			) => callback(Object.assign(new Error("too many open files"), { code: "EMFILE" })),
		});
		const held = await lockWithLossHandling(file, { realpath: false, fs: failingFs } as never);
		await held.release();
		expect(existsSync(lockDir)).toBe(false);
		expect(held.lost()).toBe(false);
	});
});
