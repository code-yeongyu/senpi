import { chmodSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { recoveryCarrier, SessionRecoveryIdentity } from "../../../src/core/session-recovery-identity.ts";
import type { FrozenAcceptedRoot } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { creditOf, type OutputFrame, workerAcceptanceHost } from "./4272-worker-acceptance-support.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

// Part of #4272: real WorkerSessionRegistry + SessionWorkerClient, not only structuredClone.
it("T1 R24.1 R24.2 Q7 worker terminals join, failures survive, and replacement fences delayed old output", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const host = await workerAcceptanceHost();
	let file: string | undefined;
	let releaseSnapshot: (() => void) | undefined;
	try {
		const { sessionId, worker } = await host.open();
		const lane = worker.acceptance;
		if (!lane) throw new Error("no worker lane");
		file = host.registry.peek(sessionId)?.sessionPath;
		if (!file) throw new Error("no worker file");
		const cuts: FrozenAcceptedRoot[] = [];
		const enqueue = host.writer.enqueue.bind(host.writer);
		let stateResponse = false;
		vi.spyOn(host.writer, "enqueue").mockImplementation((id, record) => {
			if ("type" in record && record.type === "response" && "command" in record && record.command === "get_state")
				stateResponse = true;
			if ("type" in record && record.type === "message_end" && "message" in record) {
				const role = Reflect.get(Object(record.message), "role");
				if (role === "user" || role === "assistant") cuts.push(lane.freeze());
			}
			return enqueue(id, record);
		});
		const prompt = async (message: string) => {
			const done = host.next("worker terminal", (record) => record.type === "agent_idle");
			expect((await host.request({ type: "prompt", sessionId, message })).success).toBe(true);
			await done;
			await host.writer.flush();
		};
		await prompt("first");
		expect(cuts).toHaveLength(2);
		for (const cut of cuts) {
			expect(cut.settled).toBeDefined();
			expect((await lane.readSettled(cut)).settledMessages.at(-1)?.status).toBe("pending");
		}
		const joined = await lane.readSettled(lane.freeze());
		expect(joined.settledMessages).toEqual([]);
		expect(joined.owners.length).toBeGreaterThanOrEqual(2);
		const old = host.frames.find(({ frame }) => "type" in frame.record && frame.record.type === "message_end")?.frame;
		if (!old?.recovery) throw new Error("worker did not carry the minted owner");
		expect(old.recovery.epoch).toBe(lane.recoveryEpoch);
		expect(JSON.stringify(host.records)).not.toContain(lane.recoveryEpoch);
		chmodSync(file, 0o444);
		await prompt("refused");
		const failed = await lane.readSettled(lane.freeze());
		expect(failed.settledMessages).toHaveLength(2);
		expect(
			failed.settledMessages.every((row) => row.status === "failed" && row.error?.errorMessage.includes("EACCES")),
		).toBe(true);
		chmodSync(file, 0o644);
		expect((await host.request({ type: "new_session", sessionId })).success).toBe(true);
		expect(lane.recoveryEpoch).not.toBe(old.recovery.epoch);
		const replacementStart = host.frames.length;
		await prompt("after replacement");
		const newEnds = host.frames
			.slice(replacementStart)
			.filter(({ frame }) => "type" in frame.record && frame.record.type === "message_end");
		expect(newEnds.length).toBeGreaterThan(0);
		expect(newEnds.every(({ frame }) => frame.recovery?.epoch === lane.recoveryEpoch)).toBe(true);
		// Hold the snapshot after get_state's response: exchange() blocks the actual worker on this
		// unreturned credit, so it cannot race synthetic output. Terminate it before releasing the hold.
		const held = host.holdReconcile((message) => stateResponse && message?.type === "snapshot");
		releaseSnapshot = held.release;
		expect((await host.request({ type: "get_state", sessionId })).success).toBe(true);
		await held.reached;
		const deliver = async (record: object, recovery: OutputFrame["recovery"]) => {
			const ordinal: unknown = Reflect.get(worker, "expectedOrdinal");
			if (typeof ordinal !== "number") throw new Error("missing client ordinal seam");
			const frame: OutputFrame = {
				type: "output",
				ordinal,
				record,
				recovery,
				signal: new SharedArrayBuffer(4),
				activity: { busy: false, streaming: false },
			};
			worker.worker.emit("message", frame);
			expect(await creditOf(frame.signal)).toBe(1);
		};
		await deliver(old.record, old.recovery);
		expect((await lane.readSettled(lane.freeze())).settledMessages).toEqual([]);
		const terminal = { type: "message_end", message: { role: "user", content: "new direct terminal" } };
		new SessionRecoveryIdentity(lane.recoveryEpoch).observe(terminal);
		await deliver(terminal, recoveryCarrier(terminal));
		const accepted = await lane.readSettled(lane.freeze());
		expect(accepted.settledMessages).toHaveLength(1);
		await deliver(terminal, recoveryCarrier(terminal));
		await deliver(terminal, undefined);
		expect(await lane.readSettled(lane.freeze())).toEqual(accepted);
		expect(host.failures).toEqual([]);
		expect(lane.retired).toBe(false);
	} finally {
		if (file) chmodSync(file, 0o644);
		await host.dispose();
		releaseSnapshot?.();
	}
}, 90000);
