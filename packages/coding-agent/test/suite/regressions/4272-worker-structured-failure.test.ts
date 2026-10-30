import { afterEach, expect, it, vi } from "vitest";
import type { SessionWorkerToHost } from "../../../src/modes/rpc/session-worker-protocol.ts";
import { builtFauxPath, workerAcceptanceHost } from "./4272-worker-acceptance-support.ts";

afterEach(() => {
	vi.unstubAllEnvs();
});

/**
 * Runs inside the isolate only: serializing any record that carries a block seed throws. Only the structured lane's
 * seeded projections carry `seed`, so every seeded structured record fails on the isolate's real structured path
 * (the pairing's JSON boundary) while legacy records serialize as before.
 */
const seededRecordsFail = `
const stringify = JSON.stringify;
const seeded = (value) =>
	value !== null && typeof value === "object" && typeof value.assistantMessageEvent === "object" &&
	value.assistantMessageEvent !== null && "seed" in value.assistantMessageEvent;
JSON.stringify = function (value, ...rest) {
	if (seeded(value)) throw new Error("structured record failed in the isolate");
	return stringify.call(this, value, ...rest);
};`;

// senpi#4439 delta LOW-2 and LOW-3 (carry items 24.2, 24.3): a structured failure inside a real isolate travels
// structuredFailed -> WorkerEventWriter.canonicalUnavailable -> the host lane, once per epoch however many records fail,
// and every legacy record is still delivered.
it("a real isolate's structured failures make the host lane unavailable with one frame and keep legacy delivery", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const host = await workerAcceptanceHost(builtFauxPath, seededRecordsFail);
	try {
		const { sessionId, worker } = await host.open();
		const lane = worker.acceptance;
		if (!lane) throw new Error("no worker lane");
		const unavailable: string[] = [];
		worker.worker.on("message", (message: SessionWorkerToHost) => {
			if (message.type === "canonical_unavailable") unavailable.push(message.reason);
		});
		for (const message of ["first", "second"]) {
			const done = host.next(`idle after ${message}`, (record) => record.type === "agent_idle");
			expect((await host.request({ type: "prompt", sessionId, message })).success).toBe(true);
			await done;
		}
		await host.writer.flush();
		expect(unavailable).toEqual(["structured record failed in the isolate"]);
		const ends = host.records.filter((record) => record.type === "message_end");
		expect(JSON.stringify(ends).split("an answer streamed in a few deltas").length - 1).toBe(2);
		expect(host.failures).toEqual([]);
		expect(lane.retired).toBe(false);
		const root = lane.freeze();
		try {
			expect(root.current).toBeUndefined();
		} finally {
			lane.release(root);
		}
	} finally {
		await host.dispose();
	}
}, 90_000);
