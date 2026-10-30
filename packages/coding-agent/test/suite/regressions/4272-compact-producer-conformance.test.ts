import { afterEach, expect, it, vi } from "vitest";
import type { SessionWorkerToHost } from "../../../src/modes/rpc/session-worker-protocol.ts";
import { expectOneNumbering, recordFolds } from "./4272-compact-lane-support.ts";
import { builtFauxPath, workerAcceptanceHost } from "./4272-worker-acceptance-support.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

// senpi#4272 RULING-36 adopted test, RULING-40: on a real worker the compact ordinal IS the S04a frame ordinal, the
// epoch IS the S05 nonce the host sent at commit, and firstOrdinal is the producer's own binding carried in the frame.
it("RULING-36 one numbering: worker frame ordinal, S05 nonce and producer firstOrdinal reach the compact owner", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const folds = recordFolds();
	const host = await workerAcceptanceHost(builtFauxPath);
	try {
		const { sessionId, worker } = await host.open();
		const lane = worker.acceptance;
		if (!lane) throw new Error("no worker lane");
		const frames: { ordinal?: number; firstOrdinal?: number; recovery?: object; canonical?: object }[] = [];
		worker.worker.on("message", (message: SessionWorkerToHost) => {
			if (message.type === "output") frames.push(message);
			if (message.type === "canonical") frames.push({ ...message, canonical: message.record });
		});
		const done = host.next("idle", (record) => record.type === "agent_idle");
		expect((await host.request({ type: "prompt", sessionId, message: "go" })).success).toBe(true);
		await done;
		await host.writer.flush();
		expectOneNumbering(folds, lane.recoveryEpoch);
		expect(folds.some(({ t }) => t.type === "seeded_block")).toBe(true);
		for (const { t } of folds) {
			const frame = frames.find((each) => each.ordinal === t.ordinal);
			expect(frame?.canonical, `frame ${t.ordinal} carries the folded record`).toBeDefined();
			expect(frame?.recovery).toMatchObject({ messageId: t.messageId, epoch: t.epoch });
			expect(frame?.firstOrdinal).toBe(t.firstOrdinal);
		}
		const root = lane.freeze();
		try {
			const { messages } = await lane.readCurrent(root);
			const answer = messages.find((message) => message.message?.role === "assistant");
			expect(answer?.blocks.map((block) => block.text).join("")).toBe("an answer streamed in a few deltas");
		} finally {
			lane.release(root);
		}
		expect(host.failures).toEqual([]);
	} finally {
		await host.dispose();
	}
}, 90000);
