import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import {
	type RecoveryCarrier,
	recoveryCarrier,
	SessionRecoveryIdentity,
	setSessionRecoveryEpoch,
} from "../../../src/core/session-recovery-identity.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { within } from "./4272-worker-acceptance-support.ts";

type Frame = { record: { type: string; message: { role: string; content: string } }; recovery: RecoveryCarrier };

it("same-epoch rebind preserves open messages, while a new epoch clears them", () => {
	const session = {};
	const identity = new SessionRecoveryIdentity("epoch", session);
	const assistant = { type: "message_start", message: { role: "assistant" } };
	const user = { type: "message_start", message: { role: "user" } };
	identity.observe(assistant);
	identity.observe(user);
	setSessionRecoveryEpoch(session, "epoch");
	const update = { type: "message_update", message: { role: "assistant" } };
	const userEnd = { type: "message_end", message: user.message };
	identity.observe(update);
	identity.observe(userEnd);
	expect(recoveryCarrier(update)).toEqual(recoveryCarrier(assistant));
	expect(recoveryCarrier(userEnd)).toEqual(recoveryCarrier(user));
	setSessionRecoveryEpoch(session, "new-epoch");
	const orphan = { type: "message_update", message: { role: "assistant" } };
	const newUserEnd = { type: "message_end", message: user.message };
	identity.observe(orphan);
	identity.observe(newUserEnd);
	expect(recoveryCarrier(orphan)).toBeUndefined();
	expect(recoveryCarrier(newUserEnd)?.epoch).toBe("new-epoch");
	expect(recoveryCarrier(newUserEnd)?.messageId).not.toBe(recoveryCarrier(user)?.messageId);
});

async function mint(epoch: string, workerFrame: boolean): Promise<Frame> {
	const record = { type: "message_end", message: { role: "user", content: "a direct terminal" } };
	if (!workerFrame) {
		new SessionRecoveryIdentity(epoch).observe(record);
		const recovery = recoveryCarrier(record);
		if (!recovery) throw new Error("no mint");
		return { record, recovery };
	}
	const worker = new Worker(
		`
		const { parentPort, workerData } = require("node:worker_threads");
		import(workerData.url).then(({ SessionRecoveryIdentity, recoveryCarrier }) => {
			const record = workerData.record;
			new SessionRecoveryIdentity(workerData.epoch).observe(record);
			parentPort.postMessage({ record, recovery: recoveryCarrier(record) });
		});
	`,
		{
			eval: true,
			workerData: {
				epoch,
				record,
				url: new URL("../../../src/core/session-recovery-identity.ts", import.meta.url).href,
			},
		},
	);
	const received = once(worker, "message");
	const exited = once(worker, "exit");
	try {
		const [frame] = await within("producer worker mint", received);
		expect((await within("producer worker exit", exited))[0]).toBe(0);
		return frame;
	} finally {
		await worker.terminate();
	}
}

// Part of #4272, RULING-24 conditions 1-4: the host nonce, not object identity, crosses the boundary.
for (const transport of ["in-process", "worker frame"] as const) {
	it(`R24.1 R24.2 R24.3 Q1 Q7 restart rejects old terminals and accepts a new start-less mint via ${transport}`, async () => {
		const lane = new SessionAcceptanceLane();
		lane.bootstrap({ transcript: [] });
		const oldNonce = lane.recoveryEpoch;
		const old = await mint(oldNonce, transport === "worker frame");
		lane.bootstrap({ transcript: [] });
		const current = await mint(lane.recoveryEpoch, transport === "worker frame");
		try {
			expect(lane.recoveryEpoch).not.toBe(oldNonce);
			expect(lane.accept(old.record, old.recovery)?.messageId).toBeNull();
			const accepted = lane.accept(current.record, current.recovery);
			expect(accepted?.messageId).toBe(current.recovery.messageId);
			expect(accepted?.sessionEpoch).not.toBe(current.recovery.epoch);
			const root = lane.freeze();
			expect(root.settled).toBeDefined();
			const before = await lane.readSettled(root);
			expect(before.settledMessages).toHaveLength(1);
			lane.accept(current.record, current.recovery);
			lane.accept(current.record, undefined);
			const after = lane.freeze();
			expect(await lane.readSettled(after)).toEqual(before);
			expect(JSON.stringify(current.record)).not.toContain(current.recovery.epoch);
			expect(JSON.stringify(current.record)).not.toContain(current.recovery.messageId);
		} finally {
			lane.retire("close");
			await lane.idle?.();
		}
	});
}

it("R24.4 S04a producer binds start/update/end and direct-terminal ids to the host bootstrap nonce", () => {
	const identity = new SessionRecoveryIdentity("host-nonce");
	const start = { type: "message_start", message: { role: "assistant" } };
	const update = { type: "message_update", message: { role: "assistant" } };
	const end = { type: "message_end", message: { role: "assistant" } };
	for (const event of [start, update, end]) identity.observe(event);
	expect(recoveryCarrier(start)).toMatchObject({ epoch: "host-nonce", messageId: expect.any(String) });
	expect(recoveryCarrier(update)).toEqual(recoveryCarrier(start));
	expect(recoveryCarrier(end)).toEqual(recoveryCarrier(start));
	identity.reset("next-host-nonce");
	const orphan = { type: "message_update", message: { role: "assistant" } };
	identity.observe(orphan);
	expect(recoveryCarrier(orphan)).toBeUndefined();
	const direct = { type: "message_end", message: { role: "assistant" } };
	identity.observe(direct);
	expect(recoveryCarrier(direct)?.epoch).toBe("next-host-nonce");
	expect(recoveryCarrier(direct)?.messageId).not.toBe(recoveryCarrier(start)?.messageId);
	expect(Object.keys(direct)).toEqual(["type", "message"]);
});
