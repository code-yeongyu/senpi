import { describe, expect, it } from "vitest";
import { phasesFromCursorTodos } from "../../../src/core/extensions/builtin/todotools/native-todo-mirror.ts";
import { getTodoWidgetLines } from "../../../src/core/extensions/builtin/todotools/todo-widget.ts";

describe("phasesFromCursorTodos", () => {
	it("distinguishes an absent native todo payload from an explicitly empty list", () => {
		expect(phasesFromCursorTodos(undefined)).toBeUndefined();
		expect(phasesFromCursorTodos([])).toEqual([]);
	});

	it("removes the widget for an empty or fully terminal native list while keeping pending work visible", () => {
		expect(getTodoWidgetLines(phasesFromCursorTodos([]) ?? [])).toBeUndefined();
		expect(
			getTodoWidgetLines(
				phasesFromCursorTodos([
					{ content: "build", status: "completed" },
					{ content: "drop", status: "abandoned" },
				]) ?? [],
			),
		).toBeUndefined();
		expect(getTodoWidgetLines(phasesFromCursorTodos([{ content: "build", status: "pending" }]) ?? [])).toBeDefined();
	});

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
