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
	/** Fixed render-time clock in epoch ms; keeps elapsed-time assertions off wall time. */
	readonly now?: number;
	readonly invalidate?: () => void;
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
		args: options.args ?? { language: "js", code: "", summary: "render fixture" },
		toolCallId: "eval-render-call",
		invalidate: options.invalidate ?? (() => {}),
		...(options.now === undefined ? {} : { now: options.now }),
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
		args: options.args ?? { language: "js", code: "", summary: "render fixture" },
		toolCallId: "eval-render-result",
		invalidate: options.invalidate ?? (() => {}),
		...(options.now === undefined ? {} : { now: options.now }),
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

const PLAIN_FG_COLORS = {
	accent: "#010101",
	border: "#020202",
	borderAccent: "#030303",
	borderMuted: "#040404",
	success: "#050505",
	error: "#060606",
	warning: "#070707",
	muted: "#080808",
	dim: "#090909",
	text: "#0a0a0a",
	thinkingText: "#0b0b0b",
	userMessageText: "#0c0c0c",
	customMessageText: "#0d0d0d",
	customMessageLabel: "#0e0e0e",
	toolTitle: "#0f0f0f",
	toolOutput: "#101010",
	mdHeading: "#111111",
	mdLink: "#121212",
	mdLinkUrl: "#131313",
	mdCode: "#141414",
	mdCodeBlock: "#151515",
	mdCodeBlockBorder: "#161616",
	mdQuote: "#171717",
	mdQuoteBorder: "#181818",
	mdHr: "#191919",
	mdListBullet: "#1a1a1a",
	toolDiffAdded: "#1b1b1b",
	toolDiffRemoved: "#1c1c1c",
	toolDiffContext: "#1d1d1d",
	syntaxComment: "#1e1e1e",
	syntaxKeyword: "#1f1f1f",
	syntaxFunction: "#202020",
	syntaxVariable: "#202020",
	syntaxString: "#222222",
	syntaxNumber: "#232323",
	syntaxType: "#242424",
	syntaxOperator: "#252525",
	syntaxPunctuation: "#262626",
	thinkingOff: "#272727",
	thinkingMinimal: "#282828",
	thinkingLow: "#292929",
	thinkingMedium: "#2a2a2a",
	thinkingHigh: "#292929",
	thinkingXhigh: "#2a2a2a",
	thinkingMax: "#2b2b2b",
	bashMode: "#2c2c2c",
};

const PLAIN_BG_COLORS = {
	selectedBg: "#303030",
	userMessageBg: "#313131",
	customMessageBg: "#323232",
	toolPendingBg: "#333333",
	toolSuccessBg: "#343434",
	toolErrorBg: "#353535",
};

import { Theme } from "@code-yeongyu/senpi";

/** A real `Theme` whose styling functions return the text unchanged: the render tests read layout, not color. */
export function plainTheme(): Theme {
	return new Theme(PLAIN_FG_COLORS, PLAIN_BG_COLORS, "truecolor", { name: "eval-render-plain-test" });
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
export function evalResultWithNestedToolCalls(
	toolCalls: EvalToolDetails["toolCalls"],
	text = "complete",
): AgentToolResult<EvalToolDetails> {
	return evalResult({ language: "js", durationMs: 0, toolCalls, truncated: false }, text);
}

/** Mirrors host-generated error results whose details payload is an empty object. */
export function evalResultWithEmptyDetails(text: string): AgentToolResult<EvalToolDetails> {
	const result = evalResult({ language: "js", durationMs: 0, toolCalls: [], truncated: false }, text);
	for (const key of Object.keys(result.details)) Reflect.deleteProperty(result.details, key);
	return result;
}
