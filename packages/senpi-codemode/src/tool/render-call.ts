import { sanitizeTerminalLabel, type Theme } from "@code-yeongyu/senpi";
import { displayCode } from "./display-code.ts";
import { normalizeEvalSummary } from "./eval-request.ts";
import { knownLanguage } from "./live-headline.ts";
import {
	type CallRenderContext,
	CODE_PREVIEW_LINES,
	componentFor,
	type EvalRenderComponent,
	isEvalRunInput,
	type RenderEnvironment,
	renderNow,
	renderPrefixed,
	spinner,
	style,
} from "./render-blocks.ts";
import { renderCell, summaryBlock } from "./render-cell.ts";
import { headlined, LIVE_LINE_PREFIX } from "./render-live.ts";
import type { EvalCellResult, EvalToolInput, EvalToolRequest } from "./types.ts";

// The call renderer reads the assistant message's raw arguments, which keep the provider's
// original summary (senpi#1472 detached preparation from the message), so it normalizes here,
// idempotently: an already-normalized value is returned unchanged.
function displaySummary(summary: string | undefined): string | undefined {
	return normalizeEvalSummary(summary);
}

function cellIdSuffix(cellId: unknown): string {
	return typeof cellId === "string" && cellId !== "" ? ` ${sanitizeTerminalLabel(cellId)}` : "";
}

export function renderEvalCall(
	args: EvalToolRequest | Partial<EvalToolInput>,
	theme: Theme | undefined,
	context: CallRenderContext,
): EvalRenderComponent {
	const component = componentFor(context);
	if (context.hasResult === true) {
		// The result renderer owns the full pending -> running -> done frame once a result exists.
		// Rendering the call frame too would stack a duplicate box, so yield to it here.
		component.syncLiveTicker(false, context.invalidate);
		component.setBlocks([]);
		return component;
	}
	if (!isEvalRunInput(args)) {
		// While a peek/stop call streams in, `cell_id` can still be missing; the title is the action alone until it arrives.
		const cellId = "cell_id" in args ? args.cell_id : undefined;
		const title = args.action === "list" ? "eval list" : `eval ${args.action}${cellIdSuffix(cellId)}`;
		component.syncLiveTicker(false, context.invalidate);
		component.setBlocks([{ kind: "text", text: style(theme, "toolTitle", title) }]);
		return component;
	}
	// While the model streams the call, `code` usually arrives before `language` and `summary`; a partial call still
	// renders (the host would otherwise fall back to a raw key=value row).
	const code = typeof args.code === "string" ? args.code : "";
	const language = knownLanguage(args.language);
	component.syncLiveTicker(theme !== undefined, context.invalidate);
	if (theme === undefined && context.spinnerFrame === undefined) {
		const reset = args.reset === true ? " reset" : "";
		const timeout = args.timeout === undefined ? "" : ` timeout ${args.timeout}s`;
		component.setBlocks([
			{
				kind: "text",
				text: style(theme, "toolTitle", `eval${language === undefined ? "" : ` ${language}`}${reset}${timeout}`),
			},
			...(displaySummary(args.summary) === undefined
				? []
				: [summaryBlock(displaySummary(args.summary) ?? "", theme, context.expanded)]),
			{
				kind: "text",
				text: style(
					theme,
					"mdCodeBlock",
					code.trim().length === 0
						? "..."
						: language === undefined
							? code
							: displayCode(code, language, context.argsComplete ? context.invalidate : undefined),
				),
				maxVisualLines: context.expanded ? undefined : CODE_PREVIEW_LINES,
				collapseKind: "code",
				theme,
			},
		]);
		return component;
	}
	component.setBlocks([
		{
			kind: "dynamic",
			render: (width) => {
				const environment: RenderEnvironment = {
					expanded: context.expanded,
					theme,
					spinnerFrame: context.spinnerFrame,
					width,
					meta: undefined,
					now: renderNow(context),
					...(context.argsComplete ? { repaint: context.invalidate } : {}),
				};
				const summary = displaySummary(args.summary);
				if (language === undefined) return streamingCallLines(summary, code, environment);
				// The host never supplies a spinner frame for an eval call, so the state comes from
				// the call lane itself: run args are present and no result exists yet (review MEDIUM-1).
				// The ticker (armed in renderEvalCall) repaints the block, so the spinner advances.
				const streaming = context.hasResult !== true;
				const cell: EvalCellResult = {
					index: 0,
					...(summary === undefined ? {} : { summary }),
					code,
					language,
					output: "",
					status: streaming ? "running" : "pending",
				};
				return renderCell(cell, environment, {
					reset: args.reset === true,
					timeout: args.timeout,
					throughput: undefined,
					streaming,
				});
			},
		},
	]);
	return component;
}

/** A call whose language has not streamed in yet: the headline row alone, until the full frame can render. */
function streamingCallLines(summary: string | undefined, code: string, environment: RenderEnvironment): string[] {
	const icon = environment.spinnerFrame === undefined ? "○" : spinner(environment.spinnerFrame);
	return renderPrefixed(headlined(icon, summary, code, "eval", environment), environment, LIVE_LINE_PREFIX);
}
