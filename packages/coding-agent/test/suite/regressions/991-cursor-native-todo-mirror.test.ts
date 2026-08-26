import { describe, expect, it } from "vitest";
import { phasesFromCursorTodos } from "../../../src/core/extensions/builtin/todotools/native-todo-mirror.ts";

describe("phasesFromCursorTodos", () => {
	it("turns native Cursor todos into one Tasks phase", () => {
		expect(
			phasesFromCursorTodos([
				{ content: "build", status: "completed" },
				{ content: "link", status: "in_progress" },
				{ content: "  ", status: "pending" },
			]),
		).toEqual([
			{
				name: "Tasks",
				tasks: [
					{ content: "build", status: "completed" },
					{ content: "link", status: "in_progress" },
				],
			},
		]);
	});
});
