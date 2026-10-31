import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { COMPACT_LEAF_CODE_UNITS as LEAF } from "../../../src/modes/rpc/compact-content-store.ts";
import type { RecoveryRoute } from "../../../src/modes/rpc/compact-recovery-state.ts";
import type {
	CheckpointToken,
	RecoveryCaller,
	RecoveryOutcome,
} from "../../../src/modes/rpc/compact-recovery-types.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { controlledIo } from "../compact-storage-support.ts";
import { LaneProducer, usage } from "./4272-legacy-view-support.ts";

// Part of #4272 (S08a/S08b, R3.C1.5): a checkpoint token is validated before I/O, after every await and before
// delivery; a retired, foreign or superseded token is a typed repair_needed failure, release is idempotent and per
// token, and a superseded root is reclaimed at the supersession whether or not its holder ever releases it.

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

const unknownToken = { ok: false, failure: { kind: "repair_needed", reason: "unknown_token" } };

/** Settles `promise`, or fails after `ms`: an operation that never ends is a failure of this test, not a hang. */
async function within<T>(promise: Promise<T>, ms = 5_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms);
	});
	try {
		return await Promise.race([promise, deadline]);
	} finally {
		clearTimeout(timer);
	}
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

it("T5 a release is idempotent and per token: a new generation reclaims the older root at once, the older token's release never touches the newer cut, a superseded or foreign token reads nothing", async () => {
	const checkpoints = owner();
	const lane = streamedLane();
	const older = unwrap(checkpoints.freeze(route, lane)).token;
	const newer = unwrap(checkpoints.freeze(route, lane)).token;
	expect([older.admission.generation, newer.admission.generation]).toEqual([1, 2]);
	expect(older.id).not.toBe(newer.id);
	expect(lane.liveRoots, "S08b: the superseded root went at the supersession, with nothing in flight on it").toBe(1);
	expect(checkpoints.open).toBe(1);
	expect(await checkpoints.readActive(older, caller), "RULING-50 (2): typed, naming the newer generation").toEqual({
		ok: false,
		failure: { kind: "repair_needed", reason: "superseded_token", newerGeneration: 2 },
	});
	checkpoints.release(older);
	checkpoints.release(older);
	expect(lane.liveRoots, "the newer cut stays pinned").toBe(1);
	expect(checkpoints.open).toBe(1);
	expect(await checkpoints.readActive(older, caller), "the stream still describes the released token").toEqual({
		ok: false,
		failure: { kind: "repair_needed", reason: "superseded_token", newerGeneration: 2 },
	});
	expect(
		await checkpoints.readActive(newer, { ...caller, socketEpoch: "socket-2" }),
		"RULING-56 (1): another peer's token is unknown to the asker",
	).toEqual(unknownToken);
	expect(
		await checkpoints.readActive(newer, { ...caller, sessionId: "t" }),
		"RULING-56 (1): another session's token is unknown to the asker",
	).toEqual(unknownToken);
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
	expect(
		unwrap(await checkpoints.readActive(other, { ...caller, socketEpoch: "socket-2" })),
		"carry 38: the surviving token still reads its cut through its lease",
	).toHaveLength(1);
	checkpoints.release(older);
	checkpoints.release(newer);
	expect(lane.liveRoots, "a late release by the holder touches nothing").toBe(1);
	checkpoints.release(other);
	expect(lane.liveRoots).toBe(0);
	lane.retire("close");
	await lane.idle();
});

