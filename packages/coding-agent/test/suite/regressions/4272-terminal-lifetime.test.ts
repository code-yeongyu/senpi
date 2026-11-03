import { afterEach, expect, it, vi } from "vitest";
import { settledRig } from "./4272-settled-support.ts";

afterEach(() => vi.unstubAllEnvs());

// Part of #4272, ruling 12 Q5: transcript navigation is not explicit session clear.
it("C2.3 Q5 leaf moves, branches, edits and compaction preserve failed overlays", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const rig = await settledRig();
	try {
		const id = rig.manager.appendMessage({ role: "user", content: "durable context", timestamp: 1 });
		rig.lane.applyTranscript(rig.manager.drainTranscript());
		const { carrier } = rig.end("assistant", "refused content");
		rig.lane.accept({ type: "transcript_write_failed", errorMessage: "denied" }, carrier);
		const failed = (await rig.cut()).settledMessages;
		for (const action of [
			() => rig.manager.branch(id),
			() => rig.manager.resetLeaf(),
			() => rig.manager.branch(id),
			() => rig.manager.appendContextEdit(id, { content: "edited" }),
			() => rig.manager.appendCompaction("summary", id, 100),
		]) {
			action();
			rig.lane.applyTranscript(rig.manager.drainTranscript());
			expect((await rig.cut()).settledMessages).toEqual(failed);
		}
	} finally {
		await rig.close();
	}
});

for (const reason of ["close", "worker_failed"] as const) {
	it(`C2.3 Q5 ${reason} retires failed content and every held root`, async () => {
		const rig = await settledRig();
		try {
			const { carrier } = rig.end();
			rig.lane.accept({ type: "transcript_write_failed", errorMessage: "denied" }, carrier);
			const cut = await rig.cut();
			expect(cut.settledMessages[0]?.status).toBe("failed");
			rig.lane.retire(reason);
			await rig.lane.idle();
			expect(rig.lane.liveRoots).toBe(0);
			expect(() => rig.lane.readSettled(cut.root)).toThrow("accepted root released");
			expect(rig.lane.accept({ type: "message_end" }, carrier)).toBeUndefined();
		} finally {
			await rig.close();
		}
	});
}

it("C2.2 C2.4 one thousand joined messages leave zero payload residency", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	// #4756: exercise the real compactor and ownership graph without serial filesystem round trips.
	// This claim is payload lifetime, not disk throughput; retain exact backing bytes and range reads.
	const files = new Map<string, Buffer>();
	const rig = await settledRig({
		io: {
			async writeFile(path, data) {
				files.set(path, Buffer.from(data));
			},
			async readFile(path, range) {
				const data = files.get(path);
				if (!data) throw new Error("missing backing file");
				return Buffer.from(range ? data.subarray(range.offset, range.offset + range.length) : data);
			},
			async unlink(path) {
				files.delete(path);
			},
		},
	});
	try {
		for (let index = 0; index < 1000; index++) {
			const { carrier } = rig.end();
			rig.manager.appendOwnedMessage(
				{ role: "user", content: "terminal", timestamp: 1 },
				{ recoveryOwner: carrier },
			);
			rig.lane.applyTranscript(rig.manager.drainTranscript());
		}
		await rig.lane.idle?.();
		const cut = await rig.cut();
		expect(cut.settledMessages).toEqual([]);
		expect(cut.owners).toHaveLength(1000);
		expect(rig.lane.storageStatus().residentPayloadBytes).toBe(0);
		expect(rig.lane.storageStatus().overrideSlots).toBeLessThan(128);
	} finally {
		await rig.close();
	}
}, 30000);
