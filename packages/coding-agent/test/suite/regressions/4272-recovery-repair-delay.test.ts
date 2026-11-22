import { randomBytes } from "node:crypto";
import { isRecoveryRepairAdvice } from "@earendil-works/pi-protocol";
import { afterEach, expect, it, vi } from "vitest";
import { statusHost } from "../rpc-session-status-support.ts";

afterEach(() => vi.unstubAllEnvs());

// #4272 RULING-97: per-token advice spreads retries without revealing token validity.
it("spreads 1,000 random tokens across 100..2000 ms while repeating each token's exact delay", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const peer = host.client("peer");
	const opened = await peer.request({ type: "open_session", admissionId: "own" });
	const buckets = Array<number>(10).fill(0);
	for (let index = 0; index < 1_000; index++) {
		const command = {
			type: "get_recovery_page",
			sessionId: String(opened.sessionId),
			token: randomBytes(32).toString("hex"),
			admissionId: "own",
			componentRef: "manifest",
			requestId: "page",
		};
		const delays: number[] = [];
		for (let repeat = 0; repeat < 2; repeat++) {
			const response = await peer.request(command);
			expect(response).toMatchObject({ success: false, errorCode: "recovery_repair_needed" });
			const advice = (response.errorData as { repair: unknown }).repair;
			if (!isRecoveryRepairAdvice(advice)) throw new Error("invalid repair advice");
			expect(Number.isInteger(advice.retryAfterMs)).toBe(true);
			expect(advice.retryAfterMs).toBeGreaterThanOrEqual(100);
			expect(advice.retryAfterMs).toBeLessThanOrEqual(2_000);
			delays.push(advice.retryAfterMs);
		}
		expect(delays[1]).toBe(delays[0]);
		const bucket = Math.floor((((delays[0] ?? expect.unreachable()) - 100) * 10) / 1_901);
		buckets[bucket] = (buckets[bucket] ?? 0) + 1;
	}
	console.info("RULING-97 bucket counts:", buckets.join(", "));
	expect(buckets.reduce((total, count) => total + count, 0)).toBe(1_000);
	expect(Math.max(...buckets)).toBeLessThanOrEqual(200);
}, 600_000);
