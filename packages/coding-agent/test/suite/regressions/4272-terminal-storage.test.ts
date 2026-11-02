import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CompactStorageReadError, nodeCompactStorageIo } from "../../../src/modes/rpc/compact-storage-io.ts";
import { settledRig } from "./4272-settled-support.ts";

// Part of #4272, X03: both transcript refusal and spool refusal preserve all distinct terminals.
for (const fault of [false, true]) {
	it(`X03 C2.4 retains 260 failed 260000-byte terminals when spool ${fault ? "fails" : "spills"}`, async () => {
		const rig = await settledRig({
			spillAboveBytes: 128 * 1024,
			spillTargetBytes: 64 * 1024,
			...(fault
				? {
						io: {
							...nodeCompactStorageIo,
							writeFile: async () => {
								throw new Error("spool denied");
							},
						},
					}
				: {}),
		});
		try {
			const body = "x".repeat(260000);
			const ids = [];
			for (let i = 0; i < 260; i++) {
				const { carrier } = rig.end("toolResult", body);
				ids.push(carrier.messageId);
				rig.lane.accept({ type: "transcript_write_failed", errorMessage: "EACCES transcript" }, carrier);
			}
			await rig.lane.idle?.();
			const cut = await rig.cut();
			expect(cut.settledMessages.map((row) => row.messageId).sort()).toEqual(ids.sort());
			for (const row of cut.settledMessages) {
				expect(row).toMatchObject({
					status: "failed",
					error: { errorMessage: "EACCES transcript" },
					entryId: null,
				});
				expect(row.terminal).toMatchObject({ content: body });
			}
			const status = rig.lane.storageStatus();
			if (fault) {
				expect(status.spillHalted).toBe(true);
				expect(status.spillFailureRetainedBytes).toBeGreaterThan(260 * 260000);
				expect(status.failures.some((failure) => failure.cause.includes("spool denied"))).toBe(true);
			} else {
				expect(status.residentPayloadBytes).toBeLessThanOrEqual(64 * 1024);
				expect(status.basePages).toBeGreaterThan(0);
			}
		} finally {
			await rig.close();
		}
	}, 60000);
}

it("C2.4 Q7 spool failure never marks a pending row failed", async () => {
	const rig = await settledRig({
		spillAboveBytes: 0,
		spillTargetBytes: 0,
		io: {
			...nodeCompactStorageIo,
			writeFile: async () => {
				throw new Error("spool only");
			},
		},
	});
	try {
		rig.end();
		await rig.lane.idle?.();
		expect((await rig.cut()).settledMessages[0]).toMatchObject({ status: "pending", error: null });
		expect(rig.lane.storageStatus().spillHalted).toBe(true);
	} finally {
		await rig.close();
	}
});

it("C2.4 a missing committed leaf returns a typed read error without changing failed status", async () => {
	const rig = await settledRig({ spillAboveBytes: 0, spillTargetBytes: 0 });
	try {
		const { carrier } = rig.end();
		rig.lane.accept({ type: "transcript_write_failed", errorMessage: "transcript denied" }, carrier);
		await rig.lane.idle?.();
		const root = rig.lane.freeze();
		expect(root.settled).toBeDefined();
		const [spool] = await readdir(rig.dir);
		const files = await readdir(join(rig.dir, spool));
		const leaf = files.find((name) => name.startsWith("leaf-"));
		if (!leaf) throw new Error("no leaf was spilled");
		await unlink(join(rig.dir, spool, leaf));
		await expect(rig.lane.readSettled(root)).rejects.toBeInstanceOf(CompactStorageReadError);
		expect(rig.lane.storageStatus().failures.at(-1)?.operation).toBe("leaf_read");
		expect(rig.lane.freeze().sequence).toBe(root.sequence);
	} finally {
		await rig.close();
	}
});
