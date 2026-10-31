import { createHash } from "node:crypto";
import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import { CompactReadError } from "../../../src/modes/rpc/compact-read-lease.ts";
import { CompactRecoveryCatalog } from "../../../src/modes/rpc/compact-recovery-catalog.ts";
import type { RecoveryRoute } from "../../../src/modes/rpc/compact-recovery-state.ts";
import type {
	RecoveryFailure,
	RecoveryOutcome,
	StorageUnavailableReason,
} from "../../../src/modes/rpc/compact-recovery-types.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { controlledIo, spoolRoot } from "../compact-storage-support.ts";
import { cutStructuredBytes, recoveryRig } from "./4272-recovery-support.ts";

// Part of #4272 (S09, RULING-58 and the #4551 review): a refusal of a catalog read is a closed typed detail, counted
// by that detail; refs are cut-scoped; a manifest build that fails after its catalog is built releases the tree.

afterEach(() => {
	vi.restoreAllMocks();
});

const route = (sessionId: string, socketEpoch: string): RecoveryRoute => ({
	socketEpoch,
	admissionId: "attach-1",
	routeKind: "ordinary",
	peer: "peer",
	sessionId,
});

function unwrap<T>(outcome: RecoveryOutcome<T>): T {
	if (!outcome.ok) throw new Error(`refused: ${JSON.stringify(outcome.failure)}`);
	return outcome.value;
}

const specLeafDigest = (bytes: Buffer): string => {
	const tag = Buffer.from("senpi-recovery-catalog/1/utf16le/leaf", "ascii");
	const length = Buffer.alloc(8);
	length.writeBigUInt64BE(BigInt(bytes.length));
	return createHash("sha256")
		.update(Buffer.from([tag.length]))
		.update(tag)
		.update(length)
		.update(bytes)
		.digest("hex");
};

/** A lane on real spooled storage for `sessionId`; `bytes()` reads the cut store's structured bytes under a probe root. */
async function storageRig(sessionId: string) {
	const root = await spoolRoot();
	const control = controlledIo();
	const writer = new SessionEventWriter(() => {});
	const lane = new SessionAcceptanceLane({ dir: root.dir, io: control.io });
	lane.bootstrap({ transcript: [] });
	writer.registerAcceptance(sessionId, lane);
	await lane.idle();
	const probe = lane.freeze();
	const bytes = async () => {
		await lane.idle();
		return cutStructuredBytes(lane, probe);
	};
	return {
		lane,
		checkpoints: writer.recoveryCheckpoints,
		bytes,
		before: await bytes(),
		async close() {
			lane.release(probe);
			lane.retire("close");
			await lane.idle();
			await root.cleanup();
		},
	};
}

it("RULING-58 (2) the storage_unavailable detail is a closed union that names integrity and range, never a free string", () => {
	expectTypeOf<
		Extract<RecoveryFailure, { kind: "storage_unavailable" }>["reason"]
	>().toEqualTypeOf<StorageUnavailableReason>();
	expectTypeOf<"integrity" | "range">().toMatchTypeOf<StorageUnavailableReason>();
	expectTypeOf<string>().not.toMatchTypeOf<StorageUnavailableReason>();
});

it("RULING-58 (3) a ref minted for one cut is refused against another cut as range, under either token, and counted as range", async () => {
	const rig = recoveryRig();
	const callerA = { socketEpoch: "socket-1", sessionId: "s" };
	const callerB = { socketEpoch: "socket-2", sessionId: "s" };
	const tokenA = unwrap(rig.checkpoints.freeze(route("s", "socket-1"), rig.lane)).token;
	const tokenB = unwrap(rig.checkpoints.freeze(route("s", "socket-2"), rig.lane)).token;
	const manifestA = unwrap(await rig.checkpoints.catalog(tokenA, callerA));
	const manifestB = unwrap(await rig.checkpoints.catalog(tokenB, callerB));
	expect(manifestA.catalogRoot).not.toBe(manifestB.catalogRoot);
	expect(manifestA.checkpointDigest, "the same frozen content: the same digest under both cuts").toBe(
		manifestB.checkpointDigest,
	);
	const range = { ok: false, failure: { kind: "storage_unavailable", reason: "range" } };
	expect(await rig.checkpoints.readCatalog(tokenB, callerB, manifestA.catalogRoot)).toEqual(range);
	expect(await rig.checkpoints.readCatalog(tokenB, callerB, `${manifestA.catalogRoot}:000`)).toEqual(range);
	expect(await rig.checkpoints.readCatalog(tokenA, callerA, manifestB.catalogRoot)).toEqual(range);
	expect(unwrap(await rig.checkpoints.readCatalog(tokenA, callerA, manifestA.catalogRoot)).ref).toBe(
		manifestA.catalogRoot,
	);
	expect(rig.checkpoints.status().unavailable).toEqual({ range: 3 });
	expect(rig.checkpoints.status().refused).toEqual({ storage_unavailable: 3 });
	rig.checkpoints.release(tokenA);
	rig.checkpoints.release(tokenB);
	await rig.lane.idle();
});

