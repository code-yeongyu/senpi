import { RecoveryRepairController } from "@earendil-works/pi-client";
import { isRecoveryRepairAdvice } from "@earendil-works/pi-protocol";
import { afterEach, expect, it, vi } from "vitest";
import { storageUnavailable } from "../../../src/modes/rpc/compact-recovery-types.ts";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";

// #4272 S14/RULING-84(c): drive the real server's JSON wire through the client package's single shared schema.
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});
const record = (input: unknown): Record<string, unknown> => {
	if (typeof input !== "object" || input === null) throw new Error("expected wire record");
	return Object.fromEntries(Object.entries(input));
};
const unwrap = <T>(result: { ok: true; value: T } | { ok: false; failure: unknown }): T => {
	if (!result.ok) throw new Error(JSON.stringify(result.failure));
	return result.value;
};

it("S14 R84 server failure and clearing success share the client schema; connection survives, unchanged source re-cuts only after real storage recovery", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const host = await statusHost();
	try {
		const client = host.client("peer");
		const sessionId = String(dataOf(await client.request({ type: "open_session", cwd: host.cwd })).sessionId);
		const lane = host.writer.recoveryLane(sessionId);
		const socketEpoch = host.writer.socketEpochOf("peer");
		if (!lane || !socketEpoch) throw new Error("missing accepted lane");
		const checkpoints = host.writer.recoveryCheckpoints;
		const cut = unwrap(
			checkpoints.freeze(
				{ sessionId, socketEpoch, admissionId: "contract", routeKind: "ordinary", peer: "peer" },
				lane,
			),
		);
		const caller = { socketEpoch, sessionId };
		const manifest = unwrap(await checkpoints.catalog(cut.token, caller));
		const node = unwrap(await checkpoints.readCatalog(cut.token, caller, manifest.catalogRoot));
		if (node.kind !== "node") throw new Error("expected catalog node");
		const index = node.entries.findIndex((entry) => entry.kind !== "node");
		if (index < 0) throw new Error("missing component");
		const command = {
			type: "get_recovery_page",
			sessionId,
			token: cut.token.id,
			admissionId: "contract",
			componentRef: `${manifest.catalogRoot}:${String(index).padStart(3, "0")}`,
			requestId: "page-1",
		};
		vi.spyOn(checkpoints, "readCatalogPage").mockImplementationOnce(async () => {
			lane.staging.store.health.unavailable();
			return { ok: false, failure: storageUnavailable("unavailable") };
		});
		const failed = await client.request(command);
		expect(failed).toMatchObject({ success: false, errorCode: "recovery_storage_unavailable" });
		const advice = record(failed.errorData).repair;
		expect(isRecoveryRepairAdvice(advice)).toBe(true);
		if (!isRecoveryRepairAdvice(advice)) throw new Error("invalid producer schema");
		expect(advice.retryAfterMs).toBeGreaterThanOrEqual(100);
		expect(advice.retryAfterMs).toBeLessThanOrEqual(2_000);
		const controller = new RecoveryRepairController();
		expect(controller.observe(advice, 0).action).toBe("wait");
		expect(controller.observe(advice, 10_000).action).toBe("wait");
		expect((await client.request({ type: "get_state", sessionId })).success).toBe(true);
		const sequence = lane.acceptedSequence;
		await lane.staging.store.repair();
		const success = await client.request({ ...command, requestId: "page-2" });
		const cleared = dataOf(success).repair;
		expect(isRecoveryRepairAdvice(cleared)).toBe(true);
		if (!isRecoveryRepairAdvice(cleared)) throw new Error("invalid clearing schema");
		expect(cleared.state).toBe("ok");
		expect(cleared.source).toEqual(advice.source);
		expect(lane.acceptedSequence).toBe(sequence);
		expect(BigInt(cleared.healthRevision ?? "0")).toBeGreaterThan(BigInt(advice.healthRevision ?? "0"));
		expect(controller.observe(cleared, advice.retryAfterMs).action).toBe("restart_from_catalog");
		checkpoints.release(cut.token);
	} finally {
		await host[Symbol.asyncDispose]();
	}
}, 120_000);

it("S14 R56 foreign tokens receive bounded repair advice without source identity or storage state", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const host = await statusHost();
	try {
		const client = host.client("peer");
		const sessionId = String(dataOf(await client.request({ type: "open_session", cwd: host.cwd })).sessionId);
		const failed = await client.request({
			type: "get_recovery_page",
			sessionId,
			token: "unknown",
			admissionId: "unknown",
			componentRef: "unknown",
			requestId: "unknown",
		});
		const refusal = record(failed.errorData);
		const advice = refusal.repair;
		expect(advice).toMatchObject({
			state: "repair_needed",
			source: null,
			healthRevision: null,
			hint: "restart_from_catalog",
		});
		const controller = new RecoveryRepairController();
		const context = { token: "unknown", reason: String(refusal.reason) };
		expect(controller.observe(advice, 0, context).action).toBe("restart_from_catalog");
		expect(controller.observe(advice, 10_000, context).action).toBe("wait");
		expect((await client.request({ type: "get_state", sessionId })).success).toBe(true);
	} finally {
		await host[Symbol.asyncDispose]();
	}
}, 120_000);
