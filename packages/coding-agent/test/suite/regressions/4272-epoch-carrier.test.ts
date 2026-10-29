import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { recoveryCarrier, SessionRecoveryIdentity } from "../../../src/core/session-recovery-identity.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { within } from "./4272-worker-acceptance-support.ts";

const terminal = () => ({ type: "message_end", message: { role: "user", content: "terminal", timestamp: 1 } });

// Part of #4272: the six RULING-24 boundary-proof REDs, at the production acceptance seam.
for (const transport of ["in-process", "worker frame"] as const) {
	for (const kind of ["previous epoch", "foreign producer", "unminted id"] as const) {
		it(`R24.3 Q7 rejects ${kind} across ${transport}`, async () => {
			const lane = new SessionAcceptanceLane();
			lane.bootstrap({ transcript: [] });
			const record = terminal();
			const producer = new SessionRecoveryIdentity(kind === "previous epoch" ? lane.recoveryEpoch : undefined);
			producer.observe(record);
			let frame = {
				record,
				recovery:
					kind === "unminted id" ? { messageId: randomUUID(), epoch: randomUUID() } : recoveryCarrier(record),
			};
			if (kind === "previous epoch") lane.bootstrap({ transcript: [] });
			if (transport === "worker frame") {
				const worker = new Worker(
					`const { parentPort, workerData } = require("node:worker_threads"); parentPort.postMessage(workerData);`,
					{ eval: true, workerData: frame },
				);
				const received = once(worker, "message");
				const exited = once(worker, "exit");
				try {
					[frame] = await within("carrier postMessage", received);
					expect((await within("carrier worker exit", exited))[0]).toBe(0);
				} finally {
					await worker.terminate();
				}
			}
			try {
				expect(lane.accept(frame.record, frame.recovery)?.messageId).toBeNull();
			} finally {
				lane.retire("close");
			}
		});
	}
}
