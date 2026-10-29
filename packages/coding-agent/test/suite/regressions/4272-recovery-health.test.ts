import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { RecoveryStorageHealth } from "../../../src/modes/rpc/compact-storage-health.ts";
import { RecoveryCheckpoints } from "../../../src/modes/rpc/compact-recovery-state.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";

// #4272 S14, RULING-84: a real durable recovery, not a freeze, advances the persisted health revision.
let base = "";
beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), "s14-health-"));
});
afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

async function repairWrite() {
	const file = await open(join(base, "repaired"), "w", 0o600);
	try {
		await file.writeFile("storage repaired");
		await file.sync();
	} finally {
		await file.close();
	}
}

it("S14 R84 disk full then space freed advances health with no accepted-source progress and survives restart", async () => {
	const health = new RecoveryStorageHealth(base);
	const initial = await health.revision();
	health.unavailable();
	await expect(
		health.recover(async () => {
			throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
		}),
	).rejects.toMatchObject({ code: "ENOSPC" });
	expect(await health.revision()).toBe(initial);
	const recovered = await health.recover(repairWrite);
	expect(BigInt(recovered)).toBeGreaterThan(BigInt(initial));
	const restarted = new RecoveryStorageHealth(base);
	expect(await restarted.revision()).toBe(recovered);
	restarted.unavailable();
	expect(BigInt(await restarted.recover(repairWrite))).toBeGreaterThan(BigInt(recovered));
});

it("S14 R84 a freeze and a successful write without a prior failure never bump health", async () => {
	const health = new RecoveryStorageHealth(base);
	const lane = new SessionAcceptanceLane({ dir: base, health });
	lane.bootstrap({ transcript: [] });
	const checkpoints = new RecoveryCheckpoints();
	const route = {
		socketEpoch: "peer",
		sessionId: "session",
		admissionId: "admission",
		routeKind: "ordinary",
		peer: "peer",
	} as const;
	const initial = await health.revision();
	const cut = checkpoints.freeze(route, lane);
	expect(cut.ok).toBe(true);
	expect(await health.revision()).toBe(initial);
	expect(await health.recover(repairWrite)).toBe(initial);
	if (cut.ok) checkpoints.release(cut.value.token);
	lane.retire("close");
	await lane.idle();
});

it("S14 R84 independent recovering owners serialize durable revisions instead of reissuing a value", async () => {
	const first = new RecoveryStorageHealth(base);
	const second = new RecoveryStorageHealth(base);
	first.unavailable();
	second.unavailable();
	const revisions = await Promise.all([first.recover(repairWrite), second.recover(repairWrite)]);
	expect(new Set(revisions).size).toBe(2);
	expect(await new RecoveryStorageHealth(base).revision()).toBe(
		revisions.reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b)),
	);
});
