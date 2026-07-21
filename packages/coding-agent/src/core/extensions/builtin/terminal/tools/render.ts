import { Text } from "@earendil-works/pi-tui";
import { truncateToVisualLines } from "../../../../../modes/interactive/components/visual-truncate.ts";
import type { AgentToolResult, ToolDefinition } from "../../../types.ts";
import type { BashOutputInput, bashOutputSchema } from "./bash-output.ts";

type BashOutputDetails = Record<string, unknown> | undefined;
type BashOutputToolDefinition = ToolDefinition<typeof bashOutputSchema, BashOutputDetails>;
type RenderResultOptions = Parameters<NonNullable<BashOutputToolDefinition["renderResult"]>>[1];

const OUTPUT_PREVIEW_LINES = 8;

class BashOutputResultComponent {
	#text = "";
	#isPartial = false;
	#expanded = false;

	setResult(result: AgentToolResult<BashOutputDetails>, options: RenderResultOptions): void {
		const block = result.content.find((content) => content.type === "text");
		this.#text = block?.type === "text" ? block.text : "";
		this.#isPartial = options.isPartial;
		this.#expanded = options.expanded;
	}

	render(width: number): string[] {
		if (!this.#isPartial || this.#expanded) return this.#text.split("\n");
		return truncateToVisualLines(this.#text, OUTPUT_PREVIEW_LINES, Math.max(1, width)).visualLines.map((line) =>
			line.trimEnd(),
		);
	}

	invalidate(): void {}
}

export function renderBashOutputCall(
	args: BashOutputInput,
	theme: Parameters<NonNullable<BashOutputToolDefinition["renderCall"]>>[1],
): Text {
	const waitFor = args.wait_for ? ` wait_for:/${args.wait_for}/` : "";
	return new Text(theme.fg("toolTitle", theme.bold(`bash_output ${args.bash_id}${waitFor}`)), 0, 0);
}

export function renderBashOutputResult(
	result: AgentToolResult<BashOutputDetails>,
	options: RenderResultOptions,
	_theme: Parameters<NonNullable<BashOutputToolDefinition["renderResult"]>>[2],
	context: Parameters<NonNullable<BashOutputToolDefinition["renderResult"]>>[3],
): BashOutputResultComponent {
	const component =
		(context.lastComponent as BashOutputResultComponent | undefined) ?? new BashOutputResultComponent();
	component.setResult(result, options);
	return component;
}
