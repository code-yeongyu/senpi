// #3796: storage and observer contracts shared by native and legacy engines.
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	addGrant,
	declarationDigest,
	type GrantObservation,
	GrantsLockLostError,
	list,
	observe,
	read,
	resolveGrantsStorePath,
	revoke,
} from "../../../src/core/extensions/builtin/mcp/env-grants-store.ts";

// node:fs exports are not spy-able in ESM; route watch through a pass-through mock instead.
const mocks = vi.hoisted(() => ({
	fsWatch: vi.fn(),
	rename: vi.fn(),
	delay: vi.fn(),
	realWatch: undefined as unknown as typeof fs.watch,
	realRename: undefined as unknown as typeof import("node:fs/promises").rename,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	mocks.realRename = actual.rename;
	mocks.rename.mockImplementation(actual.rename);
	return { ...actual, rename: mocks.rename };
});
vi.mock("node:timers/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:timers/promises")>();
	return { ...actual, setTimeout: mocks.delay };
});
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	mocks.realWatch = actual.watch;
	mocks.fsWatch.mockImplementation(actual.watch);
	return { ...actual, watch: mocks.fsWatch };
});

let root: string;
let stop: (() => void) | undefined;
const label = { project: "/synthetic/project", skill: "carrier", server: "probe" };
const identity = declarationDigest({ command: "synthetic-probe" });
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
if (platformDescriptor === undefined) throw new Error("process.platform has no property descriptor");
const platform: PropertyDescriptor = platformDescriptor;

beforeEach(() => {
	mocks.rename.mockReset().mockImplementation(mocks.realRename);
	mocks.delay.mockReset().mockResolvedValue(undefined);
	root = fs.mkdtempSync(join(tmpdir(), "senpi-3796-store-"));
});
afterEach(() => {
	Object.defineProperty(process, "platform", platform);
	stop?.();
	stop = undefined;
	vi.restoreAllMocks();
	mocks.fsWatch.mockImplementation(mocks.realWatch);
	vi.useRealTimers();
	fs.rmSync(root, { recursive: true, force: true });
});

function observationStream() {
	const events: GrantObservation[] = [];
	const waiters = new Set<{
		predicate: (event: GrantObservation) => boolean;
		resolve: (event: GrantObservation) => void;
	}>();
	return {
		events,
		listener(event: GrantObservation) {
			events.push(event);
			for (const waiter of waiters)
				if (waiter.predicate(event)) {
					waiters.delete(waiter);
					waiter.resolve(event);
				}
		},
		next(predicate: (event: GrantObservation) => boolean): Promise<GrantObservation> {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					waiters.delete(waiter);
					reject(new Error("Expected grant observation did not arrive"));
				}, 10_000);
				const waiter = {
					predicate,
					resolve: (event: GrantObservation) => {
						clearTimeout(timer);
						resolve(event);
					},
				};
				waiters.add(waiter);
			});
		},
	};
}

it("resolves under the caller's configured engine directory", () => {
	expect(resolveGrantsStorePath(root)).toBe(join(root, "mcp-env-grants.json"));
});

it("merges concurrent atomic writers and revokes only the selected identity", async () => {
	const path = resolveGrantsStorePath(root);
	const second = declarationDigest({ command: "synthetic-second" });
	await Promise.all([addGrant(path, identity, label, ["ODD_DSN"]), addGrant(path, second, label, ["ODD_COOKIE"])]);
	const snapshot = await read(path);
	expect(snapshot.generation).toBe(2);
	expect(snapshot.grants[identity]?.names).toEqual(["ODD_DSN"]);
	expect(snapshot.grants[second]?.names).toEqual(["ODD_COOKIE"]);
	await revoke(path, identity);
	expect((await read(path)).generation).toBe(3);
	expect((await list(path)).map((grant) => grant.digest)).toEqual([second]);
	const disk: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
	expect(disk).toEqual({ version: 1, generation: 3, grants: { [second]: { label, names: ["ODD_COOKIE"] } } });
	expect(fs.readdirSync(root)).toEqual(["mcp-env-grants.json"]);
});

it("keeps valid non-identifier environment names and rejects names with = or NUL", async () => {
	const path = resolveGrantsStorePath(root);
	await addGrant(path, identity, label, ["ProgramFiles(x86)", "odd-name"]);
	expect((await read(path)).grants[identity]?.names).toEqual(["ProgramFiles(x86)", "odd-name"]);
	await expect(addGrant(path, identity, label, ["A=B"])).rejects.toThrow();
	await expect(addGrant(path, identity, label, ["A\0B"])).rejects.toThrow();
	expect((await read(path)).generation).toBe(1);
});

it("fails closed and leaves no grant or temporary lock after a failed rename", async () => {
	const path = resolveGrantsStorePath(root);
	fs.mkdirSync(path);
	await expect(addGrant(path, identity, label, ["ODD_DSN"])).rejects.toThrow();
	expect((await read(path)).grants).toEqual({});
	expect(fs.readdirSync(root)).toEqual(["mcp-env-grants.json"]);
});

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
	it(`retries a Windows ${code} replace without repeating the grant mutation`, async () => {
		const path = resolveGrantsStorePath(root);
		await addGrant(path, identity, label, ["OLD"]);
		Object.defineProperty(process, "platform", { value: "win32" });
		const error = Object.assign(new Error("synthetic open handle"), { code });
		mocks.rename.mockClear().mockRejectedValueOnce(error).mockRejectedValueOnce(error);
		const snapshot = await addGrant(path, identity, label, ["NEW"]);
		expect(mocks.rename).toHaveBeenCalledTimes(3);
		expect(mocks.delay.mock.calls.map(([ms]) => ms)).toEqual([50, 100]);
		expect(snapshot.generation).toBe(2);
		expect((await read(path)).grants[identity]?.names).toEqual(["NEW", "OLD"]);
		expect(fs.readdirSync(root)).toEqual(["mcp-env-grants.json"]);
	});
}

