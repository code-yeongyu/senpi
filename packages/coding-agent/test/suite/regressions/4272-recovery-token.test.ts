import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { COMPACT_LEAF_CODE_UNITS as LEAF } from "../../../src/modes/rpc/compact-content-store.ts";
import type { RecoveryRoute } from "../../../src/modes/rpc/compact-recovery-state.ts";
import type { RecoveryOutcome } from "../../../src/modes/rpc/compact-recovery-types.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { controlledIo } from "../compact-storage-support.ts";
import { LaneProducer, usage } from "./4272-legacy-view-support.ts";

// Part of #4272 (S08a, R3.C1.5): a checkpoint token is validated before I/O, after every await and before delivery;
// a retired, foreign or superseded token is a typed repair_needed failure, release is idempotent and per token.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const owner = () => new SessionEventWriter(() => {}).recoveryCheckpoints;

const route: RecoveryRoute = {
	socketEpoch: "socket-1",
	admissionId: "attach-1",
	routeKind: "ordinary",
	peer: "peer",
	sessionId: "s",
};
const caller = { socketEpoch: "socket-1", sessionId: "s" };

function unwrap<T>(outcome: RecoveryOutcome<T>): T {
	if (!outcome.ok) throw new Error(`refused: ${JSON.stringify(outcome.failure)}`);
	return outcome.value;
}

const start = { role: "assistant", content: [], api: "faux", provider: "faux", model: "fixture", usage };

function streamedLane(storage?: ConstructorParameters<typeof SessionAcceptanceLane>[0]) {
	const lane = new SessionAcceptanceLane(storage);
	lane.bootstrap({ transcript: [] });
	const producer = new LaneProducer(new SessionEventWriter(() => {}), lane, "s");
	producer.assistant({ type: "message_start", message: start }, { type: "message_start", message: start });
	producer.blockStart("text", 0);
	producer.blockDelta("text", 0, "a".repeat(LEAF * 2), 0);
	return lane;
}

it("T5 a release is idempotent and per token: an older token's release never touches the newer cut, a superseded or foreign token reads nothing", async () => {
	const checkpoints = owner();
	const lane = streamedLane();
	const older = unwrap(checkpoints.freeze(route, lane)).token;
	const newer = unwrap(checkpoints.freeze(route, lane)).token;
	expect([older.admission.generation, newer.admission.generation]).toEqual([1, 2]);
	expect(older.id).not.toBe(newer.id);
	expect(lane.liveRoots).toBe(2);
	expect(await checkpoints.readActive(older, caller), "RULING-50 (2): typed, naming the newer generation").toEqual({
		ok: false,
		failure: { kind: "repair_needed", reason: "superseded_token", newerGeneration: 2 },
	});
	checkpoints.release(older);
	checkpoints.release(older);
	expect(lane.liveRoots, "the newer cut stays pinned").toBe(1);
	expect(checkpoints.open).toBe(1);
	expect(await checkpoints.readActive(older, caller)).toEqual({
		ok: false,
		failure: { kind: "repair_needed", reason: "unknown_token" },
	});
	expect(await checkpoints.readActive(newer, { ...caller, socketEpoch: "socket-2" })).toEqual({
		ok: false,
		failure: { kind: "repair_needed", reason: "foreign_peer" },
	});
	expect(await checkpoints.readActive(newer, { ...caller, sessionId: "t" })).toEqual({
		ok: false,
		failure: { kind: "repair_needed", reason: "foreign_session" },
	});
	expect(lane.liveRoots, "a refused lookup releases nothing").toBe(1);
	expect(unwrap(await checkpoints.readActive(newer, caller))).toHaveLength(1);
	checkpoints.release(newer);
	expect(lane.liveRoots).toBe(0);
	expect(checkpoints.open).toBe(0);
	lane.retire("close");
	await lane.idle();
});

