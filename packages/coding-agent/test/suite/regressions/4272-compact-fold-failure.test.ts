import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { CanonicalPairing } from "../../../src/modes/rpc/compact-canonical-pairing.ts";
import type { CanonicalRecord } from "../../../src/modes/rpc/compact-lane-transitions.ts";
import { COMPACT_PROTOCOL_MAX_DEPTH } from "../../../src/modes/rpc/compact-protocol-depth.ts";
import { RpcSessionRegistry, type RpcSessionEntry } from "../../../src/modes/rpc/session-registry.ts";
import { SessionWorkerClient } from "../../../src/modes/rpc/session-worker-client.ts";
import { type SessionWorkerToHost, WORKER_CREDIT_CODES } from "../../../src/modes/rpc/session-worker-protocol.ts";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";
import { creditOf, type OutputFrame, within, workerAcceptanceHost } from "./4272-worker-acceptance-support.ts";

const FLAG = "SENPI_ENGINE_SOCKET_COMPACT_UPDATES";
/** A canonical record as a worker frame could carry it: parsed JSON the lane's transition mapping cannot read. */
const malformed = (): CanonicalRecord => JSON.parse('{"type":"message_update"}');

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

// senpi#4439 review LOW-3: a fold that fails while building its transition costs only the compact component; the
// legacy record of the same unit still reaches the writer, on the in-process binding and on a worker frame alike.
it("in process: a malformed canonical record leaves compact unavailable and its legacy record delivered", async () => {
	vi.stubEnv(FLAG, "1");
	await using host = await statusHost();
	const admissions = vi.spyOn(RpcSessionRegistry.prototype, "getForCommand");
	const client = host.client("fold");
	const sessionId = String(dataOf(await client.request({ type: "open_session", cwd: host.cwd })).sessionId);
	const entry = admissions.mock.results.findLast((result) => result.type === "return")?.value as
		| RpcSessionEntry
		| undefined;
	const lane = entry?.acceptance;
	if (!lane) throw new Error("no real lane");
	let poisoned: object | undefined;
	const take = CanonicalPairing.prototype.take;
	vi.spyOn(CanonicalPairing.prototype, "take").mockImplementation(function (this: CanonicalPairing, legacy) {
		const canonical = take.call(this, legacy);
		if (poisoned || !canonical || Reflect.get(legacy, "type") !== "message_start") return canonical;
		poisoned = legacy;
		return malformed();
	});
	const enqueue = vi.spyOn(host.writer, "enqueue");
	host.faux.setResponses([fauxAssistantMessage("answer after a failed fold", { timestamp: 1 })]);
	const done = client.waitFor((record) => record.type === "agent_idle", 15_000);
	dataOf(await client.request({ type: "prompt", sessionId, message: "first" }));
	await done;
	await host.writer.flush();
	expect(poisoned, "the binding paired a canonical record with a legacy message_start").toBeDefined();
	expect(enqueue.mock.calls.some(([, record]) => record === poisoned)).toBe(true);
	expect(JSON.stringify(client.inbox)).toContain("answer after a failed fold");
	const root = lane.freeze();
	try {
		expect(root.current).toBeUndefined();
	} finally {
		lane.release(root);
	}
}, 60_000);

async function workerLane() {
	vi.stubEnv(FLAG, "1");
	const host = await workerAcceptanceHost();
	const { worker } = await host.open();
	const lane = worker.acceptance;
	if (!lane) throw new Error("flag on: the worker client owns an acceptance lane");
	const before = lane.freeze();
	expect(before.current, "a committed incarnation starts with compact state").toBeDefined();
	lane.release(before);
	const ordinal = (): number => {
		const next: unknown = Reflect.get(worker, "expectedOrdinal");
		if (typeof next !== "number") throw new Error("missing client ordinal seam");
		return next;
	};
	const deliver = (message: SessionWorkerToHost & { signal: SharedArrayBuffer }) => {
		worker.worker.emit("message", message);
		return within("credit", creditOf(message.signal));
	};
	return { host, worker, lane, ordinal, deliver };
}

