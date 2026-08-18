import { describe, expect, it, vi } from "vitest";
import { armExecHeartbeat } from "../src/api/cursor-agent/exec-lifecycle.ts";
import { findControlFrames, runExecLifecycleScenario } from "./cursor-agent-exec-lifecycle-harness.ts";

export function registerCursorExecLifecycleTests(): void {
	describe("cursor-agent exec heartbeat scheduler", () => {
		it("serializes writes and never rearms after completion", async () => {
			vi.useFakeTimers();
			try {
				let writes = 0;
				const completions: Array<(error?: Error | null) => void> = [];
				const stop = armExecHeartbeat({
					intervalMs: 3000,
					isClosed: () => false,
					writeHeartbeat: (onComplete) => {
						writes += 1;
						completions.push(onComplete);
					},
				});

				expect(writes).toBe(0);
				await vi.advanceTimersByTimeAsync(3000);
				expect(writes).toBe(1);
				await vi.advanceTimersByTimeAsync(9000);
				expect(writes).toBe(1);

				const firstCompletion = completions.shift();
				if (!firstCompletion) throw new Error("Expected first heartbeat write callback");
				firstCompletion();
				await vi.advanceTimersByTimeAsync(2999);
				expect(writes).toBe(1);
				await vi.advanceTimersByTimeAsync(1);
				expect(writes).toBe(2);

				stop();
				const secondCompletion = completions.shift();
				if (!secondCompletion) throw new Error("Expected second heartbeat write callback");
				secondCompletion();
				await vi.advanceTimersByTimeAsync(6000);
				expect(writes).toBe(2);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("cursor-agent exec lifecycle", () => {
		it("closes the exec stream after a successful readResult", async () => {
			const { frames, message } = await runExecLifecycleScenario("success");
			expect(findControlFrames(frames, "streamClose", 7)).toHaveLength(1);
			expect(message.stopReason).toBe("stop");
		});

		it("closes the exec stream after a typed read rejection", async () => {
			const { frames, message } = await runExecLifecycleScenario("rejection");
			expect(findControlFrames(frames, "streamClose", 8)).toHaveLength(1);
			expect(message.stopReason).toBe("stop");
		});

		it("heartbeats a pending exec and stops after completion", async () => {
			const { frames, message } = await runExecLifecycleScenario("pending");
			expect(findControlFrames(frames, "heartbeat", 9)).toHaveLength(1);
			expect(findControlFrames(frames, "streamClose", 9)).toHaveLength(1);
			expect(message.stopReason).toBe("stop");
		});

		it("preserves unknown-frame throw then streamClose fallback", async () => {
			const { frames, message } = await runExecLifecycleScenario("unknown");
			expect(findControlFrames(frames, "throw", 10)).toHaveLength(1);
			expect(findControlFrames(frames, "streamClose", 10)).toHaveLength(1);
			expect(message.stopReason).toBe("stop");
		});

		it("closes a shell stream exactly once", async () => {
			const { frames, message } = await runExecLifecycleScenario("shellStream");
			expect(findControlFrames(frames, "streamClose", 11)).toHaveLength(1);
			expect(message.stopReason).toBe("stop");
		});

		it("throws then closes when recognized exec dispatch rejects unexpectedly", async () => {
			const { frames, message } = await runExecLifecycleScenario("dispatchFailure");
			const thrown = findControlFrames(frames, "throw", 12);
			const closes = findControlFrames(frames, "streamClose", 12);
			expect(thrown).toHaveLength(1);
			expect(closes).toHaveLength(1);
			expect(frames.indexOf(thrown[0])).toBeLessThan(frames.indexOf(closes[0]));
			expect(message.stopReason).toBe("stop");
		});
	});
}