it("T5 X04 a replacement during a held component read refuses the old result and unwinds the lease exactly once", async () => {
	const dir = await mkdtemp(join(tmpdir(), "senpi-4272-s08a-token-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const control = controlledIo();
	const hold = control.hold("read", (path) => /[/\\]leaf-/.test(path));
	const checkpoints = owner();
	const lane = streamedLane({ dir, spillAboveBytes: 0, spillTargetBytes: 0, io: control.io });
	await lane.idle();
	const token = unwrap(checkpoints.freeze(route, lane)).token;
	const reading = checkpoints.readActive(token, caller);
	await hold.entered;
	lane.bootstrap({ transcript: [] });
	expect(lane.sessionEpoch).not.toBe(token.cut.sessionEpoch);
	hold.release();
	expect(await reading).toEqual({ ok: false, failure: { kind: "repair_needed", reason: "stale_epoch" } });
	expect(await checkpoints.readActive(token, caller)).toEqual({
		ok: false,
		failure: { kind: "repair_needed", reason: "stale_epoch" },
	});
	expect(checkpoints.open, "the token stays owned until its holder releases it").toBe(1);
	checkpoints.release(token);
	checkpoints.release(token);
	expect(checkpoints.open).toBe(0);
	expect(lane.liveRoots).toBe(0);
	lane.retire("close");
	await lane.idle();
});

it("T5 X04 a lane retired during a held read is a lane_retired failure; a later freeze on it publishes no token", async () => {
	const dir = await mkdtemp(join(tmpdir(), "senpi-4272-s08a-retired-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const control = controlledIo();
	const hold = control.hold("read", (path) => /[/\\]leaf-/.test(path));
	const checkpoints = owner();
	const lane = streamedLane({ dir, spillAboveBytes: 0, spillTargetBytes: 0, io: control.io });
	await lane.idle();
	const token = unwrap(checkpoints.freeze(route, lane)).token;
	const reading = checkpoints.readCurrent(token, caller);
	await hold.entered;
	lane.retire("close");
	hold.release();
	expect(await reading).toEqual({ ok: false, failure: { kind: "repair_needed", reason: "lane_retired" } });
	expect(checkpoints.freeze(route, lane)).toEqual({
		ok: false,
		failure: { kind: "repair_needed", reason: "lane_retired" },
	});
	checkpoints.release(token);
	expect(checkpoints.open).toBe(0);
	expect(lane.liveRoots).toBe(0);
	await lane.idle();
});

it("RULING-50 (2) a holder that never releases pins nothing past its peer: forgetting the peer reclaims every root it froze, the superseded one at once and the one under a read once it unwinds", async () => {
	const dir = await mkdtemp(join(tmpdir(), "senpi-4272-s08a-forget-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const control = controlledIo();
	const hold = control.hold("read", (path) => /[/\\]leaf-/.test(path));
	const checkpoints = owner();
	const lane = streamedLane({ dir, spillAboveBytes: 0, spillTargetBytes: 0, io: control.io });
	await lane.idle();
	const older = unwrap(checkpoints.freeze(route, lane)).token;
	const newer = unwrap(checkpoints.freeze(route, lane)).token;
	const other = unwrap(checkpoints.freeze({ ...route, socketEpoch: "socket-2" }, lane)).token;
	const reading = checkpoints.readActive(newer, caller);
	await hold.entered;
	checkpoints.forgetPeer("socket-1");
	expect(lane.liveRoots, "the superseded root went at once").toBe(2);
	hold.release();
	expect(await reading).toEqual({ ok: false, failure: { kind: "repair_needed", reason: "peer_gone" } });
	expect(lane.liveRoots, "only the other peer's root stays").toBe(1);
	expect(checkpoints.tokens()).toEqual([other]);
	checkpoints.release(older);
	checkpoints.release(newer);
	expect(lane.liveRoots, "a late release by the holder touches nothing").toBe(1);
	checkpoints.release(other);
	expect(lane.liveRoots).toBe(0);
	lane.retire("close");
	await lane.idle();
});

it("RULING-50 (2) a forgotten session's lane releases the roots its tokens pinned though no holder released them", async () => {
	const checkpoints = owner();
	const lane = streamedLane();
	const token = unwrap(checkpoints.freeze(route, lane)).token;
	lane.retire("close");
	expect(lane.liveRoots).toBe(0);
	expect(await checkpoints.readActive(token, caller)).toEqual({
		ok: false,
		failure: { kind: "repair_needed", reason: "lane_retired" },
	});
	checkpoints.release(token);
	await lane.idle();
});

it("T5 a failed freeze publishes no token and pins nothing: an unavailable compact state is storage_unavailable", async () => {
	const checkpoints = owner();
	const lane = streamedLane();
	lane.compactUnavailable(new Error("lost canonical record"));
	expect(checkpoints.freeze(route, lane)).toEqual({
		ok: false,
		failure: { kind: "storage_unavailable", reason: "compact_state_unavailable" },
	});
	expect(checkpoints.open).toBe(0);
	expect(lane.liveRoots, "the partial root was released at once").toBe(0);
	lane.retire("close");
	await lane.idle();
});
