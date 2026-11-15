// senpi#5924 review L2: a hand_link state record that does not decode fails closed. Opening the state throws, so the
// batch is refused `hand_link_unavailable`, instead of a corrupt scope looking unclaimed or a corrupt holder letting
// any sender take its generation.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoreValue } from "@earendil-works/pi-agent-core/conformance";
import { afterEach, expect, it } from "vitest";
import { openHandLinkState } from "../../src/modes/rpc/hand-link-state.ts";
import { openLockedFileStore } from "../../src/modes/rpc/locked-file-store.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

it("prunes ended and closed sessions past retention, with their scopes; a live link stays", async () => {
	const root = mkdtempSync(join(tmpdir(), "hls-"));
	roots.push(root);
	const path = join(root, "state.json");
	const DAY = 24 * 60 * 60 * 1000;
	const old = await openHandLinkState(openLockedFileStore(path), "first", { now: () => 0 });
	await old.admit("ended", 1, { owner: "o", loopId: "l" });
	await old.claim("ended-scope", "ended");
	await old.end("ended", 2);
	await old.retire("closed");
	await old.admit("live", 1, { owner: "o", loopId: "l" });
	old.close();

	const later = await openHandLinkState(openLockedFileStore(path), "second", { now: () => 8 * DAY });
	try {
		expect([later.session("ended"), later.session("closed")]).toEqual([undefined, undefined]);
		expect(later.session("live")?.holder?.owner).toBe("o");
		expect(await later.claim("ended-scope", "someone-else")).toBe("held");
	} finally {
		later.close();
	}
});
