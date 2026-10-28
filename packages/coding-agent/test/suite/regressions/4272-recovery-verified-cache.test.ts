import { afterEach, expect, it, vi } from "vitest";
import { catalogDigest } from "../../../src/modes/rpc/compact-catalog-codec.ts";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { CompactReadError } from "../../../src/modes/rpc/compact-read-lease.ts";
import { FRAGMENT_MAX_BYTES, openFrozenBytes } from "../../../src/modes/rpc/compact-recovery-bytes.ts";
import { CompactRecoveryCatalog } from "../../../src/modes/rpc/compact-recovery-catalog.ts";
import type { RecoveryRoute } from "../../../src/modes/rpc/compact-recovery-state.ts";
import type { RecoveryOutcome } from "../../../src/modes/rpc/compact-recovery-types.ts";
import { FrozenRootPinnedError, VerifiedComponents } from "../../../src/modes/rpc/compact-verified-components.ts";
import { controlledIo, spoolRoot } from "../compact-storage-support.ts";
import { recoveryRig } from "./4272-recovery-support.ts";

// Part of #4272 (S11a, RULING-69 (2) and (4)): the open-time verification of a frozen component is cached per frozen
// root and dies with the root's lease; it runs inside the request that asked for it, under that request's abort signal,
// and an abort leaves nothing behind. An offset past the VERIFIED length is a typed range refusal, and a node entry
// whose length disagrees with the verified bytes is a typed integrity error, never a clamp.

afterEach(() => {
	vi.restoreAllMocks();
});

const route = (sessionId: string): RecoveryRoute => ({
	socketEpoch: "socket-1",
	admissionId: "attach-1",
	routeKind: "ordinary",
	peer: "peer",
	sessionId,
});

function unwrap<T>(outcome: RecoveryOutcome<T>): T {
	if (!outcome.ok) throw new Error(`refused: ${JSON.stringify(outcome.failure)}`);
	return outcome.value;
}

/** A session id of 600,006 stored bytes: ten leaves, five fragments. */
const huge = `${"\u{1F600}세션/..\\".repeat(37_500)}end`;

async function tokenOf() {
	const rig = recoveryRig();
	const caller = { socketEpoch: "socket-1", sessionId: huge };
	await rig.lane.idle();
	const token = unwrap(rig.checkpoints.freeze(route(huge), rig.lane)).token;
	const manifest = unwrap(await rig.checkpoints.catalog(token, caller));
	if (!("ref" in manifest.session)) throw new Error("the huge session id must be a ref");
	const page = (ref: string, offset: number, signal?: AbortSignal) =>
		rig.checkpoints.readCatalogPage(token, caller, ref, offset, signal);
	return { rig, token, caller, session: manifest.session, active: `${manifest.catalogRoot}:007`, page };
}

/** Counts stored leaf reads and the reads still in flight (a leaf resident in the reader). */
function leafReads() {
	const counts = { started: 0, settled: 0 };
	const read = CompactContentStore.prototype.readLeaf;
	const spy = vi.spyOn(CompactContentStore.prototype, "readLeaf").mockImplementation(async function (
		this: CompactContentStore,
		...args
	) {
		counts.started += 1;
		try {
			return await read.apply(this, args);
		} finally {
			counts.settled += 1;
		}
	});
	return { counts, spy };
}

it("RULING-69 (2) a re-open of a verified component on the same root reads no leaf again; the entry dies with the lease", async () => {
	const { rig, token, session, active, page } = await tokenOf();
	unwrap(await page(session.ref, 0));
	const reads = leafReads();
	const opened = vi.spyOn(CompactRecoveryCatalog.prototype, "read");
	unwrap(await page(session.ref, FRAGMENT_MAX_BYTES));
	const servingOnly = reads.counts.started;
	unwrap(await page(active, 0));
	const before = reads.counts.started;
	unwrap(await page(session.ref, FRAGMENT_MAX_BYTES));
	expect(reads.counts.started - before, "the re-open serves the page and verifies nothing").toBe(servingOnly);
	expect(opened, "only the first open of the second component reads the catalog").toHaveBeenCalledTimes(1);
	expect(rig.checkpoints.verifiedComponents, "both verified components are cached under the root").toBe(2);
	rig.checkpoints.release(token);
	expect(rig.checkpoints.verifiedComponents, "the cache entry dies with the root's lease").toBe(0);
	expect(rig.lane.liveRoots).toBe(0);
	await rig.lane.idle();
});