// The lock is checked before EVERY replace attempt, not once before the retry loop: a loss reported during a
// Windows backoff refuses the next attempt instead of overwriting the new owner's file.
it("refuses the next Windows replace attempt once the lock is lost during a backoff", async () => {
	const path = resolveGrantsStorePath(root);
	await addGrant(path, identity, label, ["OLD"]);
	const before = fs.readFileSync(path, "utf8");
	Object.defineProperty(process, "platform", { value: "win32" });
	const realLock = lockfile.lock;
	let lose: (() => Promise<void>) | undefined;
	vi.spyOn(lockfile, "lock").mockImplementation(async (file, options) => {
		const release = await realLock(file, options);
		lose = async () => {
			await release();
			options?.onCompromised?.(Object.assign(new Error("synthetic lost lock"), { code: "ECOMPROMISED" }));
		};
		return release;
	});
	mocks.rename.mockClear().mockRejectedValueOnce(Object.assign(new Error("synthetic open handle"), { code: "EPERM" }));
	mocks.delay.mockImplementationOnce(async () => {
		await lose?.();
	});
	await expect(addGrant(path, identity, label, ["NEW"])).rejects.toBeInstanceOf(GrantsLockLostError);
	expect(mocks.rename).toHaveBeenCalledTimes(1);
	expect(fs.readFileSync(path, "utf8")).toBe(before);
	expect(fs.readdirSync(root)).toEqual(["mcp-env-grants.json"]);
});

it("bounds Windows replace retries, preserves the old store and releases the lock", async () => {
	const path = resolveGrantsStorePath(root);
	await addGrant(path, identity, label, ["OLD"]);
	Object.defineProperty(process, "platform", { value: "win32" });
	const error = Object.assign(new Error("synthetic open handle"), { code: "EPERM" });
	mocks.rename.mockClear().mockRejectedValue(error);
	await expect(addGrant(path, identity, label, ["NEW"])).rejects.toBe(error);
	expect(mocks.rename).toHaveBeenCalledTimes(6);
	expect(mocks.delay.mock.calls.map(([ms]) => ms)).toEqual([50, 100, 200, 400, 800]);
	expect((await read(path)).generation).toBe(1);
	expect((await read(path)).grants[identity]?.names).toEqual(["OLD"]);
	expect(fs.readdirSync(root)).toEqual(["mcp-env-grants.json"]);
	mocks.rename.mockImplementation(mocks.realRename);
	await addGrant(path, identity, label, ["AFTER"]);
	expect((await read(path)).generation).toBe(2);
});

for (const [os, code] of [
	["linux", "EPERM"],
	["linux", "EACCES"],
	["linux", "EBUSY"],
	["win32", "ENOENT"],
]) {
	it(`does not retry ${code} on ${os}`, async () => {
		Object.defineProperty(process, "platform", { value: os });
		const error = Object.assign(new Error("synthetic rename failure"), { code });
		mocks.rename.mockRejectedValue(error);
		await expect(addGrant(resolveGrantsStorePath(root), identity, label, ["NEW"])).rejects.toBe(error);
		expect(mocks.rename).toHaveBeenCalledTimes(1);
		expect(mocks.delay).not.toHaveBeenCalled();
		expect(fs.readdirSync(root)).toEqual([]);
	});
}

it("watches creation and atomic replacements from before the store exists", async () => {
	const path = resolveGrantsStorePath(join(root, "not-created-yet"));
	const stream = observationStream();
	stop = await observe(path, stream.listener);
	const created = stream.next((event) => event.snapshot.generation === 1);
	await addGrant(path, identity, label, ["ODD_DSN"]);
	expect((await created).snapshot.grants[identity]?.names).toEqual(["ODD_DSN"]);
	const revoked = stream.next((event) => event.snapshot.generation === 2);
	await revoke(path, identity);
	expect((await revoked).snapshot.grants[identity]).toBeUndefined();
	const latest = stream.next((event) => event.snapshot.generation >= 4);
	await addGrant(path, identity, label, ["ODD_DSN"]);
	await revoke(path, identity);
	expect((await latest).snapshot.grants[identity]).toBeUndefined();
});

it("polls latest state and conservatively invalidates skipped revoke/regrant and recreation", async () => {
	// Real watcher, deliberately no change listener: model a filesystem that
	// loses watch notifications. The production five-second fallback must work.
	mocks.fsWatch.mockImplementation((filename: fs.PathLike) => mocks.realWatch(filename, { persistent: false }));
	vi.useFakeTimers();
	const path = resolveGrantsStorePath(root);
	await addGrant(path, identity, label, ["ODD_DSN"]);
	const stream = observationStream();
	stop = await observe(path, stream.listener);
	await revoke(path, identity);
	await addGrant(path, identity, label, ["ODD_DSN"]);
	const skipped = stream.next((event) => event.snapshot.generation === 3);
	await vi.advanceTimersByTimeAsync(5_000);
	expect((await skipped).conservative).toBe(true);
	fs.rmSync(path);
	await addGrant(path, identity, label, ["ODD_DSN"]);
	const recreated = stream.next((event) => event.snapshot.generation === 1);
	await vi.advanceTimersByTimeAsync(5_000);
	expect((await recreated).conservative).toBe(true);
	expect(stream.events.at(-1)?.snapshot.grants[identity]?.names).toEqual(["ODD_DSN"]);
});
