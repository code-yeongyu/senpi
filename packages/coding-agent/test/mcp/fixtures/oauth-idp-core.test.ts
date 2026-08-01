import { describe, expect, it, vi } from "vitest";
import { IdpState, REFRESH_PAIR_GATE_TIMEOUT_MS } from "./oauth-idp-core.ts";

function refreshParams(): URLSearchParams {
	return new URLSearchParams({ grant_type: "refresh_token" });
}

describe("IdpState refresh-pair gate", () => {
	it("unblocks permanently after the first refresh pair", async () => {
		vi.useFakeTimers();
		try {
			const state = new IdpState({
				cimd: false,
				expireAccessSec: 3600,
				noS256: false,
				oidcOnly: false,
				refreshPairGate: true,
				rotateRefresh: true,
			});

			const first = state.waitForRefreshPair(refreshParams());
			const second = state.waitForRefreshPair(refreshParams());
			await Promise.all([first, second]);

			const third = state.waitForRefreshPair(refreshParams());
			let thirdResolved = false;
			third.then(() => {
				thirdResolved = true;
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(thirdResolved).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("bounds the initial wait when the partner refresh never arrives", async () => {
		vi.useFakeTimers();
		try {
			const state = new IdpState({
				cimd: false,
				expireAccessSec: 3600,
				noS256: false,
				oidcOnly: false,
				refreshPairGate: true,
				rotateRefresh: true,
			});

			const lone = state.waitForRefreshPair(refreshParams());
			let resolved = false;
			lone.then(() => {
				resolved = true;
			});

			await vi.advanceTimersByTimeAsync(REFRESH_PAIR_GATE_TIMEOUT_MS - 1);
			expect(resolved).toBe(false);

			await vi.advanceTimersByTimeAsync(1);
			await lone;
			expect(resolved).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});