it("RULING-69 (2) a superseding freeze reclaims the root and drops its verified components", async () => {
	const { rig, session, page } = await tokenOf();
	unwrap(await page(session.ref, 0));
	expect(rig.checkpoints.verifiedComponents).toBe(1);
	const next = unwrap(rig.checkpoints.freeze(route(huge), rig.lane)).token;
	expect(rig.checkpoints.verifiedComponents, "the superseded root's lease ended").toBe(0);
	rig.checkpoints.release(next);
	await rig.lane.idle();
});

it("RULING-69 (2) two peers and a re-attach on one session each pin their own root; the cache never trips", async () => {
	const { rig, token, caller, session, page } = await tokenOf();
	const first = rig.checkpoints.tokens().length;
	expect(first).toBe(1);
	unwrap(await page(session.ref, 0));
	const other = { socketEpoch: "socket-2", sessionId: huge };
	const second = unwrap(rig.checkpoints.freeze({ ...route(huge), socketEpoch: "socket-2", peer: "peer-2" }, rig.lane));
	const otherManifest = unwrap(await rig.checkpoints.catalog(second.token, other));
	if (!("ref" in otherManifest.session)) throw new Error("the huge session id must be a ref");
	unwrap(await rig.checkpoints.readCatalogPage(second.token, other, otherManifest.session.ref, 0));
	expect(rig.checkpoints.verifiedComponents, "one verified component per peer's own root").toBe(2);
	const reattach = unwrap(rig.checkpoints.freeze({ ...route(huge), admissionId: "attach-2" }, rig.lane));
	expect(rig.checkpoints.verifiedComponents, "the re-attach superseded the first token's root").toBe(1);
	const again = unwrap(await rig.checkpoints.catalog(reattach.token, caller));
	if (!("ref" in again.session)) throw new Error("the huge session id must be a ref");
	unwrap(await rig.checkpoints.readCatalogPage(reattach.token, caller, again.session.ref, 0));
	expect(rig.checkpoints.verifiedComponents).toBe(2);
	expect(second.root, "a second peer's freeze is a root of its own").not.toBe(reattach.root);
	for (const held of [token, second.token, reattach.token]) rig.checkpoints.release(held);
	expect(rig.checkpoints.verifiedComponents, "every root's entries went with its lease").toBe(0);
	expect(rig.lane.liveRoots).toBe(0);
	await rig.lane.idle();
});

it("RULING-69 (2) a second token pinning a root another live token pins is a typed internal error", async () => {
	const rig = recoveryRig();
	await rig.lane.idle();
	const held = unwrap(rig.checkpoints.freeze(route("s"), rig.lane));
	const holderStream = rig.checkpoints.stream(held.token.admission);
	const violating = { ...route("s"), socketEpoch: "socket-2" };
	const freeze = vi.spyOn(rig.lane, "freeze").mockReturnValueOnce(held.root);
	expect(() => rig.checkpoints.freeze(violating, rig.lane)).toThrow(FrozenRootPinnedError);
	freeze.mockRestore();
	expect(
		rig.checkpoints.stream(violating),
		"the throw came before the violating route's stream moved",
	).toBeUndefined();
	expect(rig.checkpoints.stream(held.token.admission), "the holder's stream is unchanged").toEqual(holderStream);
	expect(rig.checkpoints.open, "the violating freeze minted no token").toBe(1);
	expect(rig.checkpoints.tokens()).toEqual([held.token]);
	expect(rig.lane.liveRoots, "the holder's root is still live").toBe(1);
	const direct = new VerifiedComponents();
	direct.pin("token-a", held.root);
	direct.pin("token-a", held.root);
	expect(() => direct.pin("token-b", held.root)).toThrow(new FrozenRootPinnedError("token-b", "token-a"));
	direct.drop("token-a");
	direct.pin("token-b", held.root);
	rig.checkpoints.release(held.token);
	expect(rig.lane.liveRoots).toBe(0);
	await rig.lane.idle();
});

