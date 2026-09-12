import { expect, it, vi } from "vitest";
import { SESSION_WORKER_LIMITS } from "../../src/modes/rpc/session-worker-protocol.ts";
import { SessionWorkerRequests } from "../../src/modes/rpc/session-worker-requests.ts";

const display = { revision: 0, width: 80, rendered: false, capabilities: [] };

it("reserves bounded interrupt slots even when normal worker requests are exhausted", async () => {
	const sent: Array<{ request: number }> = [];
	const requests = new SessionWorkerRequests(
		(message) => sent.push(message),
		() => {
			throw new Error("Unexpected timeout");
		},
	);
	const pending = [];
	for (let i = 0; i < SESSION_WORKER_LIMITS.requests; i++)
		pending.push(requests.request({ type: "command", command: { type: "get_state" }, display }));
	const results = Promise.allSettled(pending);
	await expect(requests.request({ type: "command", command: { type: "get_state" }, display })).rejects.toThrow(
		"session_worker_request_limit",
	);
	const interrupt = requests.request({ type: "command", command: { type: "abort" }, display });
	const last = sent.at(-1);
	if (!last) throw new Error("Interrupt was not dispatched");
	requests.receive({ type: "result", request: last.request });
	expect((await interrupt).type).toBe("result");
	expect(sent).toHaveLength(SESSION_WORKER_LIMITS.requests + 1);
	requests.close(new Error("closed"));
	expect((await results).every((result) => result.status === "rejected")).toBe(true);
});

it("does not dispatch a request beyond the worker byte budget", async () => {
	let dispatched = 0;
	const requests = new SessionWorkerRequests(
		() => {
			dispatched++;
		},
		() => {
			throw new Error("Unexpected timeout");
		},
	);
	await expect(
		requests.request({
			type: "command",
			command: { type: "prompt", message: "x".repeat(SESSION_WORKER_LIMITS.requestBytes) },
			display,
		}),
	).rejects.toThrow("session_worker_request_limit");
	expect(dispatched).toBe(0);
	requests.close(new Error("closed"));
});

it("does not reset the opening deadline between commit and bind", async () => {
	vi.useFakeTimers();
	const sent: Array<{ request: number }> = [];
	let timeouts = 0;
	const requests = new SessionWorkerRequests(
		(message) => sent.push(message),
		() => {
			timeouts++;
		},
	);
	const commit = requests.request({ type: "commit" });
	try {
		await vi.advanceTimersByTimeAsync(SESSION_WORKER_LIMITS.openMs - 1000);
		const first = sent[0];
		if (!first) throw new Error("Commit was not dispatched");
		requests.receive({ type: "result", request: first.request });
		await commit;
		const bind = requests.request({ type: "bind", sessionId: "fixture", display });
		const drained = Promise.allSettled([bind]);
		await vi.advanceTimersByTimeAsync(1000);
		expect(timeouts).toBe(1);
		requests.close(new Error("deadline"));
		await drained;
	} finally {
		requests.close(new Error("closed"));
		vi.useRealTimers();
	}
});

it("times out interrupts without imposing that timeout on normal commands", async () => {
	vi.useFakeTimers();
	let timeouts = 0;
	const requests = new SessionWorkerRequests(
		() => {},
		() => {
			timeouts++;
		},
	);
	const normal = requests.request({ type: "command", command: { type: "prompt" }, display });
	const interrupt = requests.request({ type: "command", command: { type: "abort" }, display });
	const results = Promise.allSettled([normal, interrupt]);
	try {
		await vi.advanceTimersByTimeAsync(SESSION_WORKER_LIMITS.controlMs);
		expect(timeouts).toBe(1);
		await vi.advanceTimersByTimeAsync(SESSION_WORKER_LIMITS.openMs);
		expect(timeouts).toBe(1);
	} finally {
		requests.close(new Error("closed"));
		await results;
		vi.useRealTimers();
	}
});
