import type { AgentToolResult, ToolDefinition, ToolRenderResultOptions } from "@code-yeongyu/senpi";
import type { createEvalInputSchema, EvalToolDetails, EvalToolInput } from "./types.ts";

type EvalToolDefinition = ToolDefinition<ReturnType<typeof createEvalInputSchema>, EvalToolDetails>;
type RenderContext = Parameters<NonNullable<EvalToolDefinition["renderCall"]>>[2];
type Component = ReturnType<NonNullable<EvalToolDefinition["renderCall"]>>;

class PlainTextComponent {
	#text = "";

	setText(text: string): void {
		this.#text = text;
	}

	render(): string[] {
		return this.#text ? this.#text.split("\n") : [];
	}

	invalidate(): void {}
}

function componentFor(context: RenderContext): PlainTextComponent {
	const existing = context.lastComponent;
	if (existing instanceof PlainTextComponent) return existing;
	return new PlainTextComponent();
}

function firstCodeLine(code: string | undefined): string {
	const line = code?.split(/\r?\n/, 1)[0]?.trim();
	return line && line.length > 0 ? line : "...";
}

function textOutput(result: AgentToolResult<EvalToolDetails>, showImages: boolean): string {
	const lines: string[] = [];
	for (const part of result.content) {
		if (part.type === "text") lines.push(part.text);
		else if (showImages && part.type === "image") lines.push(`[image: ${part.mimeType}]`);
	}
	return lines.join("\n");
}

function toolCallLines(details: EvalToolDetails | undefined): string[] {
	if (!details?.toolCalls || details.toolCalls.length === 0) return [];
	return details.toolCalls.map((call) => {
		const status = call.ok ? "ok" : "error";
		return `- tool.${call.name}: ${status}${call.error ? ` (${call.error})` : ""}`;
	});
}

export function renderEvalCall(args: EvalToolInput, _theme: unknown, context: RenderContext): Component {
	const component = componentFor(context);
	const title = args.title ? ` ${args.title}` : "";
	const reset = args.reset ? " reset" : "";
	const timeout = args.timeout ? ` timeout ${args.timeout}s` : "";
	component.setText(`eval ${args.language}${title}${reset}${timeout}\n${firstCodeLine(args.code)}`);
	return component;
}

export function renderEvalResult(
	result: AgentToolResult<EvalToolDetails>,
	options: ToolRenderResultOptions,
	_theme: unknown,
	context: Parameters<NonNullable<EvalToolDefinition["renderResult"]>>[3],
): Component {
	const component = componentFor(context);
	const details = result.details;
	const status = details?.isError ? "error" : options.isPartial ? "running" : "done";
	const title = details?.title ? ` ${details.title}` : "";
	const lines = [`eval ${details?.language ?? "?"}${title} ${status}`];
	const output = textOutput(result, context.showImages).trimEnd();
	if (output) lines.push("", output);
	const calls = toolCallLines(details);
	if (calls.length > 0) lines.push("", ...calls);
	if (details?.truncated) lines.push("", "[output truncated]");
	component.setText(lines.join("\n"));
	return component;
}
