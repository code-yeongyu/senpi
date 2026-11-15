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
	["a lowest generation of 0", "hand-link.session:s", { lowest: 0 }],
	["a string lowest generation", "hand-link.session:s", { lowest: "1" }],
	["a fractional lowest generation", "hand-link.session:s", { lowest: 1.5 }],
	["a non-string owner", "hand-link.session:s", { lowest: 1, owner: 7, loopId: "l" }],
	["an owner without a loop", "hand-link.session:s", { lowest: 1, owner: "a" }],
	["a malformed closed mark", "hand-link.session:s", { lowest: 1, closed: "yes" }],
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
