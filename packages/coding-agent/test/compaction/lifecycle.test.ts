import { describe, expect, it } from "vitest";
import {
	beginCompactionOperation,
	finishCompactionOperation,
	initialCompactionLifecycleState,
	promoteCompactionOperation,
} from "../../src/core/compaction/lifecycle.ts";

function begin(operationId: string, generation = 0) {
	return beginCompactionOperation(
		generation === 0
			? initialCompactionLifecycleState()
			: {
					status: "completed",
					generation,
					operationId: `previous-${generation}`,
					stage: "execution",
					reason: "threshold",
					model: { provider: "faux", id: "previous" },
					startedRevision: generation,
					endedRevision: generation,
				},
		{
			operationId,
			stage: "execution",
			reason: "threshold",
			model: { provider: "faux", id: "active" },
			startedRevision: generation + 1,
		},
	);
}

describe("compaction lifecycle", () => {
	it("retains completed state until the next operation begins", () => {
		const running = begin("operation-1");
		const completed = finishCompactionOperation(running, {
			operationId: "operation-1",
			status: "completed",
			endedRevision: 2,
		});

		expect(completed).toMatchObject({
			status: "completed",
			generation: 1,
			operationId: "operation-1",
			model: { provider: "faux", id: "active" },
			endedRevision: 2,
		});
	});

	it("ignores stale completion from a superseded operation", () => {
		const first = begin("operation-1");
		const second = beginCompactionOperation(first, {
			operationId: "operation-2",
			stage: "execution",
			reason: "pre_prompt",
			model: { provider: "faux", id: "fallback" },
			startedRevision: 3,
		});
		const afterStaleCompletion = finishCompactionOperation(second, {
			operationId: "operation-1",
			status: "completed",
			endedRevision: 4,
		});

		expect(afterStaleCompletion).toBe(second);
		expect(afterStaleCompletion).toMatchObject({
			status: "running",
			generation: 2,
			operationId: "operation-2",
			model: { provider: "faux", id: "fallback" },
		});
	});

	it("promotes feedback generation into the same execution operation", () => {
		const feedback = beginCompactionOperation(initialCompactionLifecycleState(), {
			operationId: "operation-1",
			stage: "feedback",
			reason: "extension",
			model: { provider: "faux", id: "fallback" },
			startedRevision: 2,
		});
		const execution = promoteCompactionOperation(feedback, "operation-1");

		expect(execution).toMatchObject({
			status: "running",
			generation: 1,
			operationId: "operation-1",
			stage: "execution",
		});
	});

	it("records failure and abort as distinct terminal states", () => {
		const failed = finishCompactionOperation(begin("failed-operation"), {
			operationId: "failed-operation",
			status: "failed",
			endedRevision: 5,
			rejectionCause: "would-overflow",
			errorMessage: "summary exceeds budget",
		});
		const aborted = finishCompactionOperation(begin("aborted-operation", 1), {
			operationId: "aborted-operation",
			status: "aborted",
			endedRevision: 6,
			errorMessage: "Compaction cancelled",
		});

		expect(failed).toMatchObject({
			status: "failed",
			rejectionCause: "would-overflow",
			errorMessage: "summary exceeds budget",
		});
		expect(aborted).toMatchObject({
			status: "aborted",
			generation: 2,
			errorMessage: "Compaction cancelled",
		});
	});

	it("ignores duplicate terminal events", () => {
		const completed = finishCompactionOperation(begin("operation-1"), {
			operationId: "operation-1",
			status: "completed",
			endedRevision: 2,
		});
		const duplicate = finishCompactionOperation(completed, {
			operationId: "operation-1",
			status: "failed",
			endedRevision: 3,
			errorMessage: "late failure",
		});

		expect(duplicate).toBe(completed);
		expect(duplicate.status).toBe("completed");
	});
});