it("RULING-58 (1) a session id whose surrogate pair straddles the leaf boundary is hashed as stored and reads back byte-identical", async () => {
	const huge = `${"x".repeat(32_767)}\u{1F600}y`;
	const rig = await storageRig(huge);
	try {
		const caller = { socketEpoch: "socket-1", sessionId: huge };
		const token = unwrap(rig.checkpoints.freeze(route(huge, "socket-1"), rig.lane)).token;
		const manifest = unwrap(await rig.checkpoints.catalog(token, caller));
		if (!("ref" in manifest.session)) throw new Error("the huge session id must be a ref");
		const stored = Buffer.from(huge, "utf16le");
		expect(manifest.session.length).toBe(stored.length);
		expect(manifest.session.digest).toBe(specLeafDigest(stored));
		await rig.lane.idle();
		const read = unwrap(await rig.checkpoints.readCatalog(token, caller, manifest.session.ref));
		if (read.kind !== "component") throw new Error("expected a component");
		expect(read.text).toBe(huge);
		expect(Buffer.from(read.text, "utf16le").equals(stored)).toBe(true);
		rig.checkpoints.release(token);
		expect(await rig.bytes()).toEqual(rig.before);
	} finally {
		await rig.close();
	}
});

it("review MEDIUM: a manifest build that fails after its catalog is built releases the tree; the next call rebuilds", async () => {
	const session = "s".repeat(200);
	const rig = await storageRig(session);
	try {
		const caller = { socketEpoch: "socket-1", sessionId: session };
		const token = unwrap(rig.checkpoints.freeze(route(session, "socket-1"), rig.lane)).token;
		const frozen = await rig.bytes();
		vi.spyOn(CompactRecoveryCatalog.prototype, "read").mockImplementationOnce(async () => {
			throw new CompactReadError("unavailable");
		});
		expect(await rig.checkpoints.catalog(token, caller)).toEqual({
			ok: false,
			failure: { kind: "storage_unavailable", reason: "unavailable" },
		});
		expect(await rig.bytes(), "the failed build left no node, pointer leaf or text behind").toEqual(frozen);
		const manifest = unwrap(await rig.checkpoints.catalog(token, caller));
		expect(manifest.session).toMatchObject({ length: 400 });
		rig.checkpoints.release(token);
		expect(rig.lane.liveRoots).toBe(1);
		expect(await rig.bytes(), "no owner survives the token").toEqual(rig.before);
	} finally {
		await rig.close();
	}
});

it("review LOW: the oversized fields must be the first entries of the leftmost leaf; a layout that differs is a typed internal refusal and releases the tree", async () => {
	const session = "s".repeat(200);
	const rig = await storageRig(session);
	try {
		const caller = { socketEpoch: "socket-1", sessionId: session };
		const token = unwrap(rig.checkpoints.freeze(route(session, "socket-1"), rig.lane)).token;
		const original = CompactRecoveryCatalog.prototype.read;
		vi.spyOn(CompactRecoveryCatalog.prototype, "read").mockImplementationOnce(async function (
			this: CompactRecoveryCatalog,
			store,
			root,
			ref,
		) {
			const read = await original.call(this, store, root, ref);
			return read.kind === "node" ? { ...read, entries: [...read.entries].reverse() } : read;
		});
		expect(await rig.checkpoints.catalog(token, caller)).toEqual({
			ok: false,
			failure: { kind: "storage_unavailable", reason: "ownership" },
		});
		rig.checkpoints.release(token);
		expect(await rig.bytes()).toEqual(rig.before);
	} finally {
		await rig.close();
	}
});
