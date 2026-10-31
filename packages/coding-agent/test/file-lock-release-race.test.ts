import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileLockLostError, lockWithLossHandling } from "../src/core/file-lock.ts";

// Ported from the deterministic repro by @ayalcoh in oh-my-openagent#10878. It drives proper-lockfile's
// REAL lock/updateLock/unlock code and controls only its fs and timer boundary, so the release race
// has a fixed event order. The dependency is loaded from a pristine copy of the installed source: an
// install patched with the upstream guard (`if(lock.released)return;` at the top of the heartbeat
// `stat` callback) is stripped back first, so the RED case never depends on how the tree was installed.

type Callback = (error: NodeJS.ErrnoException | null, value?: unknown) => void;
type StatCallback = (error: NodeJS.ErrnoException | null, stat?: { mtime: Date }) => void;
type RawRelease = (callback: (error?: Error) => void) => void;
interface PristineLockfile {
	lock(
		file: string,
		options: lockfile.LockOptions,
		callback: (error: Error | null, release?: RawRelease) => void,
	): void;
}

const libraryPath = createRequire(import.meta.url).resolve("proper-lockfile/lib/lockfile.js");
const releasedGuard =
	/(\.fs\.stat\(\w+\.lockfilePath,\s*\(\w+,\s*\w+\)\s*=>\s*\{)\s*if\s*\(\s*\w+\.released\s*\)\s*(?:\{\s*return;?\s*\}|return;?)/;
const pristineSource = readFileSync(libraryPath, "utf8").replace(releasedGuard, "$1");

function loadPristineLockfile(): PristineLockfile {
	const module = { exports: {} };
	const factory = new Function("require", "module", "exports", pristineSource);
	factory(createRequire(libraryPath), module, module.exports);
	return module.exports as PristineLockfile;
}

const pristine = loadPristineLockfile();
const lockMtime = new Date(1_000);
const enoent = () =>
	Object.assign(new Error("ENOENT: no such file or directory, stat 'mcp-cache.json.lock'"), { code: "ENOENT" });

function controlledFs() {
	let probed = false;
	let heartbeat: StatCallback | undefined;
	let touches = 0;
	const fs = {
		mkdir: (_path: string, callback: Callback) => callback(null),
		rmdir: (_path: string, callback: Callback) => callback(null),
		utimes: (_path: string, _atime: Date, _mtime: Date, callback: Callback) => {
			touches++;
			callback(null);
		},
		stat: (_path: string, callback: StatCallback) => {
			if (!probed) {
				probed = true;
				callback(null, { mtime: lockMtime });
				return;
			}
			heartbeat = callback;
		},
	};
	return {
		fs,
		touches: () => touches,
		heartbeatPending: () => heartbeat !== undefined,
		finishHeartbeat: (error: NodeJS.ErrnoException | null, stat?: { mtime: Date }) => {
			const callback = heartbeat;
			heartbeat = undefined;
			callback?.(error, stat);
		},
	};
}

function lockViaPristine(file: string, options: lockfile.LockOptions = {}): Promise<() => Promise<void>> {
	return new Promise((resolve, reject) => {
		pristine.lock(file, options, (error, release) => {
			if (error || !release) return reject(error);
			resolve(
				() =>
					new Promise<void>((done, fail) =>
						release((releaseError) => (releaseError ? fail(releaseError) : done())),
					),
			);
		});
	});
}

// The pre-fix options of writeMcpCachedServer (the observed crash site): no onCompromised.
const catalogCacheOptions = (file: string) => ({
	lockfilePath: `${file}.lock`,
	realpath: false,
	retries: { retries: 50, factor: 1.2, minTimeout: 20, maxTimeout: 200 },
	stale: 30_000,
});

describe("proper-lockfile heartbeat/release race", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(lockfile, "lock").mockImplementation((file, options) => lockViaPristine(file, options));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("loads the pristine 4.1.2 heartbeat, whose stat callback has no released check", () => {
		expect(pristineSource).toMatch(
			/options\.fs\.stat\(lock\.lockfilePath, \(err, stat\) => \{\s*const isOverThreshold/,
		);
	});

	it("RED: the default onCompromised throws a late ENOENT out of the heartbeat after an unlock", async () => {
		const io = controlledFs();
		const release = await lockViaPristine("/isolated/red/cache", {
			...catalogCacheOptions("/isolated/red/cache"),
			fs: io.fs,
		});
		vi.advanceTimersByTime(15_000);
		expect(io.heartbeatPending()).toBe(true);
		await release();
		expect(() => io.finishHeartbeat(enoent())).toThrow(/ENOENT/);
	});

	it.each([
		["a late ENOENT", () => [enoent()] as const],
		["a late changed mtime", () => [null, { mtime: new Date(2_000) }] as const],
		["a late matching mtime", () => [null, { mtime: lockMtime }] as const],
	])("GREEN: %s after release neither throws nor touches the lock", async (_name, outcome) => {
		const io = controlledFs();
		const file = "/isolated/green/cache";
		const lock = await lockWithLossHandling(file, { ...catalogCacheOptions(file), fs: io.fs });
		vi.advanceTimersByTime(15_000);
		expect(io.heartbeatPending()).toBe(true);
		await lock.release();
		const touchesAtRelease = io.touches();
		const [error, stat] = outcome();
		expect(() => io.finishHeartbeat(error, stat)).not.toThrow();
		expect(lock.lost()).toBe(false);
		if (error === null && stat?.mtime === lockMtime) {
			// The dependency still refreshes the directory here (the upstream bug); the callback ignores the result.
			expect(io.touches()).toBe(touchesAtRelease + 1);
		} else {
			expect(io.touches()).toBe(touchesAtRelease);
		}
	});

	it("GREEN: a held lock whose directory vanishes is marked lost without crashing, and only the commit step fails", async () => {
		const io = controlledFs();
		const file = "/isolated/owned/cache";
		const onLost = vi.fn();
		const lock = await lockWithLossHandling(file, { ...catalogCacheOptions(file), fs: io.fs, onLost });
		lock.assertHeld();
		vi.advanceTimersByTime(15_000);
		expect(() => io.finishHeartbeat(enoent())).not.toThrow();
		expect(lock.lost()).toBe(true);
		expect(onLost).toHaveBeenCalledTimes(1);
		let thrown: unknown;
		try {
			lock.assertHeld();
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(FileLockLostError);
		expect(thrown).toMatchObject({ code: "ELOCKLOST", path: file, cause: { code: "ECOMPROMISED" } });
		await expect(lock.release()).resolves.toBeUndefined();
	});
});
