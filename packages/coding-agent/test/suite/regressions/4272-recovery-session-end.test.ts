import { afterEach, expect, it, vi } from "vitest";
import type { RecoveryRoute } from "../../../src/modes/rpc/compact-recovery-state.ts";
import type { RecoveryOutcome } from "../../../src/modes/rpc/compact-recovery-types.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { heldPeer } from "./4272-legacy-view-support.ts";
import { recoveryRig, streaming } from "./4272-recovery-support.ts";

// Part of #4272 (S08b, RULING-56 (2), RULING-50 (1)): a stream record lives while both its peer incarnation and its
// routing session do. A seal or forget ends a routing session for good (its handle is never reissued), so its records
// go on every peer; a detach keeps the record and its generation keeps rising on re-attach.

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const closeResponse = { type: "response", command: "close_session", success: true };

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

it("T1 T3 X03 RULING-56 (2) a close ends the routing session for good: its stream record goes at the seal, a token still mapped reads the typed session_closed while the queued attach view's root survives to delivery, and an unmapped one is unknown_token", async () => {
	vi.useFakeTimers({ now: 1_000 });
	const { writer, lane, checkpoints } = recoveryRig();
	const late = heldPeer(writer, "late");
	late.hold();
	writer.attachConnectionToSession("late", "s");
	const [token] = checkpoints.tokens();
	if (!token) return expect.unreachable();
	writer.closeSession("s", closeResponse, "client_close");
	expect(lane.retired).toBe(true);
	expect(lane.liveRoots, "the queued view's root survives the seal (RULING-51 Q2=A)").toBe(1);
	expect(
		checkpoints.stream(token.admission),
		"the sealed handle is never re-attached: its record is freed",
	).toBeUndefined();
	expect(checkpoints.status().streams).toBe(0);
	expect(await checkpoints.readActive(token, token.admission), "closing invalidates live token access").toEqual({
		ok: false,
		failure: { kind: "repair_needed", reason: "session_closed" },
	});
	late.release();
	await writer.flush();
	const index = (type: string) => late.lines.findIndex((line) => line.includes(`"type":"${type}"`));
	expect(index("message_start"), "the queued baseline was delivered").toBeGreaterThanOrEqual(0);
	expect(index("session_closed"), "after the baseline, the closed marker").toBeGreaterThan(index("message_start"));
	expect(checkpoints.open).toBe(0);
	expect(lane.liveRoots).toBe(0);
	writer.unregisterConnection("late");
	expect(await checkpoints.readActive(token, token.admission), "no record, no description").toEqual({
		ok: false,
		failure: { kind: "repair_needed", reason: "unknown_token" },
	});
	await lane.idle();
});

it("RULING-56 (2) a peer's end frees every stream record it holds: one record per session it attached, however often it detaches or meets a replacement", async () => {
	vi.useFakeTimers();
	const { writer, lane, checkpoints, attach, replace } = recoveryRig();
	const second = new SessionAcceptanceLane();
	second.bootstrap({ transcript: [] });
	writer.registerAcceptance("t", second);
	streaming(writer, second, "t");
	const held = heldPeer(writer, "held");
	const other = heldPeer(writer, "other");
	const onS = await attach(held);
	const onT = await attach(held, "held", "t");
	const others = await attach(other, "other");
	const records = () => [onS, onT].filter((admission) => checkpoints.stream(admission) !== undefined).length;
	for (let round = 0; round < 3; round++) {
		for (const sessionId of ["s", "t"]) writer.detachConnectionFromSession("held", sessionId);
		replace();
		await attach(held);
		await attach(held, "held", "t");
		expect(records(), "the bound: one record per session the peer attached").toBe(2);
		expect(checkpoints.status().streams, "held on s and t, other on s").toBe(3);
	}
	writer.unregisterConnection("held");
	expect(records(), "the peer's end freed every record it held").toBe(0);
	expect(checkpoints.tokens().filter(({ admission }) => admission.socketEpoch === onS.socketEpoch)).toEqual([]);
	expect(checkpoints.stream(others), "another peer's record is untouched").toBeDefined();
	expect(checkpoints.status()).toMatchObject({ open: 0, streams: 1 });
	writer.unregisterConnection("other");
	expect(checkpoints.status()).toMatchObject({ open: 0, streams: 0 });
	for (const retired of [lane, second]) {
		retired.retire("close");
		await retired.idle();
	}
});

