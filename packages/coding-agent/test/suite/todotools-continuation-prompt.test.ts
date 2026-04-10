import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	buildContinuationPrompt,
	CONTINUATION_DIRECTIVE,
	countIncomplete,
} from "../../src/core/extensions/builtin/todotools/continuation/prompt.js";
import type { TodoItem } from "../../src/core/extensions/builtin/todotools/state.js";

const CONTINUATION_PROMPT_FIXTURE_PATH = fileURLToPath(
	new URL("./fixtures/continuation-prompt-golden.txt", import.meta.url),
);

const canonicalTodos: TodoItem[] = [
	{ content: "Review the finished task", status: "completed", priority: "high" },
	{ content: "Implement the runtime", status: "in_progress", priority: "high" },
	{ content: "Add integration coverage", status: "pending", priority: "medium" },
];

describe("todotools continuation prompt builder", () => {
	it("exports the directive header and all required instruction substrings", () => {
		expect(CONTINUATION_DIRECTIVE).toContain("[SYSTEM DIRECTIVE: SANEPI - TODO CONTINUATION]");

		const prompt = buildContinuationPrompt(canonicalTodos);

		expect(prompt).toContain("[SYSTEM DIRECTIVE: SANEPI - TODO CONTINUATION]");
		expect(prompt).toContain("Incomplete tasks remain in your todo list. Continue working on the next pending task.");
		expect(prompt).toContain("Continue the first actionable remaining task now.");
		expect(prompt).toContain("Proceed without asking for permission");
		expect(prompt).toContain("Mark each task complete immediately when finished");
		expect(prompt).toContain("Do not stop until all tasks are done");
		expect(prompt).toContain("Do not reply with refusal, deferral, or a summary-only response");
		expect(prompt).toContain("update the todo list to a terminal state instead of leaving it pending");
		expect(prompt).toContain(
			"If you believe all work is already complete, the system is questioning your completion claim.",
		);
		expect(prompt).toContain("Critically re-examine each todo item");
		expect(prompt).toContain("Remaining tasks:");
	});

	it("emits a status line whose counts satisfy X + Z === Y for a mixed list", () => {
		const todos: TodoItem[] = [
			{ content: "Done", status: "completed", priority: "low" },
			{ content: "Active", status: "in_progress", priority: "high" },
			{ content: "Cancelled", status: "cancelled", priority: "low" },
			{ content: "Queued", status: "pending", priority: "medium" },
		];
		const prompt = buildContinuationPrompt(todos);
		const match = prompt.match(/\[Status: (\d+)\/(\d+) completed, (\d+) remaining\]/);

		expect(match).not.toBeNull();
		expect(match?.[1]).toBeDefined();
		expect(match?.[2]).toBeDefined();
		expect(match?.[3]).toBeDefined();

		const completedCount = Number(match?.[1]);
		const totalCount = Number(match?.[2]);
		const remainingCount = Number(match?.[3]);

		expect(completedCount + remainingCount).toBe(totalCount);
		expect(totalCount).toBe(3);
		expect(remainingCount).toBeGreaterThan(0);
	});

	it("lists only non-terminal tasks in source order using bullet lines", () => {
		const todos: TodoItem[] = [
			{ content: "Already done", status: "completed", priority: "low" },
			{ content: "Currently running", status: "in_progress", priority: "high" },
			{ content: "Already cancelled", status: "cancelled", priority: "low" },
			{ content: "Still pending", status: "pending", priority: "medium" },
		];
		const prompt = buildContinuationPrompt(todos);
		const remainingSection = prompt.split("Remaining tasks:\n")[1];

		expect(remainingSection).toBeDefined();
		expect(remainingSection?.trim().split("\n")).toEqual([
			"- [in_progress] Currently running",
			"- [pending] Still pending",
		]);
		expect(prompt).not.toContain("- [completed] Already done");
		expect(prompt).not.toContain("- [cancelled] Already cancelled");
	});

	it("counts incomplete statuses for terminal, empty-string, and unrecognized values", () => {
		const statuses = [
			{ status: "completed", expected: 0 },
			{ status: "cancelled", expected: 0 },
			{ status: "pending", expected: 1 },
			{ status: "in_progress", expected: 1 },
			{ status: "", expected: 1 },
			{ status: "blocked", expected: 1 },
		] as const;

		expect(countIncomplete([])).toBe(0);

		for (const { status, expected } of statuses) {
			expect(countIncomplete([{ content: `Task with status ${status}`, status, priority: "medium" }])).toBe(
				expected,
			);
		}
	});

	it("returns an empty string for an empty todo list", () => {
		expect(buildContinuationPrompt([])).toBe("");
	});

	it("uses an active-total denominator when every todo is cancelled", () => {
		const todos: TodoItem[] = [
			{ content: "Cancelled one", status: "cancelled", priority: "low" },
			{ content: "Cancelled two", status: "cancelled", priority: "medium" },
		];

		expect(buildContinuationPrompt(todos)).toContain("[Status: 0/0 completed, 0 remaining]");
	});

	it("sanitizes multiline todo content before rendering continuation bullets", () => {
		const todos: TodoItem[] = [
			{ content: "Done", status: "completed", priority: "low" },
			{ content: "Line one\nline two\u001b[31m", status: "pending", priority: "high" },
		];
		const prompt = buildContinuationPrompt(todos);
		const remainingSection = prompt.split("Remaining tasks:\n")[1];

		expect(remainingSection).toBeDefined();
		expect(remainingSection?.trim().split("\n")).toEqual(["- [pending] Line one line two"]);
	});

	it("matches the committed golden prompt fixture byte-for-byte", () => {
		const fixtureBytes = readFileSync(CONTINUATION_PROMPT_FIXTURE_PATH);
		const currentBytes = Buffer.from(buildContinuationPrompt(canonicalTodos), "utf8");

		expect(currentBytes).toEqual(fixtureBytes);
	});
});
