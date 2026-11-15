// senpi#5924 review L2: a hand_link state record that does not decode fails closed. Opening the state throws, so the
// batch is refused `hand_link_unavailable`, instead of a corrupt scope looking unclaimed or a corrupt holder letting
// any sender take its generation.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoreValue } from "@earendil-works/pi-agent-core/conformance";
import { afterEach, expect, it } from "vitest";
import { openHandLinkState } from "../../src/modes/rpc/hand-link-state.ts";
import { type LockedFileStore, openLockedFileStore } from "../../src/modes/rpc/locked-file-store.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;

function statePath(): string {
	const root = mkdtempSync(join(tmpdir(), "hls-"));
	roots.push(root);
	return join(root, "state.json");
}

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

it.each<[string, string, StoreValue]>([
	["a lowest generation of 0", "hand-link.session:s", { lowest: 0, at: 1 }],
	["no write time", "hand-link.session:s", { lowest: 1 }],
	["a string lowest generation", "hand-link.session:s", { lowest: "1", at: 1 }],
	["a fractional lowest generation", "hand-link.session:s", { lowest: 1.5, at: 1 }],
	["a non-string owner", "hand-link.session:s", { lowest: 1, at: 1, owner: 7, loopId: "l", daemon: "d" }],
	["an owner without a loop", "hand-link.session:s", { lowest: 1, at: 1, owner: "a" }],
	["a malformed closed mark", "hand-link.session:s", { lowest: 1, at: 1, closed: "yes" }],
	["a scope bound to no session name", "hand-link.scope:x", 7],
])("refuses to open state holding %s", async (_label, key, data) => {
	const root = mkdtempSync(join(tmpdir(), "hls-"));
	roots.push(root);
	const path = join(root, "state.json");
	const seed = openLockedFileStore(path);
	await seed.commit(await seed.claimFor("seed"), [{ op: "put", key, data }], () => {});

	await expect(openHandLinkState(openLockedFileStore(path), "daemon")).rejects.toMatchObject({
		name: "HandLinkStateCorruptError",
	});
});

it("caps the scopes one session may hold", async () => {
	const root = mkdtempSync(join(tmpdir(), "hls-"));
	roots.push(root);
	const state = await openHandLinkState(openLockedFileStore(join(root, "state.json")), "daemon", { maxScopes: 2 });
	try {
		expect([await state.claim("a", "s"), await state.claim("b", "s"), await state.claim("a", "s")]).toEqual([
			"held",
			"held",
			"held",
		]);
		expect(await state.claim("c", "s")).toBe("limit");
		expect(await state.claim("c", "other")).toBe("held");
	} finally {
		state.close();
	}
});

it("caps the sessions holding a live link", async () => {
	const path = statePath();
	const state = await openHandLinkState(openLockedFileStore(path), "daemon", { maxSessions: 2 });
	try {
		await state.admit("a", 1, { owner: "o", loopId: "l" });
		await state.admit("b", 1, { owner: "o", loopId: "l" });
		expect([state.hasRoomFor("a"), state.hasRoomFor("c")]).toEqual([true, false]);
		await state.end("a", 2);
		expect(state.hasRoomFor("c")).toBe(true);
	} finally {
		state.close();
	}
});

it("compacts records past retention into tombstones: a closed session stays closed, old generations stay refused", async () => {
	const path = statePath();
	const holder = { owner: "o", loopId: "l" };
	const old = await openHandLinkState(openLockedFileStore(path), "first", { now: () => 0 });
	await old.admit("ended", 1, holder);
	await old.claim("ended-scope", "ended");
	await old.end("ended", 2);
	await old.retire("closed");
	await old.admit("crashed", 3, holder);
	await old.claim("crashed-scope", "crashed");
	old.close();

	const later = await openHandLinkState(openLockedFileStore(path), "second", { now: () => 8 * DAY });
	try {
		expect(later.session("closed")).toEqual({ lowest: 1, at: 0, closed: true });
		expect(later.session("ended")).toEqual({ lowest: 2, at: 0 });
		expect(later.session("crashed")).toEqual({ lowest: 4, at: 0 });
		expect([await later.claim("ended-scope", "x"), await later.claim("crashed-scope", "y")]).toEqual([
			"held",
			"held",
		]);
	} finally {
		later.close();
	}
});

it("sees a claim another daemon makes while this one is still opening, and its fence then admits nothing", async () => {
	const path = statePath();
	const store = openLockedFileStore(path);
	const claimFor = store.claimFor;
	const racing: LockedFileStore = Object.assign(store, {
		claimFor: async (token: string) => {
			const epoch = await claimFor(token);
			await openLockedFileStore(path).claimFor("rival");
			return epoch;
		},
	});
	const state = await openHandLinkState(racing, "daemon");
	try {
		const lost = Promise.withResolvers<void>();
		state.onSuperseded(() => lost.resolve());
		await within(lost.promise, 10_000, "the superseded notice");
		expect(state.owned()).toBe(false);
		expect(state.fence.admits("any-scope", 5, "o")).toBe(false);
	} finally {
		state.close();
	}
});