it("T5 X04 carry 33 a superseded root is reclaimed at the supersession though its holder never releases: deferred only by the operation in flight on it, which is refused as superseded_token", async () => {
	const dir = await mkdtemp(join(tmpdir(), "senpi-4272-s08b-supersede-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const control = controlledIo();
	const hold = control.hold("read", (path) => /[/\\]leaf-/.test(path));
	const checkpoints = owner();
	const lane = streamedLane({ dir, spillAboveBytes: 0, spillTargetBytes: 0, io: control.io });
	await lane.idle();
	const older = unwrap(checkpoints.freeze(route, lane)).token;
	const reading = checkpoints.readActive(older, caller);
	await hold.entered;
	const newer = unwrap(checkpoints.freeze(route, lane)).token;
	expect(lane.liveRoots, "the operation in flight defers the reclaim").toBe(2);
	expect(checkpoints.status()).toMatchObject({ open: 2, streams: 1, frozen: 2, reclaimed: 1 });
	hold.release();
	expect(await reading).toEqual({
		ok: false,
		failure: { kind: "repair_needed", reason: "superseded_token", newerGeneration: 2 },
	});
	expect(lane.liveRoots, "reclaimed once the operation unwound; the holder released nothing").toBe(1);
	expect(checkpoints.tokens()).toEqual([newer]);
	expect(await checkpoints.readActive(older, caller)).toEqual({
		ok: false,
		failure: { kind: "repair_needed", reason: "superseded_token", newerGeneration: 2 },
	});
	expect(checkpoints.status()).toMatchObject({ open: 1, refused: { superseded_token: 2 } });
	checkpoints.release(newer);
	expect(lane.liveRoots).toBe(0);
	lane.retire("close");
	await lane.idle();
});

it("carry 37 a replacement's first freeze replaces the peer + session stream and reclaims the previous incarnation's token: the old token reads stale_epoch", async () => {
	const checkpoints = owner();
	const lane = streamedLane();
	const before = unwrap(checkpoints.freeze(route, lane)).token;
	lane.bootstrap({ transcript: [] });
	expect(lane.liveRoots, "the bootstrap released the incarnation's roots").toBe(0);
	expect(checkpoints.open, "the token is still owned until the stream is replaced").toBe(1);
	const after = unwrap(checkpoints.freeze(route, lane)).token;
	expect(after.admission).toMatchObject({ generation: 1 });
	expect(after.admission.sessionEpoch).not.toBe(before.admission.sessionEpoch);
	expect(checkpoints.open, "the previous incarnation's token was reclaimed by the replacement").toBe(1);
	expect(checkpoints.status()).toMatchObject({ streams: 1, reclaimed: 1 });
	expect(await checkpoints.readActive(before, caller)).toEqual({
		ok: false,
		failure: { kind: "repair_needed", reason: "stale_epoch" },
	});
	checkpoints.release(before);
	checkpoints.release(after);
	expect(checkpoints.open).toBe(0);
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

it("RULING-56 (1) SECURITY a token minted for another peer or another session answers unknown_token with no generation and no state, however its admission is rewritten", async () => {
	const checkpoints = owner();
	const lane = streamedLane();
	const elsewhere = streamedLane();
	const older = unwrap(checkpoints.freeze(route, lane)).token;
	const newer = unwrap(checkpoints.freeze(route, lane)).token;
	const peer = { ...caller, socketEpoch: "socket-2" };
	const other = unwrap(checkpoints.freeze({ ...route, ...peer }, lane)).token;
	const otherNewer = unwrap(checkpoints.freeze({ ...route, ...peer }, lane)).token;
	expect(otherNewer.admission.generation, "the asking peer's own stream is at generation 2").toBe(2);
	const incarnation = { ...caller, sessionId: "t" };
	const onT = unwrap(checkpoints.freeze({ ...route, ...incarnation }, elsewhere)).token;
	const closed = { ...caller, sessionId: "u" };
	const onU = unwrap(checkpoints.freeze({ ...route, ...closed }, lane)).token;
	checkpoints.forgetSession("u");
	const rewrite = (token: CheckpointToken, scope: RecoveryCaller): CheckpointToken => ({
		...token,
		admission: { ...token.admission, ...scope },
	});
	const before = { open: checkpoints.open, streams: checkpoints.status().streams };
	const roots = lane.liveRoots + elsewhere.liveRoots;
	const probes: readonly (readonly [string, CheckpointToken, RecoveryCaller])[] = [
		["another peer's live token", newer, peer],
		["another peer's superseded token", older, peer],
		["another peer's live token rewritten to the asker", rewrite(newer, peer), peer],
		["another peer's superseded token rewritten to the asker (no superseded_token)", rewrite(older, peer), peer],
		["another session's token", newer, incarnation],
		[
			"another session's token rewritten to a session at another incarnation (no stale_epoch)",
			rewrite(newer, incarnation),
			incarnation,
		],
		["another session's token rewritten to a closed session (no session_closed)", rewrite(older, closed), closed],
	];
	for (const [name, token, asker] of probes)
		expect(await checkpoints.readActive(token, asker), name).toEqual(unknownToken);
	expect(await checkpoints.readActive(other, peer), "the asker's own superseded token is still described").toEqual({
		ok: false,
		failure: { kind: "repair_needed", reason: "superseded_token", newerGeneration: 2 },
	});
	expect(lane.liveRoots + elsewhere.liveRoots, "a probe pins and releases nothing").toBe(roots);
	expect(checkpoints.status()).toMatchObject({
		...before,
		refused: { unknown_token: probes.length, superseded_token: 1 },
	});
	for (const token of [newer, otherNewer, onT, onU]) checkpoints.release(token);
	expect(lane.liveRoots + elsewhere.liveRoots).toBe(0);
	for (const retired of [lane, elsewhere]) {
		retired.retire("close");
		await retired.idle();
	}
});

it("RULING-56 (4) retiring a route is idempotent: the admission's token is reclaimed once, a second retirement changes nothing", async () => {
	const checkpoints = owner();
	const lane = streamedLane();
	const token = unwrap(checkpoints.freeze(route, lane)).token;
	const snapshot = () => ({
		stream: checkpoints.stream(caller),
		status: checkpoints.status(),
		liveRoots: lane.liveRoots,
	});
	checkpoints.retireRoute(caller, route.admissionId);
	const once = snapshot();
	expect(once).toEqual({
		stream: { sessionEpoch: lane.sessionEpoch, generation: 1, routes: [] },
		status: { open: 0, streams: 1, frozen: 1, reclaimed: 1, refused: {} },
		liveRoots: 0,
	});
	checkpoints.retireRoute(caller, route.admissionId);
	expect(snapshot(), "retire twice = retire once").toEqual(once);
	expect(await checkpoints.readActive(token, caller)).toEqual(unknownToken);
	checkpoints.release(token);
	expect(checkpoints.status()).toMatchObject({ open: 0, reclaimed: 1 });
	lane.retire("close");
	await lane.idle();
});

it("RULING-56 (4) an operation in flight on a retired route ends in a typed refusal, never a crash or a hang: its root goes once the read unwinds", async () => {
	const dir = await mkdtemp(join(tmpdir(), "senpi-4272-s08b-retire-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const control = controlledIo();
	const hold = control.hold("read", (path) => /[/\\]leaf-/.test(path));
	const checkpoints = owner();
	const lane = streamedLane({ dir, spillAboveBytes: 0, spillTargetBytes: 0, io: control.io });
	await lane.idle();
	const token = unwrap(checkpoints.freeze(route, lane)).token;
	const reading = checkpoints.readActive(token, caller);
	await hold.entered;
	checkpoints.retireRoute(caller, route.admissionId);
	checkpoints.retireRoute(caller, route.admissionId);
	expect(lane.liveRoots, "the read in flight defers the reclaim").toBe(1);
	hold.release();
	expect(await within(reading)).toEqual({ ok: false, failure: { kind: "repair_needed", reason: "released" } });
	expect(lane.liveRoots, "reclaimed once the read unwound").toBe(0);
	expect(checkpoints.status()).toMatchObject({ open: 0, reclaimed: 1 });
	lane.retire("close");
	await lane.idle();
});

it("review LOW the reclaimed counter counts only roots reclaimed without their holder's release", async () => {
	const dir = await mkdtemp(join(tmpdir(), "senpi-4272-s08b-count-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const control = controlledIo();
	const hold = control.hold("read", (path) => /[/\\]leaf-/.test(path));
	const checkpoints = owner();
	const lane = streamedLane({ dir, spillAboveBytes: 0, spillTargetBytes: 0, io: control.io });
	await lane.idle();
	const older = unwrap(checkpoints.freeze(route, lane)).token;
	const reading = checkpoints.readActive(older, caller);
	await hold.entered;
	checkpoints.release(older);
	const newer = unwrap(checkpoints.freeze(route, lane)).token;
	expect(checkpoints.status(), "the holder released it before the supersession").toMatchObject({
		open: 2,
		reclaimed: 0,
	});
	hold.release();
	expect(await within(reading)).toEqual({
		ok: false,
		failure: { kind: "repair_needed", reason: "superseded_token", newerGeneration: 2 },
	});
	expect(checkpoints.status()).toMatchObject({ open: 1, reclaimed: 0 });
	checkpoints.release(newer);
	expect(lane.liveRoots).toBe(0);
	lane.retire("close");
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
