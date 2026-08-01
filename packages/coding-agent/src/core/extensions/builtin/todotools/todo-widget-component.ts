import { Text, type TUI } from "@earendil-works/pi-tui";
import {
	partialStrikethrough,
	strikeRevealCount,
	TODO_STRIKE_FRAME_INTERVAL_MS,
	TODO_STRIKE_TOTAL_FRAMES,
} from "../../../../modes/interactive/components/todo-strike.ts";
import type { Theme } from "../../../../modes/interactive/theme/theme.ts";
import { getTodoMarker, sanitizeTodoText } from "./todo-format.ts";
import type { TodoCompletionTransition, TodoItem } from "./todo-types.ts";
import type { TodoWidgetModel } from "./todo-widget.ts";

function formatTask(
	task: TodoItem,
	theme: Theme,
	completionKeys: ReadonlySet<string>,
	frame: number | undefined,
): string {
	const line = `${getTodoMarker(task.status)} ${sanitizeTodoText(task.content)}`;
	switch (task.status) {
		case "completed": {
			const reveal = completionKeys.has(task.content) ? strikeRevealCount(line, frame) : undefined;
			return reveal === undefined
				? theme.fg("dim", theme.strikethrough(line))
				: theme.fg(
						"dim",
						partialStrikethrough(line, reveal, (text) => theme.strikethrough(text)),
					);
		}
		case "in_progress":
			return theme.fg("accent", theme.bold(line));
		case "abandoned":
			return theme.fg("dim", line);
		case "pending":
			return line;
	}
}

function getAnimatedCompletionKeys(
	model: TodoWidgetModel,
	completedTasks: readonly TodoCompletionTransition[],
): ReadonlySet<string> {
	const visibleCompletedTasks = new Set<string>();
	for (const row of model.rows) {
		if (row.kind === "task" && row.task.status === "completed") {
			visibleCompletedTasks.add(row.task.content);
		}
	}
	return new Set(
		completedTasks
			.filter((transition) => transition.phase === model.phaseName && visibleCompletedTasks.has(transition.content))
			.map((transition) => transition.content),
	);
}

export class TodoWidgetComponent extends Text {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly model: TodoWidgetModel;
	private readonly completionKeys: ReadonlySet<string>;
	private frame: number | undefined;
	private intervalId: NodeJS.Timeout | undefined;

	constructor(tui: TUI, theme: Theme, model: TodoWidgetModel, completedTasks: readonly TodoCompletionTransition[]) {
		super("", 1, 0);
		this.tui = tui;
		this.theme = theme;
		this.model = model;
		this.completionKeys = getAnimatedCompletionKeys(model, completedTasks);
		this.frame = this.completionKeys.size > 0 ? 0 : undefined;
		this.updateDisplay();
		if (this.frame !== undefined) this.startAnimation();
	}

	dispose(): void {
		this.stopAnimation();
	}

	private startAnimation(): void {
		const handle = setInterval(() => this.tick(), TODO_STRIKE_FRAME_INTERVAL_MS);
		handle.unref();
		this.intervalId = handle;
	}

	private stopAnimation(): void {
		if (this.intervalId === undefined) return;
		clearInterval(this.intervalId);
		this.intervalId = undefined;
	}

	private tick(): void {
		if (this.frame === undefined) return;
		const nextFrame = this.frame + 1;
		if (nextFrame >= TODO_STRIKE_TOTAL_FRAMES) {
			this.frame = undefined;
			this.stopAnimation();
		} else {
			this.frame = nextFrame;
		}
		this.updateDisplay();
		this.tui.requestRender();
	}

	private updateDisplay(): void {
		this.setText(
			this.model.rows
				.map((row) =>
					row.kind === "label" ? row.text : formatTask(row.task, this.theme, this.completionKeys, this.frame),
				)
				.join("\n"),
		);
	}
}
