/**
 * Presentation for the write tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `write.ts` spreads these into its
 * definition, so the tool's public shape is unchanged.
 */

import { Container, Text } from "@earendil-works/pi-tui";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
import { renderToolDiff } from "../diff-render.ts";
import { normalizeDisplayText, renderToolPath, replaceTabs, str } from "../render-utils.ts";
import { formatWriteResult } from "../write-result.ts";

type WriteHighlightCache = {
	rawPath: string | null;
	lang: string;
	rawContent: string;
	normalizedLines: string[];
	highlightedLines: string[];
};
class WriteCallRenderComponent extends Text {
	cache?: WriteHighlightCache;

	constructor() {
		super("", 0, 0);
	}
}
const WRITE_PARTIAL_FULL_HIGHLIGHT_LINES = 50;
type WriteCallRenderOptions = ToolRenderResultOptions & {
	argsComplete: boolean;
};
function highlightSingleLine(line: string, lang: string): string {
	const highlighted = highlightCode(line, lang);
	return highlighted[0] ?? "";
}
function refreshWriteHighlightPrefix(cache: WriteHighlightCache): void {
	const prefixCount = Math.min(WRITE_PARTIAL_FULL_HIGHLIGHT_LINES, cache.normalizedLines.length);
	if (prefixCount === 0) return;
	const prefixSource = cache.normalizedLines.slice(0, prefixCount).join("\n");
	const prefixHighlighted = highlightCode(prefixSource, cache.lang);
	for (let i = 0; i < prefixCount; i++) {
		cache.highlightedLines[i] =
			prefixHighlighted[i] ?? highlightSingleLine(cache.normalizedLines[i] ?? "", cache.lang);
	}
}
function rebuildWriteHighlightCacheFull(rawPath: string | null, fileContent: string): WriteHighlightCache | undefined {
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	if (!lang) return undefined;
	const displayContent = normalizeDisplayText(fileContent);
	const normalized = replaceTabs(displayContent);
	return {
		rawPath,
		lang,
		rawContent: fileContent,
		normalizedLines: normalized.split("\n"),
		highlightedLines: highlightCode(normalized, lang),
	};
}
function updateWriteHighlightCacheIncremental(
	cache: WriteHighlightCache | undefined,
	rawPath: string | null,
	fileContent: string,
): WriteHighlightCache | undefined {
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	if (!lang) return undefined;
	if (!cache) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (cache.lang !== lang || cache.rawPath !== rawPath) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (!fileContent.startsWith(cache.rawContent)) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (fileContent.length === cache.rawContent.length) return cache;

	const deltaRaw = fileContent.slice(cache.rawContent.length);
	const deltaDisplay = normalizeDisplayText(deltaRaw);
	const deltaNormalized = replaceTabs(deltaDisplay);
	cache.rawContent = fileContent;
	if (cache.normalizedLines.length === 0) {
		cache.normalizedLines.push("");
		cache.highlightedLines.push("");
	}

	const segments = deltaNormalized.split("\n");
	const lastIndex = cache.normalizedLines.length - 1;
	cache.normalizedLines[lastIndex] += segments[0];
	cache.highlightedLines[lastIndex] = highlightSingleLine(cache.normalizedLines[lastIndex], cache.lang);
	for (let i = 1; i < segments.length; i++) {
		cache.normalizedLines.push(segments[i]);
		cache.highlightedLines.push(highlightSingleLine(segments[i], cache.lang));
	}
	refreshWriteHighlightPrefix(cache);
	return cache;
}
function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}
/** Unified `+`-prefixed preview of a whole-file write, used once the model finished streaming args. */
function generateAddedContentDiff(content: string, visibleLineCount: number): string {
	const visibleLines = trimTrailingEmptyLines(content.split("\n"));
	const lineNumWidth = String(Math.max(1, visibleLines.length)).length;
	const output: string[] = [];
	for (let index = 0; index < Math.min(visibleLineCount, visibleLines.length); index++) {
		output.push(`+${String(index + 1).padStart(lineNumWidth, " ")} ${visibleLines[index] ?? ""}`);
	}
	if (visibleLines.length > visibleLineCount) output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
	return output.join("\n");
}
function formatWriteCall(
	args: { path?: string; file_path?: string; content?: string } | undefined,
	options: WriteCallRenderOptions,
	theme: Theme,
	cache: WriteHighlightCache | undefined,
	cwd: string,
): string {
	const rawPath = str(args?.file_path ?? args?.path);
	const fileContent = str(args?.content);
	const pathDisplay = renderToolPath(rawPath, theme, cwd);
	let text = `${theme.fg("toolTitle", theme.bold("write"))} ${pathDisplay}`;

	if (fileContent === null) {
		text += `\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
	} else if (fileContent) {
		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		const normalizedContent = replaceTabs(normalizeDisplayText(fileContent));
		const lines = trimTrailingEmptyLines(normalizedContent.split("\n"));
		const totalLines = lines.length;
		const maxLines = options.expanded ? lines.length : 10;
		const remaining = lines.length - maxLines;
		if (options.argsComplete) {
			text += `\n\n${renderToolDiff(generateAddedContentDiff(normalizedContent, maxLines), {
				filePath: rawPath ?? undefined,
				theme,
			})}`;
		} else {
			const renderedLines = lang ? (cache?.highlightedLines ?? highlightCode(normalizedContent, lang)) : lines;
			text += `\n\n${renderedLines
				.slice(0, maxLines)
				.map((line) => (lang ? line : theme.fg("toolOutput", line)))
				.join("\n")}`;
		}
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	return text;
}

export const writeRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	renderCall(args, theme, context) {
		const renderArgs = args as { path?: string; file_path?: string; content?: string } | undefined;
		const rawPath = str(renderArgs?.file_path ?? renderArgs?.path);
		const fileContent = str(renderArgs?.content);
		const component =
			(context.lastComponent as WriteCallRenderComponent | undefined) ?? new WriteCallRenderComponent();
		if (fileContent !== null) {
			component.cache = context.argsComplete
				? rebuildWriteHighlightCacheFull(rawPath, fileContent)
				: updateWriteHighlightCacheIncremental(component.cache, rawPath, fileContent);
		} else {
			component.cache = undefined;
		}
		component.setText(
			formatWriteCall(
				renderArgs,
				{ argsComplete: context.argsComplete, expanded: context.expanded, isPartial: context.isPartial },
				theme,
				component.cache,
				context.cwd,
			),
		);
		return component;
	},
	renderResult(result, _options, theme, context) {
		const output = formatWriteResult({ ...result, isError: context.isError }, theme);
		if (!output) {
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.detachAll();
			return component;
		}
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(output);
		return text;
	},
};
