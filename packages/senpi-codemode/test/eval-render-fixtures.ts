import type { AgentToolResult } from "@code-yeongyu/senpi";
import type { ImageProtocol } from "@earendil-works/pi-tui";
import type { EvalRenderComponent, renderEvalCall, renderEvalResult } from "../src/tool/render.ts";
import type { EvalToolDetails, EvalToolInput } from "../src/tool/types.ts";

type CallContext = Parameters<typeof renderEvalCall>[2];
type ResultContext = Parameters<typeof renderEvalResult>[3];
export type EvalComponent = EvalRenderComponent;

export interface RenderContextOptions {
	readonly lastComponent?: EvalComponent;
	readonly expanded?: boolean;
	readonly showImages?: boolean;
	readonly imageProtocol?: ImageProtocol;
	readonly isError?: boolean;
	readonly spinnerFrame?: number;
	readonly hasResult?: boolean;
	readonly args?: EvalToolInput;
}

function isEvalComponent(input: EvalComponent | RenderContextOptions): input is EvalComponent {
	return "render" in input;
}

function resolveContextOptions(
	input: EvalComponent | RenderContextOptions | undefined,
	showImages: boolean,
): RenderContextOptions {
	if (input === undefined) return { showImages };
	if (isEvalComponent(input)) return { lastComponent: input, showImages };
	return input;
}

export function callContext(lastComponent?: EvalComponent): CallContext;
export function callContext(options?: RenderContextOptions): CallContext;
export function callContext(input?: EvalComponent | RenderContextOptions): CallContext {
	const options = resolveContextOptions(input, false);
	return {
		args: options.args ?? { language: "js", code: "" },
		toolCallId: "eval-render-call",
		invalidate: () => {},
		lastComponent: options.lastComponent,
		state: {},
		cwd: "/tmp",
		executionStarted: false,
		argsComplete: true,
		isPartial: false,
		expanded: options.expanded ?? false,
		showImages: options.showImages ?? false,
		imageProtocol: options.imageProtocol ?? null,
		isError: options.isError ?? false,
		...(options.hasResult === undefined ? {} : { hasResult: options.hasResult }),
		...(options.spinnerFrame === undefined ? {} : { spinnerFrame: options.spinnerFrame }),
	};
}

export function resultContext(lastComponent: EvalComponent | undefined, showImages: boolean): ResultContext;
export function resultContext(options?: RenderContextOptions): ResultContext;
export function resultContext(input?: EvalComponent | RenderContextOptions, showImages = false): ResultContext {
	const options = resolveContextOptions(input, showImages);
	return {
		args: options.args ?? { language: "js", code: "" },
		toolCallId: "eval-render-result",
		invalidate: () => {},
		lastComponent: options.lastComponent,
		state: {},
		cwd: "/tmp",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: options.expanded ?? false,
		showImages: options.showImages ?? false,
		imageProtocol: options.imageProtocol ?? null,
		isError: options.isError ?? false,
		...(options.spinnerFrame === undefined ? {} : { spinnerFrame: options.spinnerFrame }),
	};
}

export function renderLines(component: EvalComponent): string[] {
	return component.render(80);
}

export function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/gu, "");
}

export function evalResult(details: EvalToolDetails, text: string): AgentToolResult<EvalToolDetails> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

export function evalResultWithOmittedDetails(text: string): AgentToolResult<EvalToolDetails> {
	const result = evalResult({ language: "js", durationMs: 0, toolCalls: [], truncated: false }, text);
	Reflect.deleteProperty(result, "details");
	return result;
}