it("worker: a frame whose canonical record is malformed is credited, delivered, and leaves compact unavailable", async () => {
	const { host, lane, ordinal, deliver } = await workerLane();
	try {
		const starts = () => host.records.filter((record) => record.type === "agent_start").length;
		const before = starts();
		const at = ordinal();
		const frame: OutputFrame = {
			type: "output",
			ordinal: at,
			firstOrdinal: at,
			record: { type: "agent_start" },
			recovery: { messageId: "m-malformed", epoch: lane.recoveryEpoch },
			canonical: malformed(),
			signal: new SharedArrayBuffer(4),
			activity: { busy: false, streaming: false },
		};
		expect(await deliver(frame)).toBe(WORKER_CREDIT_CODES.granted);
		await host.writer.flush();
		expect(starts()).toBe(before + 1);
		expect(host.failures).toEqual([]);
		expect(lane.retired).toBe(false);
		const root = lane.freeze();
		expect(root.current).toBeUndefined();
		lane.release(root);
	} finally {
		await host.dispose();
	}
}, 60_000);

// senpi#4439 review LOW-4, worker half: a structured-path failure inside the isolate reaches the host lane in order.
it("worker: a canonical_unavailable frame takes its ordinal and makes the epoch's compact state unavailable", async () => {
	const { host, lane, ordinal, deliver } = await workerLane();
	try {
		const signal = new SharedArrayBuffer(4);
		const frame: SessionWorkerToHost = { type: "canonical_unavailable", ordinal: ordinal(), reason: "x", signal };
		expect(await deliver(frame)).toBe(WORKER_CREDIT_CODES.granted);
		expect(host.failures).toEqual([]);
		const root = lane.freeze();
		expect(root.current).toBeUndefined();
		lane.release(root);
	} finally {
		await host.dispose();
	}
}, 60_000);

// senpi#4272 RULING-59 C, worker half: a canonical record the isolate refused at the protocol depth limit is counted
// on the host lane, whose compact state stays available.
it("worker: a canonical_unavailable frame carrying the depth limit keeps the epoch's compact state", async () => {
	const { host, lane, ordinal, deliver } = await workerLane();
	const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	try {
		const signal = new SharedArrayBuffer(4);
		const reason = `compact write refused (unsupported_value: depth above ${COMPACT_PROTOCOL_MAX_DEPTH})`;
		const frame: SessionWorkerToHost = {
			type: "canonical_unavailable",
			ordinal: ordinal(),
			reason,
			limit: COMPACT_PROTOCOL_MAX_DEPTH,
			signal,
		};
		expect(await deliver(frame)).toBe(WORKER_CREDIT_CODES.granted);
		expect(host.failures).toEqual([]);
		const root = lane.freeze();
		expect(root.current).toBeDefined();
		lane.release(root);
		expect(lane.storageStatus().refusedRecords).toBe(1);
		expect(write.mock.calls.map(([chunk]) => String(chunk))).toContain(
			`senpi rpc acceptance: compact record refused: unsupported_value (depth above ${COMPACT_PROTOCOL_MAX_DEPTH})\n`,
		);
	} finally {
		await host.dispose();
	}
}, 60_000);

