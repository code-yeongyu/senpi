import { truncateSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { recoveryCarrier } from "../../../src/core/session-recovery-identity.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { readTranscriptRoot } from "../../../src/modes/rpc/accepted-transcript.ts";
import type { RecoveryRoute } from "../../../src/modes/rpc/compact-recovery-state.ts";
import type { RecoveryOutcome } from "../../../src/modes/rpc/compact-recovery-types.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { callsRig } from "./4272-calls-support.ts";
import { settledRig } from "./4272-settled-support.ts";

// Part of #4272 (S08a, R3.C1.2-C1.5): one complete cut C is pinned synchronously for one admission and its token
// names the accepted identities; every component the cut holds survives what is accepted after it.

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

const owner = () => new SessionEventWriter(() => {}).recoveryCheckpoints;

const route = (sessionId = "s"): RecoveryRoute => ({
	socketEpoch: "socket-1",
	admissionId: "attach-1",
	routeKind: "ordinary",
	peer: "peer",
	sessionId,
});
const caller = { socketEpoch: "socket-1", sessionId: "s" };

function unwrap<T>(outcome: RecoveryOutcome<T>): T {
	if (!outcome.ok) throw new Error(`refused: ${JSON.stringify(outcome.failure)}`);
	return outcome.value;
}

it("T1 T5 a cut frozen after an accepted end and before its append keeps that representation while later appends, failures and messages are accepted", async () => {
	const rig = await settledRig();
	try {
		const checkpoints = owner();
		const first = rig.end("user", "first");
		const token = unwrap(checkpoints.freeze(route(), rig.lane)).token;
		expect(token).toMatchObject({
			kind: "checkpoint",
			admission: { ...route(), sessionEpoch: rig.lane.sessionEpoch, generation: 1 },
			cut: { sessionEpoch: rig.lane.sessionEpoch, activeMessageId: null, turnId: null },
		});
		expect(token.cut.sequence).toBe(1);
		const held = checkpoints.readSettled(token, caller);
		// Accepted while the first read is in flight: the owned append, a failed write and a new message.
		rig.lane.applyTranscript([
			{
				kind: "append",
				id: "e1",
				entry: JSON.stringify({ type: "message", id: "e1", message: first.record.message }),
				owningMessageId: first.carrier.messageId,
				recoveryEpoch: rig.lane.recoveryEpoch,
			},
		]);
		const second = rig.end("user", "second");
		rig.lane.accept({ type: "transcript_write_failed", errorMessage: "EACCES" }, second.carrier);
		const third = rig.end("user", "third");
		await rig.lane.idle();
		const status = (rows: readonly { messageId: string; status: unknown }[]) =>
			Object.fromEntries(rows.map((row) => [row.messageId, row.status]));
		const atC = unwrap(await held);
		expect(status(atC.settledMessages)).toEqual({ [first.carrier.messageId]: "pending" });
		expect(atC.owners).toEqual([]);
		const later = unwrap(checkpoints.freeze(route(), rig.lane)).token;
		expect(later.admission.generation).toBe(2);
		expect(later.cut.sequence).toBeGreaterThan(token.cut.sequence);
		const now = unwrap(await checkpoints.readSettled(later, caller));
		expect(status(now.settledMessages)).toEqual({
			[second.carrier.messageId]: "failed",
			[third.carrier.messageId]: "pending",
		});
		expect(now.owners).toMatchObject([{ messageId: first.carrier.messageId, entryId: "e1" }]);
		checkpoints.release(token);
		checkpoints.release(later);
		expect(rig.lane.liveRoots).toBe(0);
		expect(checkpoints.open).toBe(0);
	} finally {
		await rig.close();
	}
});

it("T1 T3 X03 a cut with a null active message, a failed terminal and an executing call keeps each component independently", async () => {
	const rig = await callsRig();
	try {
		const checkpoints = owner();
		rig.record({ type: "turn_start" });
		const owning = rig.start();
		const call = fauxToolCall("bash", { command: "ls" }, { id: "call-a" });
		rig.toolStart(owning, 0, call, "bash");
		rig.toolEnd(owning, 0, call, "bash");
		rig.end(owning, [call]);
		rig.record({ type: "tool_execution_start", toolCallId: "call-a", toolName: "bash", args: { command: "ls" } });
		const late = { type: "message_end", message: { role: "user", content: "late", timestamp: 1 } };
		rig.producer.observe(late);
		const failed = recoveryCarrier(late);
		if (!failed) throw new Error("producer failed to mint");
		rig.lane.accept(late, failed);
		rig.lane.accept({ type: "transcript_write_failed", errorMessage: "EACCES" }, failed);
		const token = unwrap(checkpoints.freeze(route(), rig.lane)).token;
		expect(token.cut.activeMessageId).toBeNull();
		// A later assistant message must not reach the cut.
		rig.start();
		await rig.lane.idle();
		const active = unwrap(await checkpoints.readActive(token, caller));
		const calls = unwrap(await checkpoints.readCalls(token, caller));
		const settled = unwrap(await checkpoints.readSettled(token, caller));
		expect(active).toEqual([]);
		expect(calls.calls.map((entry) => [entry.toolCallId, entry.phase])).toEqual([["call-a", "executing"]]);
		expect(settled.settledMessages.find((row) => row.messageId === failed.messageId)?.status).toBe("failed");
		const later = unwrap(checkpoints.freeze(route(), rig.lane)).token;
		expect(later.cut.activeMessageId).not.toBeNull();
		expect(unwrap(await checkpoints.readActive(later, caller))).toHaveLength(1);
		checkpoints.release(token);
		checkpoints.release(later);
		expect(rig.lane.liveRoots).toBe(0);
	} finally {
		await rig.close();
	}
});

it("T5 the pinned transcript keeps its version, leaf and ids across a later branch, and a rewritten file is a typed failure, never current history", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const dir = await mkdtemp(join(tmpdir(), "senpi-4272-s08a-"));
	const manager = SessionManager.create(dir, dir);
	try {
		const checkpoints = owner();
		const firstId = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		await manager.persistHeaderNow();
		const pinnedFile = String(manager.getSessionFile());
		const lane = new SessionAcceptanceLane();
		lane.bootstrap({ transcript: manager.beginTranscriptJournal() });
		const token = unwrap(checkpoints.freeze(route(), lane)).token;
		const pinned = unwrap(checkpoints.transcript(token, caller));
		expect(pinned.leafId).toBe(firstId);
		expect(pinned.tail.persistence?.fileIdentity.path, "the captured identity names the pinned file").toBe(
			pinnedFile,
		);
		expect(token.cut).toMatchObject({ historyVersion: pinned.historyVersion, leafId: firstId });
		manager.createBranchedSession(firstId);
		manager.appendMessage({ role: "user", content: "branched", timestamp: 2 });
		await manager.persistHeaderNow();
		lane.applyTranscript(manager.drainTranscript());
		const after = unwrap(checkpoints.freeze(route(), lane)).token;
		expect(after.cut.historyVersion).toBeGreaterThan(token.cut.historyVersion);
		expect(checkpoints.transcript(token, caller), "one token per stream: the newer cut supersedes").toEqual({
			ok: false,
			failure: { kind: "repair_needed", reason: "superseded_token", newerGeneration: 2 },
		});
		const read = readTranscriptRoot(pinned);
		expect(read.ok && read.entries.filter((entry) => entry.type === "message").map((entry) => entry.id)).toEqual([
			firstId,
		]);
		expect(String(manager.getSessionFile())).not.toBe(pinnedFile);
		truncateSync(pinnedFile, 0);
		expect(readTranscriptRoot(pinned)).toEqual({ ok: false, error: "base_file_truncated" });
		checkpoints.release(token);
		checkpoints.release(after);
		expect(lane.liveRoots).toBe(0);
		lane.retire("close");
		await lane.idle();
	} finally {
		manager.dispose();
		await rm(dir, { recursive: true, force: true });
	}
});

