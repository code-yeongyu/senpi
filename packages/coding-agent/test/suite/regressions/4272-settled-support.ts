import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { recoveryCarrier, SessionRecoveryIdentity } from "../../../src/core/session-recovery-identity.ts";
import type { CompactContentStoreOptions } from "../../../src/modes/rpc/compact-content-store.ts";
import { type SettledDiagnostic } from "../../../src/modes/rpc/compact-settled-messages.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";

export async function settledRig(options: Partial<CompactContentStoreOptions> = {}) {
	const dir = await mkdtemp(join(tmpdir(), "s05-settled-"));
	const diagnostics: SettledDiagnostic[] = [];
	const lane = new SessionAcceptanceLane({ dir, ...options }, (reason) => diagnostics.push(reason));
	const manager = SessionManager.inMemory(dir);
	lane.bootstrap({ transcript: manager.beginTranscriptJournal() });
	const producer = new SessionRecoveryIdentity(lane.recoveryEpoch);
	return {
		dir,
		lane,
		manager,
		producer,
		diagnostics,
		end(role = "user", content = "terminal") {
			const record = { type: "message_end", message: { role, content, timestamp: 1 } };
			producer.observe(record);
			const carrier = recoveryCarrier(record);
			if (!carrier) throw new Error("producer failed to mint");
			lane.accept(record, carrier);
			return { record, carrier };
		},
		async cut() {
			const root = lane.freeze();
			// On the preceding implementation the value assertion is RED, not a missing-module exception.
			expect(root.settled, "C2.1 cut owns its terminal state").toBeDefined();
			return { root, ...(await lane.readSettled(root)) };
		},
		async close() {
			lane.retire("close");
			// The pre-S05 RED baseline has no spool cleanup method.
			await lane.idle?.();
			await rm(dir, { recursive: true, force: true });
		},
	};
}
