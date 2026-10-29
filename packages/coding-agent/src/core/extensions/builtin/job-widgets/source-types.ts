/**
 * What a widget reads: text a job produces over time, and the lines the author saw.
 * Ported from oh-my-pi 9df0457b31 (MIT, Copyright Can Boluk et al.).
 */

/** Id of a task job's source carrying its subagent's finished tool calls. */
export const TOOLS_SOURCE_ID = "tools";

/**
 * What opens each tool call in the {@link TOOLS_SOURCE_ID} source (`» <tool> <intent>`, then the
 * result text): the engine's marker, not output the subagent produced, so no widget rule may read it.
 */
export const TOOL_CALL_MARK = "» ";

/** Retained text of a {@link JobTextSource} from some offset on. */
export interface JobTextChunk {
	/** Offset of `text`'s first unit; past the requested `from` when older text was dropped. */
	start: number;
	/** Offset just past `text`: the next read's `from`. */
	end: number;
	text: string;
	/** Whether more text may arrive. */
	open: boolean;
}

/**
 * Text a job produces over time, readable from any offset still retained. Offsets are opaque,
 * increasing numbers in the source's own unit; a reader only hands back an `end` it got.
 */
export interface JobTextSource {
	/** Stable id a widget rule names in `from`: `out`, `pipe:1`, `tools`. */
	readonly id: string;
	/** What the text is, for the widget author. */
	readonly label: string;
	read(from: number): JobTextChunk;
}

/** Lines the author saw for one source, for the validation dry run. */
export interface JobWidgetSampleLines {
	id: string;
	lines: readonly string[];
}
