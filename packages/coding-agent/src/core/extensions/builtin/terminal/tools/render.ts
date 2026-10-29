import { Text } from "@earendil-works/pi-tui";
import { truncateToVisualLines } from "../../../../../modes/interactive/components/visual-truncate.ts";
import { isModelOnlyText } from "../../../../tools/model-only-text.ts";
import { formatJobWidgetLine, type JobWidgetLineStyle, jobWidgetLineStyle } from "../../job-widgets/tui-line.ts";
import type { JobWidgetEntry } from "../../job-widgets/view-types.ts";
import type { AgentToolResult, ToolDefinition } from "../../../types.ts";
import type { BashOutputInput, bashOutputSchema } from "./bash-output.ts";
import type { MonitorInput, monitorSchema } from "./monitor.ts";

type BashOutputDetails = Record<string, unknown> | undefined;
type BashOutputToolDefinition = ToolDefinition<typeof bashOutputSchema, BashOutputDetails>;
type MonitorToolDefinition = ToolDefinition<typeof monitorSchema, BashOutputDetails>;
type RenderResultOptions = Parameters<NonNullable<BashOutputToolDefinition["renderResult"]>>[1];

const OUTPUT_PREVIEW_LINES = 8;

function jobWidgetOf(details: BashOutputDetails): JobWidgetEntry | undefined {
	const entry = details?.jobWidget as JobWidgetEntry | undefined;
	return typeof entry?.view?.title === "string" && Array.isArray(entry.view.blocks) ? entry : undefined;
}

class BashOutputResultComponent {
	#text = "";
	#isPartial = false;
	#expanded = false;
	#jobWidget: JobWidgetEntry | undefined;
	#style: JobWidgetLineStyle | undefined;

	setResult(
		result: AgentToolResult<BashOutputDetails>,
		options: RenderResultOptions,
		style: JobWidgetLineStyle,
	): void {
		this.#jobWidget = jobWidgetOf(result.details);
		this.#style = style;
		this.#text = result.content
			.filter((content) => content.type === "text" && !isModelOnlyText(content))
			.map((content) => (content.type === "text" ? content.text : ""))
			.join("\n");
		this.#isPartial = options.isPartial;
		this.#expanded = options.expanded;
	}

	render(width: number): string[] {
		const summary =
			this.#jobWidget && this.#style
				? formatJobWidgetLine(this.#jobWidget, width, this.#style, { showId: false })
				: undefined;
		const output =
			!this.#isPartial || this.#expanded
				? this.#text.split("\n")
				: truncateToVisualLines(this.#text, OUTPUT_PREVIEW_LINES, Math.max(1, width)).visualLines.map((line) =>
						line.trimEnd(),
					);
		return summary === undefined ? output : [summary, ...output];
	}

	invalidate(): void {}
}

export function renderBashOutputCall(
	args: BashOutputInput,
	theme: Parameters<NonNullable<BashOutputToolDefinition["renderCall"]>>[1],
): Text {
	return new Text(theme.fg("toolTitle", theme.bold(`bash_output ${args.bash_id}`)), 0, 0);
}

export function renderMonitorCall(
	args: MonitorInput,
	theme: Parameters<NonNullable<MonitorToolDefinition["renderCall"]>>[1],
): Text {
	const label =
		args.action === "rearm"
			? `monitor rearm ${args.bash_id ?? ""}`.trimEnd()
			: `monitor ${args.description ?? args.command ?? ""}`.trimEnd();
	return new Text(theme.fg("toolTitle", theme.bold(label)), 0, 0);
}

export function renderBashOutputResult(
	result: AgentToolResult<BashOutputDetails>,
	options: RenderResultOptions,
	theme: Parameters<NonNullable<BashOutputToolDefinition["renderResult"]>>[2],
	context: Parameters<NonNullable<BashOutputToolDefinition["renderResult"]>>[3],
): BashOutputResultComponent {
	const component =
		(context.lastComponent as BashOutputResultComponent | undefined) ?? new BashOutputResultComponent();
	component.setResult(result, options, jobWidgetLineStyle(theme));
	return component;
}
