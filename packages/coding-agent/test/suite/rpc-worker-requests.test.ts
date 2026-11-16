import { expect, it, vi } from "vitest";
import { SessionWorkerClient } from "../../src/modes/rpc/session-worker-client.ts";
import { SESSION_WORKER_LIMITS, type SessionWorkerToHost } from "../../src/modes/rpc/session-worker-protocol.ts";
import { SessionWorkerRequests } from "../../src/modes/rpc/session-worker-requests.ts";

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
		pending.push(requests.request({ type: "command", command: { type: "get_state" } }));
	const results = Promise.allSettled(pending);
	await expect(requests.request({ type: "command", command: { type: "get_state" } })).rejects.toThrow(
		"session_worker_request_limit",
	);
	const interrupt = requests.request({ type: "command", command: { type: "abort" } });
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
		}),
	).rejects.toThrow("session_worker_request_limit");
	expect(dispatched).toBe(0);
	requests.close(new Error("closed"));
});

// A request sent while the worker still owes another shares that answer's no-progress deadline: queueing
// more work never extends it. Idle time, when the worker owes nothing, is free (senpi#1719, senpi#6452 M1).
it("does not extend the no-progress deadline for a request sent while another is still owed", async () => {
	vi.useFakeTimers();
	let timeouts = 0;
	const requests = new SessionWorkerRequests(
		() => {},
		() => {
			timeouts++;
		},
	);
	const commit = requests.request({ type: "commit" });
	const settled = commit.catch(() => undefined);
	try {
		await vi.advanceTimersByTimeAsync(SESSION_WORKER_LIMITS.openMs - 1000);
		const bind = requests.request({ type: "bind", sessionId: "fixture", capabilities: [] });
		const drained = Promise.allSettled([bind]);
		await vi.advanceTimersByTimeAsync(999);
		expect(timeouts).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		// Both timers fire at the commit's deadline: the bind's own timer, not just the commit's, proves the
		// bind was given what was left of the shared deadline rather than a fresh budget.
		expect(timeouts).toBe(2);
		requests.close(new Error("deadline"));
		await drained;
		await settled;
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
	const normal = requests.request({ type: "command", command: { type: "prompt" } });
	const interrupt = requests.request({ type: "command", command: { type: "abort" } });
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

it("a worker that keeps answering progress is not quarantined by the opening deadline (senpi#6452)", async () => {
	vi.useFakeTimers();
	const sent: Array<{ request: number }> = [];
	let timeouts = 0;
	const requests = new SessionWorkerRequests(
		(message) => sent.push(message),
		() => {
			timeouts++;
		},
	);
	const pending = requests.request({ type: "commit" });
	const half = Math.floor(SESSION_WORKER_LIMITS.openMs / 2);
	// The worker answers progress before each deadline would fire: a request that merely runs long
	// under load is not a dead worker, so the session must not be quarantined.
	vi.advanceTimersByTime(half);
	requests.noteProgress();
	vi.advanceTimersByTime(half);
	requests.noteProgress();
	vi.advanceTimersByTime(half);
	expect(timeouts).toBe(0);
	// Once the worker stops answering at all, the unchanged deadline still fires.
	vi.advanceTimersByTime(SESSION_WORKER_LIMITS.openMs + 1);
	expect(timeouts).toBe(1);
	requests.close(new Error("closed"));
	await expect(pending).rejects.toThrow("closed");
	vi.useRealTimers();
});

// senpi#6452 review L2: progress restarts the no-progress deadline, never an interrupt's own bound. An abort
// the worker never answers is still cut at controlMs while the worker keeps streaming other messages.
it("progress never extends an unanswered interrupt's bound", async () => {
	vi.useFakeTimers();
	let timeouts = 0;
	const requests = new SessionWorkerRequests(
		() => {},
		() => {
			timeouts++;
		},
	);
	const abort = requests.request({ type: "command", command: { type: "abort" } });
	const settled = abort.catch(() => undefined);
	try {
		vi.advanceTimersByTime(SESSION_WORKER_LIMITS.controlMs - 1);
		requests.noteProgress();
		vi.advanceTimersByTime(1);
		expect(timeouts).toBe(1);
	} finally {
		requests.close(new Error("closed"));
		await settled;
		vi.useRealTimers();
	}
});

// senpi#6452 review L1: the production wiring. A message arriving on the real Worker channel is progress
// for the client's request deadline; the request itself is swallowed so the worker never answers it.
it("a message from the worker restarts the client's no-progress deadline", async () => {
	const failure = vi.fn();
	const client = new SessionWorkerClient({ reserve: () => "granted", reconcile: () => {}, exit: () => {}, failure });
	client.worker.postMessage = () => {};
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	try {
		const answer = client.setPromptSurface("app").catch((error: unknown) => error);
		const progress = { type: "control_done", control: "cancel_ui" } satisfies SessionWorkerToHost;
		vi.advanceTimersByTime(SESSION_WORKER_LIMITS.openMs - 1);
		expect(client.worker.emit("message", progress)).toBe(true);
		vi.advanceTimersByTime(SESSION_WORKER_LIMITS.openMs - 1);
		expect(failure).not.toHaveBeenCalled();
		// Silence after that message still reaches the unchanged deadline.
		vi.advanceTimersByTime(1);
		expect(failure).toHaveBeenCalledExactlyOnceWith("session_worker_request_timeout");
		expect(await answer).toBeInstanceOf(Error);
	} finally {
		vi.useRealTimers();
		client.quarantine();
		await client.exited;
	}
}, 60_000);
