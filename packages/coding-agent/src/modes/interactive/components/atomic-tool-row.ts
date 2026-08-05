import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { TOOL_PROGRESS_SPINNER_FRAMES } from "../tool-progress.ts";
import { AtomicToolMetadata } from "./atomic-tool-metadata.ts";

export { isAtomicToolPassthrough } from "./atomic-tool-metadata.ts";

import type { ToolExecutionIdentity, ToolExecutionRenderState } from "./tool-execution-types.ts";

export class AtomicToolRow {
	private readonly metadata: AtomicToolMetadata;
	private state: ToolExecutionRenderState;

	constructor(identity: ToolExecutionIdentity, state: ToolExecutionRenderState) {
		this.metadata = new AtomicToolMetadata(identity, state);
		this.state = state;
	}

	update(state: ToolExecutionRenderState): void {
		this.state = state;
		this.metadata.update(state);
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		let background = (text: string) => theme.bg("toolSuccessBg", text);
		if (this.metadata.isError) {
			background = (text: string) => theme.bg("toolErrorBg", text);
		} else if (this.state.isPartial || !this.state.result) {
			background = (text: string) => theme.bg("toolPendingBg", text);
		}

		const spinning =
			this.metadata.supportsProgressSpinner &&
			this.state.executionStarted &&
			this.state.isPartial &&
			!this.metadata.isError;
		const frame = TOOL_PROGRESS_SPINNER_FRAMES[(this.state.spinnerFrame ?? 0) % TOOL_PROGRESS_SPINNER_FRAMES.length];
		const isEval = this.metadata.name === "eval";
		const isBash = this.metadata.name === "bash";
		const name = theme.fg("toolTitle", theme.bold(this.metadata.name));
		const nameSpinner = isBash && spinning ? ` ${theme.fg("warning", frame)}` : "";
		const head = `${name}${nameSpinner}`;
		const tail = [
			isEval && spinning ? theme.fg("warning", frame) : undefined,
			this.metadata.facts ? theme.fg("muted", this.metadata.facts) : undefined,
		]
			.filter((value): value is string => value !== undefined)
			.join(" ");
		const targetSeparatorWidth = this.metadata.target ? 1 : 0;
		const tailSeparatorWidth = tail ? (this.metadata.target ? 3 : 1) : 0;
		const targetBudget = width - visibleWidth(head) - visibleWidth(tail) - targetSeparatorWidth - tailSeparatorWidth;
		const target =
			this.metadata.target && targetBudget > 0
				? theme.fg("text", truncateToWidth(this.metadata.target, targetBudget, "…"))
				: undefined;
		const targetText = target ? ` ${target}` : "";
		const tailText = tail ? `${target ? " · " : " "}${tail}` : "";
		const content = truncateToWidth(`${head}${targetText}${tailText}`, width, "…");
		const box = new Box(0, 0, background);
		box.addChild(new Text(content, 0, 0));
		return box.render(width);
	}
}
