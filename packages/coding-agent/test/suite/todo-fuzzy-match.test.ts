import { describe, expect, it } from "vitest";
import { fuzzyResolvePhase, fuzzyResolveTask } from "../../src/core/extensions/builtin/todotools/fuzzy-match.ts";
import {
	applyParams,
	resolvePhaseOrError,
	resolveTaskOrError,
	type TodoPhase,
} from "../../src/core/extensions/builtin/todotools/state.ts";

function phasesWithTasks(...contents: string[]): TodoPhase[] {
	return [{ name: "Tasks", tasks: contents.map((content) => ({ content, status: "pending" as const })) }];
}

describe("todo model-path fuzzy resolution", () => {
	it("returns a unique exact task hit without a correction", () => {
		const phases = phasesWithTasks("Deploy API");
		const corrections: string[] = [];
		const errors: string[] = [];

		const hit = resolveTaskOrError(phases, "Deploy API", errors, corrections);

		expect(hit).toEqual({ task: phases[0].tasks[0], phase: phases[0] });
		expect(errors).toEqual([]);
		expect(corrections).toEqual([]);
		expect(fuzzyResolveTask(phases, "Deploy API")).toMatchObject({ hit, corrected: false });
	});

	it("auto-matches one normalized task and phase with a correction", () => {
		const phases: TodoPhase[] = [
			{
				name: "Verification",
				tasks: [{ content: "\u001b[31mDeploy   API\u001b[0m", status: "pending" }],
			},
		];
		const taskCorrections: string[] = [];
		const phaseCorrections: string[] = [];
		const taskErrors: string[] = [];
		const phaseErrors: string[] = [];

		const task = resolveTaskOrError(phases, " deploy api ", taskErrors, taskCorrections);
		const phase = resolvePhaseOrError(phases, " verification ", phaseErrors, phaseCorrections);

		expect(task).toEqual({ task: phases[0].tasks[0], phase: phases[0] });
		expect(phase).toBe(phases[0]);
		expect(fuzzyResolveTask(phases, " deploy api ")).toMatchObject({ hit: task, corrected: true });
		expect(fuzzyResolvePhase(phases, " verification ")).toMatchObject({ hit: phases[0], corrected: true });
		expect(taskCorrections).toEqual([
			'[auto-matched] task " deploy api " -> "\u001b[31mDeploy   API\u001b[0m" — pass the exact text from the previous todo result next time',
		]);
		expect(phaseCorrections).toEqual([
			'[auto-matched] phase " verification " -> "Verification" — pass the exact text from the previous todo result next time',
		]);
	});

	it("does not auto-match duplicate normalized task text and offers a suggestion", () => {
		const phases: TodoPhase[] = [
			{ name: "One", tasks: [{ content: "Deploy API", status: "pending" }] },
			{ name: "Two", tasks: [{ content: " deploy   api ", status: "pending" }] },
		];
		const corrections: string[] = [];
		const errors: string[] = [];

		const result = fuzzyResolveTask(phases, "DEPLOY API");
		const hit = resolveTaskOrError(phases, "DEPLOY API", errors, corrections);

		expect(result).toEqual({ corrected: false, suggestion: "Deploy API" });
		expect(hit).toBeUndefined();
		expect(corrections).toEqual([]);
		expect(errors).toEqual(['Task "DEPLOY API" not found Did you mean "Deploy API"?']);
	});

	it("keeps containment matches as suggestions so a negated sibling cannot be mutated", () => {
		const phases = phasesWithTasks("Do not deploy API to production");
		const corrections: string[] = [];

		const fuzzy = fuzzyResolveTask(phases, "Deploy API to production");
		const applied = applyParams(phases, { op: "done", task: "Deploy API to production" }, corrections);

		expect(fuzzy).toEqual({ corrected: false, suggestion: "Do not deploy API to production" });
		expect(applied.errors).toEqual([
			'Task "Deploy API to production" not found Did you mean "Do not deploy API to production"?',
		]);
		expect(applied.phases[0].tasks[0].status).toBe("pending");
		expect(corrections).toEqual([]);
	});

	it("keeps paraphrase-like Dice matches as suggestions", () => {
		const phases = phasesWithTasks("Synthesize non-overlapping findings and current status");

		const fuzzy = fuzzyResolveTask(phases, "Synthesize findings and current status");

		expect(fuzzy).toEqual({
			corrected: false,
			suggestion: "Synthesize non-overlapping findings and current status",
		});
	});

	it("reports duplicate exact content across phases on the model path", () => {
		const phases: TodoPhase[] = [
			{ name: "Planning", tasks: [{ content: "Duplicate", status: "pending" }] },
			{ name: "Delivery", tasks: [{ content: "Duplicate", status: "pending" }] },
		];
		const errors: string[] = [];

		const hit = resolveTaskOrError(phases, "Duplicate", errors, []);

		expect(hit).toBeUndefined();
		expect(errors).toEqual([
			'Task "Duplicate" is ambiguous: duplicate task text exists in phases "Planning", "Delivery". Use /todo edit to make the task text unique.',
		]);
	});

	it("preserves legacy first-match resolution when corrections are omitted", () => {
		const phases: TodoPhase[] = [
			{ name: "Planning", tasks: [{ content: "Duplicate", status: "pending" }] },
			{ name: "Delivery", tasks: [{ content: "Duplicate", status: "pending" }] },
		];
		const errors: string[] = [];

		const hit = resolveTaskOrError(phases, "Duplicate", errors);

		expect(hit).toEqual({ task: phases[0].tasks[0], phase: phases[0] });
		expect(errors).toEqual([]);
	});

	it("preserves the task-ID error text verbatim", () => {
		const errors: string[] = [];

		resolveTaskOrError(phasesWithTasks("Build release"), "task-12", errors, []);

		expect(errors).toEqual([
			'Task "task-12" not found. Tasks are referenced by content, not by IDs — pass the task\'s full text from the previous result.',
		]);
	});

	it("preserves the empty-list hint verbatim", () => {
		const errors: string[] = [];

		resolveTaskOrError([], "Unknown task", errors, []);

		expect(errors).toEqual([
			'Task "Unknown task" not found (todo list is empty — was it replaced or not yet created?)',
		]);
	});

	it.each(["done", "drop"] as const)("threads auto-match corrections through %s task targeting", (op) => {
		const corrections: string[] = [];
		const applied = applyParams(phasesWithTasks("Deploy API"), { op, task: " deploy api " }, corrections);

		expect(applied.errors).toEqual([]);
		expect(applied.phases[0].tasks[0].status).toBe(op === "done" ? "completed" : "abandoned");
		expect(corrections).toEqual([
			'[auto-matched] task " deploy api " -> "Deploy API" — pass the exact text from the previous todo result next time',
		]);
	});

	it("threads auto-match corrections through rm task targeting", () => {
		const corrections: string[] = [];
		const applied = applyParams(phasesWithTasks("Deploy API"), { op: "rm", task: " deploy api " }, corrections);

		expect(applied.errors).toEqual([]);
		expect(applied.phases[0].tasks).toEqual([]);
		expect(corrections).toEqual([
			'[auto-matched] task " deploy api " -> "Deploy API" — pass the exact text from the previous todo result next time',
		]);
	});
});
