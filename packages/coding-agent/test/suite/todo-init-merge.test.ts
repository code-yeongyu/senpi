import { describe, expect, it } from "vitest";
import {
	appendItems,
	DEFAULT_INIT_PHASE,
	initPhases,
	type TodoPhase,
} from "../../src/core/extensions/builtin/todotools/state.ts";

describe("todo init duplicate correction", () => {
	it("merges duplicate phases into their first occurrence without reordering items", () => {
		const errors: string[] = [];
		const corrections: string[] = [];

		const phases = initPhases(
			{
				op: "init",
				list: [
					{ phase: "Dockerfile", items: ["Create base image"] },
					{ phase: "Tests", items: ["Add coverage"] },
					{ phase: "Dockerfile", items: ["Install runtime"] },
				],
			},
			errors,
			corrections,
		);

		expect(errors).toEqual([]);
		expect(phases).toEqual([
			{
				name: "Dockerfile",
				tasks: [
					{ content: "Create base image", status: "pending" },
					{ content: "Install runtime", status: "pending" },
				],
			},
			{ name: "Tests", tasks: [{ content: "Add coverage", status: "pending" }] },
		]);
		expect(corrections).toEqual(['[auto-corrected] merged duplicate phase "Dockerfile" in init list']);
	});

	it("keeps the first duplicate task in an init list and records a correction", () => {
		const errors: string[] = [];
		const corrections: string[] = [];

		const phases = initPhases(
			{
				op: "init",
				list: [
					{ phase: "One", items: ["Keep first"] },
					{ phase: "Two", items: ["Keep first", "Keep second"] },
				],
			},
			errors,
			corrections,
		);

		expect(errors).toEqual([]);
		expect(phases).toEqual([
			{ name: "One", tasks: [{ content: "Keep first", status: "pending" }] },
			{ name: "Two", tasks: [{ content: "Keep second", status: "pending" }] },
		]);
		expect(corrections).toEqual(['[auto-corrected] kept first duplicate task "Keep first" in init list']);
	});

	it("retains the empty-phase init error", () => {
		const errors: string[] = [];

		initPhases({ op: "init", list: [{ phase: "Empty", items: [] }] }, errors, []);

		expect(errors).toEqual(['Phase "Empty" has no tasks in init list']);
	});
});

describe("todo append phase defaults", () => {
	it("uses the active task's phase when append omits phase", () => {
		const phases: TodoPhase[] = [
			{ name: "Active", tasks: [{ content: "Work now", status: "in_progress" }] },
			{ name: "Later", tasks: [{ content: "Work later", status: "pending" }] },
		];
		const errors: string[] = [];
		const corrections: string[] = [];

		appendItems(phases, { op: "append", items: ["New task"] }, errors, corrections);

		expect(errors).toEqual([]);
		expect(phases[0].tasks.map((task) => task.content)).toEqual(["Work now", "New task"]);
		expect(phases[1].tasks.map((task) => task.content)).toEqual(["Work later"]);
		expect(corrections).toEqual(['[auto-corrected] append had no phase; used "Active"']);
	});

	it("uses the last phase when all existing tasks are terminal", () => {
		const phases: TodoPhase[] = [
			{ name: "Completed", tasks: [{ content: "Done", status: "completed" }] },
			{ name: "Abandoned", tasks: [{ content: "Dropped", status: "abandoned" }] },
		];
		const errors: string[] = [];
		const corrections: string[] = [];

		appendItems(phases, { op: "append", items: ["Follow up"] }, errors, corrections);

		expect(errors).toEqual([]);
		expect(phases[0].tasks.map((task) => task.content)).toEqual(["Done"]);
		expect(phases[1].tasks.map((task) => task.content)).toEqual(["Dropped", "Follow up"]);
		expect(corrections).toEqual(['[auto-corrected] append had no phase; used "Abandoned"']);
	});

	it("creates the default phase when append omits phase on an empty list", () => {
		const phases: TodoPhase[] = [];
		const errors: string[] = [];
		const corrections: string[] = [];

		appendItems(phases, { op: "append", items: ["First task"] }, errors, corrections);

		expect(errors).toEqual([]);
		expect(phases).toEqual([{ name: DEFAULT_INIT_PHASE, tasks: [{ content: "First task", status: "pending" }] }]);
		expect(corrections).toEqual([`[auto-corrected] append had no phase; used "${DEFAULT_INIT_PHASE}"`]);
	});

	it("keeps duplicate-task append failures as errors", () => {
		const phases = [{ name: "Tasks", tasks: [{ content: "Already exists", status: "pending" as const }] }];
		const errors: string[] = [];

		appendItems(phases, { op: "append", items: ["Already exists"] }, errors, []);

		expect(errors).toEqual(['Task "Already exists" already exists']);
		expect(phases[0].tasks).toEqual([{ content: "Already exists", status: "pending" }]);
	});
});