// senpi#4557 review round 2, LOW-2, worker half: a depth refusal framed after a real loss is still counted by the host.
it("worker: a depth-limit frame after a real loss is counted and the state stays ended", async () => {
	const { host, lane, ordinal, deliver } = await workerLane();
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	try {
		const limit = COMPACT_PROTOCOL_MAX_DEPTH;
		const loss = (frame: { reason: string; limit?: number }): Extract<SessionWorkerToHost, { signal: unknown }> => ({
			type: "canonical_unavailable",
			ordinal: ordinal(),
			...frame,
			signal: new SharedArrayBuffer(4),
		});
		expect(await deliver(loss({ reason: "a real loss" }))).toBe(WORKER_CREDIT_CODES.granted);
		const reason = `compact write refused (unsupported_value: depth above ${limit})`;
		expect(await deliver(loss({ reason, limit }))).toBe(WORKER_CREDIT_CODES.granted);
		expect(host.failures).toEqual([]);
		expect(lane.storageStatus().refusedRecords).toBe(1);
		const root = lane.freeze();
		expect(root.current).toBeUndefined();
		lane.release(root);
	} finally {
		await host.dispose();
	}
}, 60_000);

// senpi#4557 review LOW-2, worker half: the output frame of an event whose canonical record the isolate refused says
// so, and its legacy record (a terminal too deep for the settled store) folds nothing and is not counted again.
it("worker: an event refused on both projections is counted once and its terminal is not settled", async () => {
	const { host, lane, ordinal, deliver } = await workerLane();
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	try {
		let content: unknown = "leaf";
		for (let level = 0; level < 2_000; level++) content = [content];
		const limit = COMPACT_PROTOCOL_MAX_DEPTH;
		const refusal: SessionWorkerToHost = {
			type: "canonical_unavailable",
			ordinal: ordinal(),
			reason: `compact write refused (unsupported_value: depth above ${limit})`,
			limit,
			signal: new SharedArrayBuffer(4),
		};
		expect(await deliver(refusal)).toBe(WORKER_CREDIT_CODES.granted);
		const at = ordinal();
		const frame: OutputFrame = {
			type: "output",
			ordinal: at,
			record: { type: "message_end", message: { role: "toolResult", toolCallId: "c1", content, timestamp: 1 } },
			recovery: { messageId: "m-deep", epoch: lane.recoveryEpoch },
			canonicalRefused: true,
			signal: new SharedArrayBuffer(4),
			activity: { busy: false, streaming: false },
		};
		expect(await deliver(frame)).toBe(WORKER_CREDIT_CODES.granted);
		await host.writer.flush();
		expect(host.failures).toEqual([]);
		expect(lane.storageStatus().refusedRecords).toBe(1);
		const root = lane.freeze();
		try {
			expect(root.current).toBeDefined();
			const { settledMessages } = await lane.readSettled(root);
			expect(settledMessages.map((message) => message.messageId)).not.toContain("m-deep");
		} finally {
			lane.release(root);
		}
	} finally {
		await host.dispose();
	}
}, 60_000);

// senpi#4439 review LOW-5: a canonical-only frame is credited under the same condition as an output frame.
it("an unbound client denies a canonical frame exactly as it denies an output frame", async () => {
	vi.stubEnv(FLAG, "1");
	const client = new SessionWorkerClient({
		reserve: () => "granted",
		reconcile: () => {},
		exit: () => {},
		failure: () => {},
	});
	try {
		const signal = new SharedArrayBuffer(4);
		const record: CanonicalRecord = {
			type: "message_block_state",
			contentIndex: 0,
			phase: "insert",
			block: { type: "text", text: "" },
		};
		const recovery = { messageId: "m", epoch: "e" };
		const frame: SessionWorkerToHost = { type: "canonical", ordinal: 0, firstOrdinal: 0, recovery, record, signal };
		client.worker.emit("message", frame);
		expect(await within("canonical credit", creditOf(signal))).toBe(WORKER_CREDIT_CODES.conflict);
		const output: OutputFrame = {
			type: "output",
			ordinal: 0,
			record: { type: "agent_start" },
			signal: new SharedArrayBuffer(4),
			activity: { busy: false, streaming: false },
		};
		client.worker.emit("message", output);
		expect(await within("output credit", creditOf(output.signal))).toBe(WORKER_CREDIT_CODES.conflict);
	} finally {
		client.quarantine();
		await client.exited;
	}
});
