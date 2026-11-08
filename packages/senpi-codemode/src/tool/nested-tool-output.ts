import type { AgentToolResult } from "@code-yeongyu/senpi";
import { DEFAULT_MAX_BYTES, truncateTailBytes } from "../output/streaming-output.ts";

/** Where a running cell receives the partial results of the tools it calls, so they stream live (#6167). */
export interface CellToolUpdateSink {
	nestedToolUpdate(callId: string, partial: AgentToolResult<unknown>): void;
	nestedToolSettled(callId: string): void;
}

/**
 * The latest partial output of each tool call a cell is still awaiting. It joins the cell's live view only: the
 * value the tool returns to the cell and the cell's own result never contain it.
 */
export class NestedToolOutput {
	readonly #byCall = new Map<string, string>();

	/** Keeps the call's newest partial; false when it adds no new text. */
	update(callId: string, partial: AgentToolResult<unknown>): boolean {
		const text = partial.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
		if (text.length === 0 || this.#byCall.get(callId) === text) return false;
		this.#byCall.set(callId, text);
		return true;
	}

	/** Forgets a settled call; false when it never showed output. */
	drop(callId: string): boolean {
		return this.#byCall.delete(callId);
	}

	clear(): void {
		this.#byCall.clear();
	}

	appendTo(output: string): string {
		let combined = output;
		for (const text of this.#byCall.values()) {
			const tail = truncateTailBytes(text, DEFAULT_MAX_BYTES).text;
			combined = combined.length === 0 || combined.endsWith("\n") ? `${combined}${tail}` : `${combined}\n${tail}`;
		}
		return combined;
	}

	/** Like `appendTo`, kept to the last `maxLines` lines; `output` is returned untouched while no call shows output. */
	appendLines(output: string, maxLines: number): string {
		if (this.#byCall.size === 0) return output;
		const combined = this.appendTo(output);
		const hasTrailingNewline = combined.endsWith("\n");
		const lines = combined.split("\n");
		if (hasTrailingNewline) lines.pop();
		return `${lines.slice(-maxLines).join("\n")}${hasTrailingNewline ? "\n" : ""}`;
	}
}
