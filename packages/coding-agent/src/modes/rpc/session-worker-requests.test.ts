import { describe, expect, it, vi } from "vitest";
import { SESSION_WORKER_LIMITS } from "./session-worker-protocol.ts";
import { SessionWorkerRequests } from "./session-worker-requests.ts";

/**
 * senpi#1719: the open deadline was an absolute instant fixed when the queue was constructed,
 * so an open sent later inherited whatever was left of it - and once openMs had elapsed,
 * Math.max(0, ...) handed the open a 0ms timer that fired immediately. On a loaded machine the
 * gap between constructing the queue and sending the open is exactly what grows, which is why
 * this showed up as "attach silently falls back" rather than as a slow open.
 */
describe("SessionWorkerRequests open deadline", () => {
	it("does not start an open that is already expired when the queue was built long ago", () => {
		vi.useFakeTimers();
		try {
			const timeout = vi.fn();
			const queue = new SessionWorkerRequests(() => {}, timeout);

			// The queue exists well before the open is sent: a loaded host, a slow spawn, a
			// parent that built its plumbing early. Nothing has been sent yet.
			vi.advanceTimersByTime(SESSION_WORKER_LIMITS.openMs + 5_000);

			void queue.request({ type: "open", session: "s1" } as never);

			// The open has just been sent, so it is entitled to a full budget. Before the fix the
			// timer was created with 0ms and fired on the very next tick.
			vi.advanceTimersByTime(1);
			expect(timeout).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("still bounds an open that genuinely stalls", () => {
		vi.useFakeTimers();
		try {
			const timeout = vi.fn();
			const queue = new SessionWorkerRequests(() => {}, timeout);
			void queue.request({ type: "open", session: "s1" } as never);

			vi.advanceTimersByTime(SESSION_WORKER_LIMITS.openMs + 1);
			expect(timeout).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
