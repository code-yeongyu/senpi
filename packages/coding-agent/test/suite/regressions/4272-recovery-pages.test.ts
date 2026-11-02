import { afterEach, expect, it, vi } from "vitest";
import { FRAGMENT_MAX_BYTES, type RecoveryPage } from "../../../src/modes/rpc/compact-recovery-bytes.ts";
import { CompactRecoveryCatalog } from "../../../src/modes/rpc/compact-recovery-catalog.ts";
import type { RecoveryRoute } from "../../../src/modes/rpc/compact-recovery-state.ts";
import type { RecoveryOutcome } from "../../../src/modes/rpc/compact-recovery-types.ts";
import { component, specDigest } from "./4272-frozen-bytes-support.ts";
import { recoveryRig } from "./4272-recovery-support.ts";

// Part of #4272 (S11a, R4.B3, X03/X04/T5, carry 43, RULING-62 Q1 (1)): the page producer's real internal caller is the
// checkpoint owner's catalog reader: a component under a token pages back its exact stored bytes through the owner's
// claim and lease, one open component per token (replaced by the next, released with the token), and every refusal is
// typed before any byte is read. Cursors, ordinals, request limits and the command wiring are S11b.

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

/** A session id of 300,003 code units (600,006 stored bytes): ten leaves, five fragments, the last one partial. */
const huge = `${"\u{1F600}세션/..\\".repeat(37_500)}end`;
const TOTAL = 600_006;

async function tokenOf(rig: ReturnType<typeof recoveryRig>) {
	const caller = { socketEpoch: "socket-1", sessionId: huge };
	await rig.lane.idle();
	const token = unwrap(rig.checkpoints.freeze(route(huge), rig.lane)).token;
	const manifest = unwrap(await rig.checkpoints.catalog(token, caller));
	if (!("ref" in manifest.session)) throw new Error("the huge session id must be a ref");
	return { caller, token, manifest, session: manifest.session };
}

it("X03 X04 carry 43 a component pages back through the owner at raw byte offsets, exact and digest-checked, without a joined text", async () => {
	const rig = recoveryRig();
	const { caller, token, manifest, session } = await tokenOf(rig);
	const expected = Buffer.from(huge, "utf16le");
	expect(expected.length).toBe(TOTAL);
	const read = component(unwrap(await rig.checkpoints.readCatalog(token, caller, session.ref)));
	expect("text" in read, "carry 43: readCatalog no longer carries the whole component text").toBe(false);
	expect(read.bytes.length).toBe(session.length);
	expect(read.bytes.digest).toBe(session.digest);
	const served: RecoveryPage[] = [];
	for (let offset: number | null = 0; offset !== null;) {
		const page: RecoveryPage = unwrap(await rig.checkpoints.readCatalogPage(token, caller, session.ref, offset));
		served.push(page);
		offset = page.next;
	}
	expect(served.map((page) => [page.offset, page.length, page.complete])).toEqual([
		[0, FRAGMENT_MAX_BYTES, false],
		[FRAGMENT_MAX_BYTES, FRAGMENT_MAX_BYTES, false],
		[2 * FRAGMENT_MAX_BYTES, FRAGMENT_MAX_BYTES, false],
		[3 * FRAGMENT_MAX_BYTES, FRAGMENT_MAX_BYTES, false],
		[4 * FRAGMENT_MAX_BYTES, TOTAL - 4 * FRAGMENT_MAX_BYTES, true],
	]);
	const joined = Buffer.concat(served.map((page) => page.bytes));
	expect(joined.equals(expected)).toBe(true);
	expect(specDigest("leaf", joined)).toBe(session.digest);
	for (const page of served) expect(page.digest).toBe(specDigest("fragment", page.bytes));
	const active = unwrap(await rig.checkpoints.readCatalogPage(token, caller, `${manifest.catalogRoot}:007`, 0));
	expect(active.complete).toBe(true);
	expect(JSON.parse(active.bytes.toString("utf16le"))).toMatchObject({ messageId: "message-1" });
	rig.checkpoints.release(token);
	expect(rig.lane.liveRoots).toBe(0);
	await rig.lane.idle();
});

it("RULING-62 Q1 (1) RULING-69 (2) a component is verified once per root: paging it again or after another reopens nothing, a release drops it", async () => {
	const rig = recoveryRig();
	const { caller, token, manifest, session } = await tokenOf(rig);
	const opened = vi.spyOn(CompactRecoveryCatalog.prototype, "read");
	const activeRef = `${manifest.catalogRoot}:007`;
	const page = async (ref: string, offset: number) =>
		unwrap(await rig.checkpoints.readCatalogPage(token, caller, ref, offset));
	expect((await page(session.ref, 0)).offset).toBe(0);
	expect((await page(session.ref, FRAGMENT_MAX_BYTES)).offset).toBe(FRAGMENT_MAX_BYTES);
	expect(opened, "the second page of the same component reads the catalog again for nothing").toHaveBeenCalledTimes(1);
	expect((await page(activeRef, 0)).complete).toBe(true);
	expect(opened).toHaveBeenCalledTimes(2);
	expect((await page(session.ref, 2 * FRAGMENT_MAX_BYTES)).offset).toBe(2 * FRAGMENT_MAX_BYTES);
	expect(opened, "the component verified earlier on this root is not opened again").toHaveBeenCalledTimes(2);
	rig.checkpoints.release(token);
	expect(await rig.checkpoints.readCatalogPage(token, caller, session.ref, 0)).toMatchObject({
		ok: false,
		failure: { kind: "repair_needed" },
	});
	expect(opened, "no page is served after the release").toHaveBeenCalledTimes(2);
	expect(rig.lane.liveRoots).toBe(0);
	await rig.lane.idle();
});

it("T5 X04 a foreign caller, a node ref, an unknown ref and an out-of-range offset are refused typed with no byte read", async () => {
	const rig = recoveryRig();
	const { caller, token, manifest, session } = await tokenOf(rig);
	const reads = vi.spyOn(CompactRecoveryCatalog.prototype, "read");
	const foreign = { socketEpoch: "socket-2", sessionId: huge };
	expect(await rig.checkpoints.readCatalogPage(token, foreign, session.ref, 0)).toEqual({
		ok: false,
		failure: { kind: "repair_needed", reason: "unknown_token" },
	});
	expect(await rig.checkpoints.readCatalogPage(token, caller, manifest.catalogRoot, 0)).toEqual({
		ok: false,
		failure: { kind: "storage_unavailable", reason: "range" },
	});
	expect(await rig.checkpoints.readCatalogPage(token, caller, "not-a-ref", 0)).toEqual({
		ok: false,
		failure: { kind: "storage_unavailable", reason: "range" },
	});
	expect(await rig.checkpoints.readCatalogPage(token, caller, session.ref, session.length)).toEqual({
		ok: false,
		failure: { kind: "storage_unavailable", reason: "range" },
	});
	expect(await rig.checkpoints.readCatalogPage(token, caller, session.ref, -2)).toEqual({
		ok: false,
		failure: { kind: "storage_unavailable", reason: "range" },
	});
	expect(reads.mock.results.filter((result) => result.type === "return")).toHaveLength(2);
	expect(rig.checkpoints.status().unavailable).toEqual({ range: 4 });
	const last = unwrap(await rig.checkpoints.readCatalogPage(token, caller, session.ref, session.length - 1));
	expect(last).toMatchObject({ offset: session.length - 1, length: 1, next: null, complete: true });
	rig.checkpoints.release(token);
	expect(rig.lane.liveRoots).toBe(0);
	await rig.lane.idle();
});
