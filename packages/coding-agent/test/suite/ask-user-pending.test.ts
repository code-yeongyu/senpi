import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createPendingQuestion,
	type QuestionRequest,
	type QuestionResponse,
} from "../../src/core/extensions/builtin/ask-user/pending.ts";

const MINUTE_MS = 60_000;
const IDLE_MS = 30 * MINUTE_MS;
const HARD_CAP_MS = 2 * 60 * MINUTE_MS;
const START_MS = Date.parse("2026-01-01T00:00:00.000Z");

const REQUEST: QuestionRequest = {
	requestId: "req-1",
	questions: [
		{
			id: "q1",
			header: "Approach",
			question: "Which approach?",
			options: [{ label: "A" }, { label: "B" }],
			multiSelect: false,
		},
		{
			id: "q2",
			header: "Library",
			question: "Which library?",
			options: [{ label: "C" }, { label: "D" }],
			multiSelect: false,
		},
	],
	waitForAnswer: true,
	timeoutMs: IDLE_MS,
};

const ALL_ANSWERS = {
	q1: { selected: ["A"] },
	q2: { selected: ["C"] },
};

describe("createPendingQuestion", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(START_MS);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function createSut(onTimeout?: (result: QuestionResponse) => void) {
		return createPendingQuestion({
			request: REQUEST,
			now: () => Date.now(),
			idleTimeoutMs: IDLE_MS,
			onTimeout,
			setTimeout: (handler, delayMs) => globalThis.setTimeout(handler, delayMs),
			clearTimeout: (handle) => {
				globalThis.clearTimeout(handle);
			},
		});
	}

	it("(a) times out at exactly idleTimeoutMs with no interaction", async () => {
		const timeouts: QuestionResponse[] = [];
		const pending = createSut((result) => {
			timeouts.push(result);
		});
		await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
		expect(pending.state).toBe("pending");
		expect(timeouts).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(pending.state).toBe("timed_out");
		expect(pending.result?.status).toBe("timed_out");
		expect(timeouts).toHaveLength(1);
		expect(timeouts[0]?.status).toBe("timed_out");
		expect(timeouts[0]?.autoResolvedAfterMs).toBe(IDLE_MS);
	});

	it("(b) a touch at t=29m moves the deadline to t=59m", async () => {
		const pending = createSut();
		expect(pending.deadlineAtMs).toBe(START_MS + IDLE_MS);
		await vi.advanceTimersByTimeAsync(29 * MINUTE_MS);
		pending.touch();
		expect(pending.deadlineAtMs).toBe(START_MS + 59 * MINUTE_MS);
		expect(pending.remainingMs(Date.now())).toBe(IDLE_MS);
		expect(pending.remainingMs(Date.now())).toBe(IDLE_MS);
		expect(pending.deadlineAtMs).toBe(START_MS + 59 * MINUTE_MS);
	});

	it("(c) touches every 29 minutes still time out at the 2h cap", async () => {
		const pending = createSut();
		const step = 29 * MINUTE_MS;
		let elapsed = 0;
		while (elapsed + step < HARD_CAP_MS) {
			await vi.advanceTimersByTimeAsync(step);
			elapsed += step;
			pending.touch();
		}
		await vi.advanceTimersByTimeAsync(HARD_CAP_MS - elapsed - 1);
		expect(pending.state).toBe("pending");
		await vi.advanceTimersByTimeAsync(1);
		expect(pending.state).toBe("timed_out");
		expect(pending.result?.autoResolvedAfterMs).toBe(HARD_CAP_MS);
	});

	it('(d) submit({}, "just do it") is comment-submitted with all ids unanswered', () => {
		const pending = createSut();
		const result = pending.submit({}, "just do it");
		expect(result).toEqual({
			status: "comment-submitted",
			answers: {},
			comment: "just do it",
			unanswered: ["q1", "q2"],
		});
		expect(pending.state).toBe("comment-submitted");
	});

	it("(e) submit(allAnswers) is answered", () => {
		const pending = createSut();
		const result = pending.submit(ALL_ANSWERS);
		expect(result).toEqual({
			status: "answered",
			answers: ALL_ANSWERS,
			unanswered: [],
		});
		expect(pending.state).toBe("answered");
	});

	it("(e2) submit(partialAnswers) is answered with unanswered ids", () => {
		const pending = createSut();
		const result = pending.submit({ q1: { selected: ["A"] } });
		expect(result).toEqual({
			status: "answered",
			answers: { q1: { selected: ["A"] } },
			unanswered: ["q2"],
		});
		expect(pending.state).toBe("answered");
	});

	it('(f) submit({}, "") returns false and stays pending', () => {
		const pending = createSut();
		expect(pending.submit({}, "")).toBe(false);
		expect(pending.state).toBe("pending");
		expect(pending.result).toBeUndefined();
	});

	it("(g) after timed_out, submit returns the timed_out result unchanged", async () => {
		const pending = createSut();
		await vi.advanceTimersByTimeAsync(IDLE_MS);
		const timedOut = pending.result;
		expect(timedOut?.status).toBe("timed_out");
		const after = pending.submit(ALL_ANSWERS, "nope");
		expect(after).toEqual(timedOut);
		expect(pending.result).toEqual(timedOut);
		expect(after).toMatchObject({ status: "timed_out" });
	});

	it("(h) draft selections appear in the timed_out result", async () => {
		const pending = createSut();
		pending.touch({
			answers: { q1: { selected: ["A"] } },
			comment: "maybe later",
		});
		await vi.advanceTimersByTimeAsync(IDLE_MS);
		expect(pending.result).toEqual({
			status: "timed_out",
			answers: { q1: { selected: ["A"] } },
			comment: "maybe later",
			unanswered: ["q2"],
			autoResolvedAfterMs: IDLE_MS,
		});
	});
});