it("RULING-69 (2) an abort mid-verification is typed and leaves no cache entry and no resident leaf", async () => {
	const { rig, token, session, active, page } = await tokenOf();
	const reads = leafReads();
	const abort = new AbortController();
	reads.spy.mockClear();
	const read = reads.spy.getMockImplementation();
	reads.spy.mockImplementation(async function (this: CompactContentStore, ...args) {
		if (reads.counts.started === 5) abort.abort();
		return read?.apply(this, args) ?? expect.unreachable();
	});
	expect(await page(session.ref, 0, abort.signal)).toEqual({
		ok: false,
		failure: { kind: "storage_unavailable", reason: "aborted" },
	});
	expect(reads.counts.started, "verification stopped at the abort, short of the component's ten leaves").toBeLessThan(
		10,
	);
	expect(reads.counts.started - reads.counts.settled, "no leaf read is left in flight").toBe(0);
	expect(rig.checkpoints.verifiedComponents, "nothing was cached").toBe(0);
	const opened = vi.spyOn(CompactRecoveryCatalog.prototype, "read");
	expect(unwrap(await page(session.ref, 0)).offset).toBe(0);
	expect(opened, "the next request verifies from the start").toHaveBeenCalledTimes(1);
	expect(await page(active, 0, AbortSignal.abort()), "an unverified component under a spent budget").toEqual({
		ok: false,
		failure: { kind: "storage_unavailable", reason: "aborted" },
	});
	expect(unwrap(await page(session.ref, 0, AbortSignal.abort())).offset, "a verified one costs no verification").toBe(
		0,
	);
	expect(rig.checkpoints.verifiedComponents).toBe(1);
	rig.checkpoints.release(token);
	await rig.lane.idle();
});

it("RULING-69 (4) an offset beyond the verified length is the typed range refusal, fresh or cached", async () => {
	const { rig, token, session, page } = await tokenOf();
	for (const offset of [session.length, session.length + 1, Number.MAX_SAFE_INTEGER])
		expect(await page(session.ref, offset)).toEqual({
			ok: false,
			failure: { kind: "storage_unavailable", reason: "range" },
		});
	expect(unwrap(await page(session.ref, session.length - 1))).toMatchObject({ length: 1, complete: true });
	expect(await page(session.ref, session.length + 1)).toEqual({
		ok: false,
		failure: { kind: "storage_unavailable", reason: "range" },
	});
	rig.checkpoints.release(token);
	await rig.lane.idle();
});

it("RULING-69 (4) a node entry length that disagrees with the verified bytes is a typed integrity error, never a clamp", async () => {
	const root = await spoolRoot();
	const store = new CompactContentStore({ dir: root.dir, io: controlledIo().io });
	try {
		const texts = ["frozen ", "component"];
		const leaves = texts.map((text) => store.createLeaf(text));
		const bytes = Buffer.from(texts.join(""), "utf16le");
		const digest = catalogDigest("leaf", bytes);
		const open = (length: number) =>
			openFrozenBytes(
				{ length, digest },
				leaves,
				(leaf) => store.readLeaf(leaf),
				() => {},
			);
		expect((await open(bytes.length)).length).toBe(bytes.length);
		for (const length of [bytes.length - 2, bytes.length + 2, 0]) {
			const refused = await open(length).then(
				() => undefined,
				(cause: unknown) => cause,
			);
			expect(refused, `entry length ${length} against ${bytes.length} verified bytes`).toEqual(
				new CompactReadError("integrity"),
			);
		}
		for (const leaf of leaves) store.adjust(leaf, -1, 0);
	} finally {
		await store.retire();
		await root.cleanup();
	}
});