it("RULING-56 (2) a session's end for good frees its stream records on every peer: a peer attaches four sessions, three end for good (a close, a park, a forget) and exactly one record remains", async () => {
	vi.useFakeTimers();
	const { writer, lane, checkpoints, attach } = recoveryRig();
	const lanes = ["t1", "t2", "t3"].map((sessionId) => {
		const added = new SessionAcceptanceLane();
		added.bootstrap({ transcript: [] });
		writer.registerAcceptance(sessionId, added);
		streaming(writer, added, sessionId);
		return added;
	});
	const held = heldPeer(writer, "held");
	const other = heldPeer(writer, "other");
	const onS = await attach(held);
	const ended = [await attach(held, "held", "t1"), await attach(held, "held", "t2"), await attach(held, "held", "t3")];
	const othersOnT1 = await attach(other, "other", "t1");
	expect(checkpoints.status().streams, "held on s, t1, t2, t3; other on t1").toBe(5);
	writer.closeSession("t1", closeResponse, "client_close");
	writer.parkSession("t2", "/sessions/t2.jsonl", "idle");
	writer.forgetSession("t3");
	for (const admission of [...ended, othersOnT1])
		expect(
			checkpoints.stream(admission),
			`${admission.sessionId} on ${admission.socketEpoch} ended for good`,
		).toBeUndefined();
	expect(checkpoints.stream(onS), "the live session keeps its record").toMatchObject({ generation: 1 });
	expect(checkpoints.status(), "exactly one record remains while the peers live").toMatchObject({
		open: 0,
		streams: 1,
	});
	writer.detachConnectionFromSession("held", "t1");
	writer.attachConnectionToSession("held", "t1");
	expect(checkpoints.tokens(), "a sealed handle never freezes again, so no record comes back").toEqual([]);
	expect(checkpoints.status().streams).toBe(1);
	writer.unregisterConnection("held");
	expect(checkpoints.status(), "the peer's end frees the last one").toMatchObject({ open: 0, streams: 0 });
	writer.unregisterConnection("other");
	for (const retired of [lane, ...lanes]) {
		retired.retire("close");
		await retired.idle();
	}
});

it("RULING-50 (1) RULING-56 (2) a session that is only closed for a peer (detached) and may be re-attached keeps its record: its generation keeps rising across re-attaches while another session's end frees only that session's record", async () => {
	vi.useFakeTimers();
	const { writer, lane, checkpoints, attach } = recoveryRig();
	const second = new SessionAcceptanceLane();
	second.bootstrap({ transcript: [] });
	writer.registerAcceptance("t", second);
	streaming(writer, second, "t");
	const held = heldPeer(writer, "held");
	const first = await attach(held);
	await attach(held, "held", "t");
	const generations = [first.generation];
	for (let round = 0; round < 3; round++) {
		writer.detachConnectionFromSession("held", "s");
		expect(checkpoints.stream(first), "a detach keeps the record").toMatchObject({ routes: [] });
		if (round === 1) writer.closeSession("t", closeResponse, "client_close");
		generations.push((await attach(held)).generation);
	}
	expect(generations, "one rising sequence on the kept record").toEqual([1, 2, 3, 4]);
	expect(checkpoints.stream(first)).toEqual({ sessionEpoch: lane.sessionEpoch, generation: 4, routes: ["attach-5"] });
	expect(checkpoints.status().streams, "only the ended session's record went").toBe(1);
	writer.unregisterConnection("held");
	for (const retired of [lane, second]) {
		retired.retire("close");
		await retired.idle();
	}
});

it("RULING-56 (2) a session's end frees its records on every peer, not its tokens: a token still mapped reads session_closed (or lane_retired after a worker failure) and its route's retirement still reclaims it", async () => {
	const { writer, lane, checkpoints } = recoveryRig();
	const failed = new SessionAcceptanceLane();
	failed.bootstrap({ transcript: [] });
	writer.registerAcceptance("t", failed);
	streaming(writer, failed, "t");
	const peer = { ...caller, socketEpoch: "socket-2" };
	const sCut = unwrap(checkpoints.freeze(route, lane));
	const peersCut = unwrap(checkpoints.freeze({ ...route, ...peer }, lane));
	const onT = unwrap(checkpoints.freeze({ ...route, sessionId: "t" }, failed)).token;
	failed.retire("worker_failed");
	for (const sessionId of ["s", "t"]) checkpoints.forgetSession(sessionId);
	lane.retire("close", new Set([sCut.root, peersCut.root]));
	expect(checkpoints.status(), "no record is left; the tokens keep their roots").toMatchObject({
		open: 3,
		streams: 0,
	});
	expect(await checkpoints.readActive(sCut.token, caller)).toEqual({
		ok: false,
		failure: { kind: "repair_needed", reason: "session_closed" },
	});
	expect(await checkpoints.readActive(onT, { ...caller, sessionId: "t" })).toEqual({
		ok: false,
		failure: { kind: "repair_needed", reason: "lane_retired" },
	});
	checkpoints.retireRoute(caller, route.admissionId);
	checkpoints.retireRoute(caller, route.admissionId);
	expect(checkpoints.status(), "the retired route's token is reclaimed once; the other peer's is not").toMatchObject({
		open: 2,
		reclaimed: 1,
	});
	expect(await checkpoints.readActive(sCut.token, caller), "no record, no description").toEqual({
		ok: false,
		failure: { kind: "repair_needed", reason: "unknown_token" },
	});
	for (const token of [peersCut.token, onT]) checkpoints.release(token);
	expect(checkpoints.open).toBe(0);
	for (const retired of [lane, failed]) await retired.idle();
});
