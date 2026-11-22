import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionGenerations } from "../../../src/modes/rpc/compact-session-generations.ts";

vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof fs>();
	return { ...actual, rename: vi.fn(actual.rename) };
});
const owners: SessionGenerations[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const owner of owners.splice(0)) {
		owner.close();
		await owner.idle();
	}
	vi.mocked(fs.rename).mockReset();
	for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function directory() {
	const dir = await fs.mkdtemp(join(tmpdir(), "r99-ranges-"));
	directories.push(dir);
	return dir;
}
function owner(dir: string) {
	const counter = new SessionGenerations(dir);
	owners.push(counter);
	return counter;
}
async function floorFile(dir: string) {
	const root = join(
		dir,
		(await fs.readdir(dir)).find((name) => name.startsWith(".senpi-recovery-generations-")) ?? "",
	);
	return join(root, (await fs.readdir(root)).find((name) => /^[a-f0-9]{64}$/.test(name)) ?? "");
}

// #4272 RULING-99: the range is a durable publication floor, not just an in-process monotonic counter.
it("excludes a simultaneous durable-session owner and burns unused values on restart", async () => {
	const dir = await directory();
	const first = owner(dir);
	await first.bind("session");
	const generation = first.next();
	const persisted = Number(await fs.readFile(await floorFile(dir), "utf8"));
	expect(persisted).toBeGreaterThanOrEqual(Number(generation));
	const competing = owner(dir);
	await competing.bind("session");
	expect(competing.next()).toBeUndefined();
	const independent = owner(dir);
	await independent.bind("other-session");
	expect(independent.next()).toBe(1);
	first.close();
	await first.idle();
	const restarted = owner(dir);
	await restarted.bind("session");
	expect(restarted.next()).toBe(persisted + 1);
	expect(first.next()).toBeUndefined();
});

it.each(["corrupt", "9007199254740991"])(
	"refuses an unusable persisted floor %s instead of restarting at one",
	async (text) => {
		const dir = await directory();
		const first = owner(dir);
		await first.bind("session");
		first.close();
		await first.idle();
		await fs.writeFile(await floorFile(dir), text);
		const reopened = owner(dir);
		await reopened.bind("session");
		expect(reopened.next()).toBeUndefined();
		expect(await fs.readFile(await floorFile(dir), "utf8")).toBe(text);
	},
);

it.each([false, true])("refill exhaustion refuses unpersisted values; failed refill=%s", async (fail) => {
	const dir = await directory();
	const counter = owner(dir);
	await counter.bind("session");
	const path = await floorFile(dir);
	const ceiling = Number(await fs.readFile(path, "utf8"));
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const rename = vi.mocked(fs.rename).getMockImplementation();
	if (!rename) throw new Error("missing rename implementation");
	vi.mocked(fs.rename).mockImplementation(async (from, to) => {
		if (String(to) === path) {
			entered.resolve();
			await release.promise;
			if (fail) throw new Error("injected refill failure");
		}
		await rename(from, to);
	});
	try {
		for (let generation = 1; generation <= ceiling; generation++) expect(counter.next()).toBe(generation);
		await entered.promise;
		expect(counter.next()).toBeUndefined();
		expect(Number(await fs.readFile(path, "utf8"))).toBe(ceiling);
	} finally {
		release.resolve();
	}
	await counter.idle();
	expect(counter.next()).toBe(fail ? undefined : ceiling + 1);
});

it("rebind burns the old range, releases its lock and excludes new owners until close", async () => {
	const dir = await directory();
	const counter = owner(dir);
	await counter.bind("A");
	const first = counter.next();
	await counter.bind("B");
	const second = counter.next();
	expect(Number(second)).toBeGreaterThan(Number(first));
	const old = owner(dir);
	await old.bind("A");
	expect(old.next()).toBeDefined();
	const competing = owner(dir);
	await competing.bind("B");
	expect(competing.next()).toBeUndefined();
	counter.close();
	await counter.idle();
	const reopened = owner(dir);
	await reopened.bind("B");
	expect(Number(reopened.next())).toBeGreaterThan(Number(second));
});

it("rebind exceeds an existing target's floor even when it exceeds the lane's reserved ceiling", async () => {
	const dir = await directory();
	for (let index = 0; index < 2; index++) {
		const target = owner(dir);
		await target.bind("B");
		target.close();
		await target.idle();
	}
	const lane = owner(dir);
	await lane.bind("A");
	expect(lane.next()).toBe(1);
	await lane.bind("B");
	expect(lane.next()).toBe(2049);
	await lane.bind("B");
	expect(lane.next(), "binding the same identity keeps its live reservation").toBe(2050);
});

it.each([false, true])("rebind waits for refill and refuses issuance before new fsync; failure=%s", async (fail) => {
	const dir = await directory();
	const counter = owner(dir);
	await counter.bind("A");
	const oldPath = await floorFile(dir);
	const entered = Promise.withResolvers<void>();
	const refill = Promise.withResolvers<void>();
	const replacement = Promise.withResolvers<void>();
	const reachedReplacement = Promise.withResolvers<void>();
	const rename = vi.mocked(fs.rename).getMockImplementation();
	if (!rename) throw new Error("missing rename implementation");
	vi.mocked(fs.rename).mockImplementation(async (from, to) => {
		if (String(to) === oldPath) {
			entered.resolve();
			await refill.promise;
		} else {
			reachedReplacement.resolve();
			await replacement.promise;
			if (fail) throw new Error("injected replacement reservation failure");
		}
		await rename(from, to);
	});
	try {
		for (let index = 0; index < 512; index++) counter.next();
		await entered.promise;
		const rebinding = counter.bind("B");
		expect(counter.next()).toBeUndefined();
		const competing = owner(dir);
		await competing.bind("A");
		expect(competing.next()).toBeUndefined();
		refill.resolve();
		await reachedReplacement.promise;
		expect(counter.next()).toBeUndefined();
		replacement.resolve();
		await rebinding;
		const generation = counter.next();
		if (fail) expect(generation).toBeUndefined();
		else expect(Number(generation)).toBeGreaterThan(2048);
		counter.close();
		await counter.idle();
		vi.mocked(fs.rename).mockImplementation(rename);
		const old = owner(dir);
		await old.bind("A");
		expect(old.next()).toBe(2049);
		const next = owner(dir);
		await next.bind("B");
		expect(Number(next.next())).toBeGreaterThan(Number(generation ?? 0));
	} finally {
		refill.resolve();
		replacement.resolve();
	}
});
