import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { normalizeApplyPatchArguments } from "./params.ts";
import { renderPatchLine } from "./preview-format.ts";
import { StreamingPatchParser } from "./streaming-parser.ts";
import { extractPatchedPaths } from "./text.ts";
import type { ApplyPatchParams, ApplyPatchRenderState, ApplyPatchTheme, ParsedPatch } from "./types.ts";

// Tail-window the streaming body so a long patch never takes over the viewport: a sticky
// per-file header plus the last few lines of each file, with a "+N lines above" indicator.
const STREAMING_TAIL_LINES_PER_FILE = 12;

function hunkOperation(hunk: ParsedPatch): string {
	if (hunk.type === "add") return "Added";
	if (hunk.type === "delete") return "Deleted";
	return hunk.movePath ? "Moved" : "Edited";
}

function hunkPath(hunk: ParsedPatch): string {
	return hunk.type === "update" && hunk.movePath ? `${hunk.filePath} → ${hunk.movePath}` : hunk.filePath;
}

function hunkDiffLines(hunk: ParsedPatch): string[] {
	if (hunk.type === "delete") return [];
	if (hunk.type === "add")
		return hunk.content
			.split("\n")
			.filter(Boolean)
			.map((line) => `  + ${line}`);
	return hunk.chunks.flatMap((chunk) => [
		...chunk.changeContexts.map((context) => `  @@ ${context}`),
		...chunk.oldLines.map((line) => `  - ${line}`),
		...chunk.newLines.map((line) => `  + ${line}`),
	]);
}

function hunkChangeCounts(hunk: ParsedPatch): { added: number; removed: number } {
	if (hunk.type === "add") return { added: hunk.content.split("\n").filter(Boolean).length, removed: 0 };
	if (hunk.type === "delete") return { added: 0, removed: 0 };
	// addedCount/removedCount are tracked by prefix at parse time, so context lines are excluded
	// and a + line whose text equals a context line still counts as an addition (no set-membership
	// or positional undercount).
	let added = 0;
	let removed = 0;
	for (const chunk of hunk.chunks) {
		added += chunk.addedCount;
		removed += chunk.removedCount;
	}
	return { added, removed };
}

// One bounded block per file: sticky header with net counts, then the last N diff lines
// with a "+N lines above" marker when the file outgrew the window.
function formatStreamingHunks(hunks: readonly ParsedPatch[], partialLine: string): string {
	const blocks: string[] = [];
	for (const hunk of hunks) {
		const { added, removed } = hunkChangeCounts(hunk);
		const counts = added + removed > 0 ? ` (+${added} -${removed})` : "";
		const header = `• ${hunkOperation(hunk)} ${hunkPath(hunk)}${counts}`;
		const lines = hunkDiffLines(hunk);
		if (lines.length <= STREAMING_TAIL_LINES_PER_FILE) {
			blocks.push([header, ...lines].join("\n"));
			continue;
		}
		const hidden = lines.length - STREAMING_TAIL_LINES_PER_FILE;
		const tail = lines.slice(-STREAMING_TAIL_LINES_PER_FILE);
		blocks.push([header, `  … (+${hidden} lines above)`, ...tail].join("\n"));
	}
	// The in-flight, not-yet-newline-terminated line renders dimmed as the last row.
	const partial = partialLine.trim();
	if (partial.length > 0) blocks.push(`  ${partial}`);
	return blocks.join("\n");
}

function updateStreamingState(input: string, state: ApplyPatchRenderState): readonly ParsedPatch[] {
	if (!state.streamingParser || !input.startsWith(state.streamingInput ?? "")) {
		state.streamingParser = new StreamingPatchParser();
		state.streamingInput = "";
		state.streamingHunks = [];
		state.streamingError = undefined;
	}

	const previousInput = state.streamingInput ?? "";
	const delta = input.slice(previousInput.length);
	// A zero-length delta (same render pass re-run with no new text) must not re-parse or re-render.
	if (delta.length === 0) return state.streamingHunks ?? [];
	try {
		// Parse the delta, then render the parser's live hunk list rather than the deep clone
		// pushDelta returns; the per-delta structuredClone over every hunk is the O(n^2) cost.
		state.streamingParser.pushDelta(delta);
		state.streamingHunks = state.streamingParser.getLiveHunks?.() ?? state.streamingHunks;
		state.streamingInput = input;
		state.streamingError = undefined;
	} catch (error) {
		state.streamingError = error instanceof Error ? error.message : "Invalid patch stream";
	}
	return state.streamingHunks ?? [];
}

function renderBox(title: string, body: string, theme: ApplyPatchTheme, dimLastLine: boolean): Container {
	const component = new Container();
	const box = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
	box.addChild(new Text(theme.fg("toolTitle", theme.bold(title)), 0, 0));
	box.addChild(new Spacer(1));
	const lines = body.split("\n");
	box.addChild(
		new Text(
			lines
				.map((line, index) =>
					dimLastLine && index === lines.length - 1
						? theme.fg("toolDiffContext", line)
						: renderPatchLine(line, theme),
				)
				.join("\n"),
			0,
			0,
		),
	);
	component.addChild(box);
	return component;
}

// A no-change delta keeps the already-rendered body; the component renders it on demand so the
// box persists across a redraw without a rebuild.
class MemoizedStreamingBox extends Container {
	private built: Container | undefined;
	private readonly body: string;
	private readonly hasPartial: boolean;
	private readonly theme: ApplyPatchTheme;
	constructor(body: string, hasPartial: boolean, theme: ApplyPatchTheme) {
		super();
		this.body = body;
		this.hasPartial = hasPartial;
		this.theme = theme;
	}
	override render(width: number): string[] {
		this.built ??= renderBox("Applying patch", this.body, this.theme, this.hasPartial);
		return this.built.render(width);
	}
}

export function renderStreamingPatchCall(
	args: ApplyPatchParams,
	theme: ApplyPatchTheme,
	state: ApplyPatchRenderState,
): Container | undefined {
	const input = normalizeApplyPatchArguments(args).input;
	if (!input) return undefined;
	const hunks = updateStreamingState(input, state);
	if (state.streamingError) return renderBox("Invalid patch stream", state.streamingError, theme, false);
	if (hunks.length > 0) {
		const partialLine = state.streamingParser?.getPartialLine?.() ?? "";
		const body = formatStreamingHunks(hunks, partialLine);
		const hasPartial = partialLine.trim().length > 0;
		// A no-change delta keeps the already-rendered box instead of rebuilding it; the box must
		// still render (returning undefined here would blank the preview on any redraw).
		if (body === state.streamingLastRenderKey && state.streamingLastRenderKey !== undefined) {
			return new MemoizedStreamingBox(body, hasPartial, theme);
		}
		state.streamingLastRenderKey = body;
		return renderBox("Applying patch", body, theme, hasPartial);
	}
	const paths = extractPatchedPaths(input);
	if (paths.length === 0) return undefined;
	return renderBox("Applying patch", paths.map((filePath) => `• ${filePath}`).join("\n"), theme, false);
}