it("RULING-50 (3) the pinned transcript root is not reclaimed while its token is live: other tokens' releases, another peer's forget and later history leave it readable for S11", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const dir = await mkdtemp(join(tmpdir(), "senpi-4272-s08a-live-"));
	const manager = SessionManager.create(dir, dir);
	try {
		const checkpoints = owner();
		const firstId = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		await manager.persistHeaderNow();
		const lane = new SessionAcceptanceLane();
		lane.bootstrap({ transcript: manager.beginTranscriptJournal() });
		const token = unwrap(checkpoints.freeze(route(), lane)).token;
		const pinned = unwrap(checkpoints.transcript(token, caller));
		const foreign = unwrap(checkpoints.freeze({ ...route(), socketEpoch: "socket-2" }, lane)).token;
		const sibling = unwrap(checkpoints.freeze(route("t"), lane)).token;
		checkpoints.release(sibling);
		checkpoints.forgetPeer("socket-2");
		manager.appendMessage({ role: "user", content: "later", timestamp: 2 });
		lane.applyTranscript(manager.drainTranscript());
		expect(lane.liveRoots, "only the live token's root stays pinned").toBe(1);
		expect(unwrap(checkpoints.transcript(token, caller)), "the same pinned root, not a newer one").toBe(pinned);
		const read = readTranscriptRoot(pinned);
		expect(read.ok && read.entries.filter((entry) => entry.type === "message").map((entry) => entry.id)).toEqual([
			firstId,
		]);
		expect(checkpoints.transcript(foreign, { ...caller, socketEpoch: "socket-2" })).toEqual({
			ok: false,
			failure: { kind: "repair_needed", reason: "unknown_token" },
		});
		checkpoints.release(token);
		expect(lane.liveRoots).toBe(0);
		lane.retire("close");
		await lane.idle();
	} finally {
		manager.dispose();
		await rm(dir, { recursive: true, force: true });
	}
});

it("T5 an unavailable transcript component is a storage_unavailable failure of the token, not a current-disk read", () => {
	const checkpoints = owner();
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: [{ kind: "unavailable", reason: "transcript_tail_trimmed" }] });
	const token = unwrap(checkpoints.freeze(route(), lane)).token;
	expect(checkpoints.transcript(token, caller)).toEqual({
		ok: false,
		failure: { kind: "storage_unavailable", reason: "transcript_tail_trimmed" },
	});
	checkpoints.release(token);
	lane.retire("close");
});
